import {
  query,
  type HookCallback,
  type HookInput,
  type HookJSONOutput,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { scrubEnv } from '../config.js';
import { checkToolUse, DEPLOY_DENY_RULES } from './guard.js';
import { type AgentEvent, type ClaudeRunner, type RunOptions, usageLimitError } from './runner.js';

export const AUTH_FAILED_MESSAGE =
  'Claude Code is not logged in on the hub. Run `claude setup-token` and store the token with ops/hub/set-secret.sh CLAUDE_CODE_OAUTH_TOKEN (docs/hub-bootstrap.md).';

const AUTH_ERRORS: ReadonlySet<string> = new Set(['authentication_failed', 'oauth_org_not_allowed']);

export interface RunnerContext {
  env: Record<string, string | undefined>;
  oauthToken: string | null;
}

/** Denies a tool call when checkToolUse finds a reason. Runs on every PreToolUse. */
export function guardHook(cwd: string): HookCallback {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const reason = checkToolUse(cwd, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
    if (reason === null) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  };
}

export function buildQueryOptions(opts: RunOptions, ctx: RunnerContext): Options {
  return {
    cwd: opts.cwd,
    ...(opts.resume ? { resume: opts.resume } : {}),
    permissionMode: 'bypassPermissions', // full permissions inside the repo...
    allowDangerouslySkipPermissions: true,
    disallowedTools: [...DEPLOY_DENY_RULES], // ...but deploys are denied, even in bypass mode
    hooks: { PreToolUse: [{ hooks: [guardHook(opts.cwd)] }] }, // no matcher: every tool call
    canUseTool: async (toolName) => ({
      behavior: 'deny',
      message: `${toolName} needs a person's approval and the Hub cannot ask. Ask in your reply instead.`,
    }),
    allowedTools: opts.allowedTools ?? [],
    mcpServers: (opts.mcpServers ?? {}) as Options['mcpServers'],
    settingSources: ['project'], // the app's CLAUDE.md and .claude/settings.json
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      ...(opts.systemPrompt ? { append: opts.systemPrompt } : {}),
    },
    env: { ...scrubEnv(ctx.env), ...(ctx.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: ctx.oauthToken } : {}) },
  };
}

export interface MapState {
  sessionId: string | null;
  resultOk: boolean | null;
  resultError: string | null;
  apiError: string | null;
  limited: boolean;
  resetsAtMs: number | null;
}

export function newMapState(): MapState {
  return {
    sessionId: null,
    resultOk: null,
    resultError: null,
    apiError: null,
    limited: false,
    resetsAtMs: null,
  };
}

/** The fields of SDK messages that mapMessage reads. */
interface WireBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface WireMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  parent_tool_use_id?: string | null;
  error?: string;
  message?: { content?: WireBlock[] };
  rate_limit_info?: { status?: string; resetsAt?: unknown };
}

function mapAssistant(wire: WireMessage, state: MapState): AgentEvent[] {
  if (wire.parent_tool_use_id !== null) return []; // subagent internals stay hidden
  if (wire.error) {
    state.apiError = wire.error;
    if (wire.error === 'rate_limit') state.limited = true;
  }
  const events: AgentEvent[] = [];
  for (const block of wire.message?.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      events.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      events.push({ type: 'tool', name: block.name ?? '', input: block.input });
    }
  }
  return events;
}

/** Turns one SDK message into UI events and records what finalEvent needs. */
export function mapMessage(msg: SDKMessage, state: MapState): AgentEvent[] {
  const wire = msg as unknown as WireMessage;
  switch (wire.type) {
    case 'system':
      if (wire.subtype === 'init' && typeof wire.session_id === 'string') state.sessionId = wire.session_id;
      return [];
    case 'assistant':
      return mapAssistant(wire, state);
    case 'rate_limit_event': {
      const info = wire.rate_limit_info;
      if (info?.status === 'rejected') {
        state.limited = true;
        if (typeof info.resetsAt === 'number') {
          state.resetsAtMs = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
        }
      }
      return [];
    }
    case 'result':
      if (typeof wire.session_id === 'string') state.sessionId = wire.session_id;
      state.resultOk = wire.subtype === 'success' && !wire.is_error;
      if (!state.resultOk) {
        const reason = wire.subtype === 'success' ? wire.result || 'Claude reported an error' : wire.subtype;
        if (reason) state.resultError = reason;
      }
      return [];
    default:
      return [];
  }
}

/** The one 'done' event that ends a run. */
export function finalEvent(
  state: MapState,
  opts: { resume?: string; aborted: boolean; thrown: unknown },
): AgentEvent {
  const sessionId = state.sessionId ?? opts.resume ?? '';
  if (state.limited) {
    return { type: 'done', sessionId, ok: false, error: usageLimitError(state.resetsAtMs) };
  }
  if (opts.aborted) return { type: 'done', sessionId, ok: false, error: 'aborted' };
  if (state.apiError !== null && AUTH_ERRORS.has(state.apiError)) {
    return { type: 'done', sessionId, ok: false, error: AUTH_FAILED_MESSAGE };
  }
  if (state.resultOk === true) return { type: 'done', sessionId, ok: true };
  const thrownMessage = opts.thrown instanceof Error ? opts.thrown.message : 'Claude Code ended without a result';
  return { type: 'done', sessionId, ok: false, error: state.resultError ?? state.apiError ?? thrownMessage };
}

export class SdkClaudeRunner implements ClaudeRunner {
  private readonly ctx: RunnerContext;
  private readonly queryFn: typeof query;

  constructor(
    opts: { oauthToken?: string | null; env?: Record<string, string | undefined>; queryFn?: typeof query } = {},
  ) {
    this.ctx = { env: opts.env ?? process.env, oauthToken: opts.oauthToken ?? null };
    this.queryFn = opts.queryFn ?? query;
  }

  async *run(opts: RunOptions): AsyncIterable<AgentEvent> {
    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    if (opts.signal?.aborted) ac.abort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    const state = newMapState();
    let thrown: unknown;
    try {
      const stream = this.queryFn({
        prompt: opts.prompt,
        options: { ...buildQueryOptions(opts, this.ctx), abortController: ac },
      });
      for await (const msg of stream) {
        for (const event of mapMessage(msg, state)) yield event;
      }
    } catch (err) {
      thrown = err; // the SDK throws after an error result
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
    yield finalEvent(state, { resume: opts.resume, aborted: ac.signal.aborted, thrown });
  }
}
