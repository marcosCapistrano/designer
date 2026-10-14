import type { AgentEvent, ClaudeRunner, RunOptions } from './runner.js';

export type FakeStep =
  | AgentEvent
  | ((opts: RunOptions) => void | AgentEvent | Promise<void | AgentEvent>);

const FAKE_SESSION = 'fake-session';

function abortedDone(): AgentEvent {
  return { type: 'done', sessionId: '', ok: false, error: 'aborted' };
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return typeof value === 'object' && value !== null && 'type' in value;
}

async function* play(script: readonly FakeStep[], opts: RunOptions): AsyncGenerator<AgentEvent> {
  for (const step of script) {
    if (opts.signal?.aborted) {
      yield abortedDone();
      return;
    }
    let event: AgentEvent | undefined;
    if (typeof step === 'function') {
      try {
        const result: unknown = await step(opts);
        event = isAgentEvent(result) ? result : undefined;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        yield { type: 'done', sessionId: FAKE_SESSION, ok: false, error };
        return;
      }
    } else {
      event = step;
    }
    if (event !== undefined) {
      yield event;
      if (event.type === 'done') return;
    }
  }
  if (opts.signal?.aborted) {
    yield abortedDone();
    return;
  }
  yield { type: 'done', sessionId: FAKE_SESSION, ok: true };
}

/** Plays scripted steps. Call i plays scripts[min(i, scripts.length - 1)]. */
export class FakeClaudeRunner implements ClaudeRunner {
  readonly calls: RunOptions[] = [];
  private readonly scripts: FakeStep[][];

  constructor(scripts: FakeStep[][]) {
    this.scripts = scripts;
  }

  run(opts: RunOptions): AsyncIterable<AgentEvent> {
    const index = this.calls.length;
    this.calls.push(opts);
    const script = this.scripts[Math.min(index, this.scripts.length - 1)] ?? [];
    return play(script, opts);
  }
}
