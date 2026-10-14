import type { BuildTask } from '@hub/protocol';
import { type AgentEvent, parseUsageLimit } from '../claude/runner.js';
import { addBuildMessage, type BuildDeps, publishTask } from './deps.js';
import { buildSystemPrompt, summarizeTool } from './naming.js';

export interface TurnInput {
  app: string;
  taskId: number;
  cwd: string;
  branch: string;
  prompt: string;
  signal: AbortSignal;
}

export interface TurnResult {
  ok: boolean;
  error: string | null;
  limited: boolean;
  resetsAtMs: number | null;
}

/** Retry delay after a usage limit whose reset time is unknown. */
export const USAGE_RETRY_FALLBACK_MS = 900_000;

type Outcome = Pick<Extract<AgentEvent, { type: 'done' }>, 'sessionId' | 'ok' | 'error'>;

interface Attempt {
  outcome: Outcome;
  /** Text and tool events streamed to the Build feed. */
  events: number;
}

const NO_RESULT: Outcome = { sessionId: '', ok: false, error: 'Claude Code ended without a result' };

/** Plays one Claude run, streaming text and tool events into the Build feed. */
async function play(deps: BuildDeps, input: TurnInput, resume: string | undefined): Promise<Attempt> {
  let events = 0;
  let outcome: Outcome | null = null;
  const stream = deps.runner.run({
    cwd: input.cwd,
    prompt: input.prompt,
    resume,
    systemPrompt: buildSystemPrompt(input.branch),
    signal: input.signal,
  });
  for await (const event of stream) {
    if (event.type === 'text') {
      events += 1;
      addBuildMessage(deps, input.app, input.taskId, 'assistant', event.text);
    } else if (event.type === 'tool') {
      events += 1;
      addBuildMessage(deps, input.app, input.taskId, 'tool', summarizeTool(event.name, event.input, input.cwd));
    } else {
      outcome = event;
    }
  }
  return { outcome: outcome ?? NO_RESULT, events };
}

/** A failed resume that did no work and was not a usage limit or an abort is retried once as a fresh session. */
function canRetryFresh(attempt: Attempt, resume: string | undefined): boolean {
  const { outcome, events } = attempt;
  return (
    !outcome.ok &&
    resume !== undefined &&
    events === 0 &&
    parseUsageLimit(outcome.error) === null &&
    outcome.error !== 'aborted'
  );
}

/** Runs one Claude turn for a Build task, resuming the app's chat session when there is one. */
export async function runTurn(deps: BuildDeps, input: TurnInput): Promise<TurnResult> {
  const { app, taskId } = input;
  const resume = deps.store.chatSession(app) ?? undefined;
  let attempt = await play(deps, input, resume);
  if (canRetryFresh(attempt, resume)) {
    deps.store.setChatSession(app, null);
    addBuildMessage(
      deps,
      app,
      taskId,
      'status',
      'Could not resume the previous Claude session; starting a new one.',
    );
    attempt = await play(deps, input, undefined);
  }

  const done = attempt.outcome;
  if (done.sessionId !== '') deps.store.setChatSession(app, done.sessionId);

  const limit = parseUsageLimit(done.error);
  if (limit !== null) {
    return { ok: false, error: done.error ?? null, limited: true, resetsAtMs: limit.resetsAtMs };
  }
  if (done.ok) return { ok: true, error: null, limited: false, resetsAtMs: null };
  return { ok: false, error: done.error ?? 'Claude Code failed', limited: false, resetsAtMs: null };
}

/** Puts a task on hold until the usage limit resets, keeping its prompt for the retry. */
export function queueAfterLimit(deps: BuildDeps, task: BuildTask, prompt: string, result: TurnResult): BuildTask {
  const retryAt = result.resetsAtMs ?? deps.now() + USAGE_RETRY_FALLBACK_MS;
  const queued = deps.store.updateTask(task.id, { status: 'queued', retryAt, pendingPrompt: prompt, error: null });
  addBuildMessage(
    deps,
    task.app,
    task.id,
    'status',
    `Claude usage limit reached. The Hub will retry at ${new Date(retryAt).toISOString().slice(11, 16)} UTC.`,
  );
  publishTask(deps, queued, false);
  return queued;
}
