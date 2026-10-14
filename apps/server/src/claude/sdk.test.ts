import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanUseTool, HookInput, Options, SDKMessage, query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, test } from 'vitest';
import { SECRET_ENV_KEYS } from '../config.js';
import type { AgentEvent, RunOptions } from './runner.js';
import {
  AUTH_FAILED_MESSAGE,
  buildQueryOptions,
  finalEvent,
  guardHook,
  mapMessage,
  newMapState,
  SdkClaudeRunner,
} from './sdk.js';

const ENV = { PATH: '/bin', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 'g' };

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function built(extra: Partial<RunOptions> = {}): Options {
  return buildQueryOptions({ cwd: '/repo', prompt: 'x', ...extra }, { env: ENV, oauthToken: 'o' });
}

function preToolUse(toolName: string, toolInput: Record<string, unknown>): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tu1',
    session_id: 's',
    transcript_path: '',
    cwd: '/repo',
  } as unknown as HookInput;
}

function runHook(o: Options, input: HookInput) {
  const hook = o.hooks?.PreToolUse?.[0]?.hooks[0];
  if (hook === undefined) throw new Error('no PreToolUse hook');
  return hook(input, 'tu1', { signal: new AbortController().signal });
}

function message(value: Record<string, unknown>): SDKMessage {
  return value as unknown as SDKMessage;
}

function fakeQuery(body: (signal: AbortSignal) => AsyncIterable<SDKMessage>): typeof query {
  return ((params: { options?: Options }) =>
    body(params.options?.abortController?.signal ?? new AbortController().signal)) as unknown as typeof query;
}

describe('buildQueryOptions', () => {
  it('options give full repo permissions but deny deploys', () => {
    const o = buildQueryOptions(
      { cwd: '/repo', prompt: 'x', resume: 's1', systemPrompt: 'extra' },
      { env: ENV, oauthToken: 'o' },
    );
    expect(o.cwd).toBe('/repo');
    expect(o.resume).toBe('s1');
    expect(o.permissionMode).toBe('bypassPermissions');
    expect(o.allowDangerouslySkipPermissions).toBe(true);
    expect(o.disallowedTools).toContain('Bash(git push *)');
    expect(o.settingSources).toEqual(['project']);
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'extra' });
    expect(o.env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'o' });
  });

  it('no resume key when not resuming', () => {
    const o = built();
    expect('resume' in o).toBe(false);
    expect('abortController' in o).toBe(false);
  });

  it('PreToolUse hook denies a composed push', async () => {
    const o = built();
    const denied = await runHook(o, preToolUse('Bash', { command: 'cd web && git push' }));
    expect(denied).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
    expect(await runHook(o, preToolUse('Bash', { command: 'pnpm test' }))).toEqual({});
  });

  it('canUseTool denies and says why', async () => {
    const o = built();
    const canUseTool = o.canUseTool as CanUseTool;
    const result = await canUseTool('AskUserQuestion', {}, {
      signal: new AbortController().signal,
    } as Parameters<CanUseTool>[2]);
    expect(result?.behavior).toBe('deny');
    expect(result).toMatchObject({ message: expect.stringContaining('AskUserQuestion') });
  });
});

describe('mapMessage and finalEvent', () => {
  it('maps text and tool blocks', () => {
    const events = mapMessage(
      message({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'text', text: 'Hi' },
            { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
      newMapState(),
    );
    expect(events).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'tool', name: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('hides subagent messages', () => {
    const events = mapMessage(
      message({
        type: 'assistant',
        parent_tool_use_id: 'x',
        message: { content: [{ type: 'text', text: 'inner' }] },
      }),
      newMapState(),
    );
    expect(events).toEqual([]);
  });

  it('success result ends ok', () => {
    const state = newMapState();
    expect(mapMessage(message({ type: 'system', subtype: 'init', session_id: 'abc' }), state)).toEqual([]);
    const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'abc' };
    expect(mapMessage(message(result), state)).toEqual([]);
    expect(finalEvent(state, { aborted: false, thrown: undefined })).toEqual({
      type: 'done',
      sessionId: 'abc',
      ok: true,
    });
  });

  it('error result carries the subtype', () => {
    const state = newMapState();
    mapMessage(message({ type: 'system', subtype: 'init', session_id: 'abc' }), state);
    mapMessage(message({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 'abc' }), state);
    expect(finalEvent(state, { aborted: false, thrown: undefined })).toEqual({
      type: 'done',
      sessionId: 'abc',
      ok: false,
      error: 'error_max_turns',
    });
  });

  it('rejected rate limit becomes usage_limit', () => {
    const state = newMapState();
    expect(
      mapMessage(
        message({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1760000000 } }),
        state,
      ),
    ).toEqual([]);
    expect(finalEvent(state, { aborted: false, thrown: undefined })).toMatchObject({
      ok: false,
      error: 'usage_limit:1760000000000',
    });
  });

  it('assistant rate_limit error becomes usage_limit', () => {
    const state = newMapState();
    mapMessage(message({ type: 'assistant', parent_tool_use_id: null, error: 'rate_limit' }), state);
    expect(finalEvent(state, { aborted: false, thrown: undefined })).toMatchObject({
      ok: false,
      error: 'usage_limit',
    });
  });

  it('authentication failure explains the fix', () => {
    const state = newMapState();
    mapMessage(message({ type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed' }), state);
    expect(finalEvent(state, { aborted: false, thrown: undefined })).toMatchObject({
      ok: false,
      error: AUTH_FAILED_MESSAGE,
    });
  });
});

describe('runner hardening (final wave B)', () => {
  it('guardHook denies when the check itself throws', async () => {
    const hook = guardHook('/repo', () => {
      throw new Error('boom');
    });
    const out = await hook(preToolUse('Bash', { command: 'ls' }), 'tu1', { signal: new AbortController().signal });
    expect(out).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('could not check'),
      },
    });
  });

  it('the hook denies a push sent through Monitor', async () => {
    const denied = await runHook(built(), preToolUse('Monitor', { command: 'git push origin HEAD:main' }));
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('env drops every SECRET_ENV_KEYS entry and carries only the hub token', () => {
    const env: Record<string, string> = { PATH: '/bin', HOME: '/home/hub' };
    for (const key of SECRET_ENV_KEYS) env[key] = `leaked-${key}`;
    const o = buildQueryOptions({ cwd: '/repo', prompt: 'x' }, { env, oauthToken: 'hub-token' });
    expect(o.env).toEqual({ PATH: '/bin', HOME: '/home/hub', CLAUDE_CODE_OAUTH_TOKEN: 'hub-token' });
    expect(Object.values(o.env ?? {}).some((v) => String(v).startsWith('leaked-'))).toBe(false);
  });

  it('a null oauthToken leaves no token in the env, even one inherited from the hub', () => {
    const env = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'inherited' };
    const o = buildQueryOptions({ cwd: '/repo', prompt: 'x' }, { env, oauthToken: null });
    expect(o.env).toEqual({ PATH: '/bin' });
  });

  it('one PreToolUse hook with no matcher, so every tool call is checked', () => {
    const o = built();
    expect(Object.keys(o.hooks ?? {})).toEqual(['PreToolUse']);
    expect(o.hooks?.PreToolUse).toHaveLength(1);
    expect(o.hooks?.PreToolUse?.[0]?.matcher).toBeUndefined();
    expect(o.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
  });

  it('queryFn gets the prompt, the built options and the abort controller', async () => {
    const calls: Array<{ prompt: unknown; options?: Options }> = [];
    const runner = new SdkClaudeRunner({
      env: ENV,
      oauthToken: 'o',
      queryFn: ((params: { prompt: unknown; options?: Options }) => {
        calls.push(params);
        return (async function* () {
          yield message({ type: 'result', subtype: 'success', is_error: false, session_id: 's9', result: '' });
        })();
      }) as unknown as typeof query,
    });
    await collect(runner.run({ cwd: '/repo', prompt: 'do it', resume: 's1', allowedTools: ['mcp__x__y'] }));
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.prompt).toBe('do it');
    expect(call?.options?.cwd).toBe('/repo');
    expect(call?.options?.resume).toBe('s1');
    expect(call?.options?.allowedTools).toEqual(['mcp__x__y']);
    expect(call?.options?.abortController).toBeInstanceOf(AbortController);
    expect(call?.options?.env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'o' });
  });

  it('a signal aborted before run starts never starts a query', async () => {
    let started = false;
    const runner = new SdkClaudeRunner({
      env: ENV,
      oauthToken: 'o',
      queryFn: (() => {
        started = true;
        return (async function* () {})();
      }) as unknown as typeof query,
    });
    const controller = new AbortController();
    controller.abort();
    const events = await collect(runner.run({ cwd: '/repo', prompt: 'x', resume: 's1', signal: controller.signal }));
    expect(started).toBe(false);
    expect(events).toEqual([{ type: 'done', sessionId: 's1', ok: false, error: 'aborted' }]);
  });

  it('drops the SDK canUseTool-shadowed warning and keeps every other warning', async () => {
    new SdkClaudeRunner({ env: ENV });
    const seen: string[] = [];
    const onWarning = (warning: Error & { code?: string }): void => {
      seen.push(warning.code ?? warning.message);
    };
    process.on('warning', onWarning);
    try {
      process.emitWarning('canUseTool will not be invoked', { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' });
      process.emitWarning('canUseTool will not be invoked', 'Warning', 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED');
      process.emitWarning('a different warning', { code: 'HUB_TEST_OTHER_WARNING' });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }
    expect(seen).toEqual(['HUB_TEST_OTHER_WARNING']);
  });
});

describe('SdkClaudeRunner', () => {
  it('run yields done after the query throws', async () => {
    const runner = new SdkClaudeRunner({
      env: ENV,
      oauthToken: 'o',
      queryFn: fakeQuery(async function* () {
        yield message({ type: 'system', subtype: 'init', session_id: 'abc' });
        throw new Error('process exited');
      }),
    });
    const events = await collect(runner.run({ cwd: '/repo', prompt: 'x' }));
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'abc', ok: false, error: 'process exited' });
  });

  it('run aborts', async () => {
    const runner = new SdkClaudeRunner({
      env: ENV,
      oauthToken: 'o',
      queryFn: fakeQuery(async function* (signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('query aborted');
      }),
    });
    const controller = new AbortController();
    const pending = collect(runner.run({ cwd: '/repo', prompt: 'x', signal: controller.signal }));
    controller.abort();
    expect(await pending).toEqual([{ type: 'done', sessionId: '', ok: false, error: 'aborted' }]);
  });

  test.skipIf(!process.env.HUB_LIVE_CLAUDE)(
    'live: answers with the subscription login',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hub-sdk-live-'));
      try {
        const runner = new SdkClaudeRunner({ oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null });
        const events = await collect(
          runner.run({ cwd: dir, prompt: 'Reply with the single word OK and do nothing else.' }),
        );
        expect(events.some((event) => event.type === 'text' && event.text.includes('OK'))).toBe(true);
        expect(events.at(-1)).toMatchObject({ type: 'done', ok: true });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
