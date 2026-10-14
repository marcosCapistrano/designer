import { describe, expect, it } from 'vitest';
import { FakeClaudeRunner } from './fake.js';
import type { AgentEvent, RunOptions } from './runner.js';
import { parseUsageLimit, usageLimitError } from './runner.js';

const DONE_OK: AgentEvent = { type: 'done', sessionId: 'fake-session', ok: true };

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function options(extra: Partial<RunOptions> = {}): RunOptions {
  return { cwd: '/work', prompt: 'do it', ...extra };
}

describe('FakeClaudeRunner', () => {
  it('plays scripted events and appends done', async () => {
    const runner = new FakeClaudeRunner([[{ type: 'text', text: 'a' }]]);
    expect(await collect(runner.run(options()))).toEqual([{ type: 'text', text: 'a' }, DONE_OK]);
  });

  it('functions run in order and may yield events', async () => {
    const runner = new FakeClaudeRunner([[(o) => ({ type: 'text', text: o.cwd })]]);
    expect(await collect(runner.run(options()))).toEqual([{ type: 'text', text: '/work' }, DONE_OK]);
  });

  it('later calls use later scripts, then repeat the last', async () => {
    const runner = new FakeClaudeRunner([
      [{ type: 'text', text: 'one' }],
      [{ type: 'text', text: 'two' }],
    ]);
    await collect(runner.run(options()));
    await collect(runner.run(options()));
    const third = await collect(runner.run(options()));
    expect(third[0]).toEqual({ type: 'text', text: 'two' });
    expect(runner.calls.length).toBe(3);
  });

  it('abort stops with an aborted done', async () => {
    const runner = new FakeClaudeRunner([[{ type: 'text', text: 'a' }]]);
    const controller = new AbortController();
    controller.abort();
    expect(await collect(runner.run(options({ signal: controller.signal })))).toEqual([
      { type: 'done', sessionId: '', ok: false, error: 'aborted' },
    ]);
  });

  it('abort during a step stops before the next step', async () => {
    const controller = new AbortController();
    const runner = new FakeClaudeRunner([
      [
        () => {
          controller.abort();
        },
        { type: 'text', text: 'never' },
      ],
    ]);
    expect(await collect(runner.run(options({ signal: controller.signal })))).toEqual([
      { type: 'done', sessionId: '', ok: false, error: 'aborted' },
    ]);
  });

  it('abort during the last step still ends aborted', async () => {
    const controller = new AbortController();
    const runner = new FakeClaudeRunner([
      [
        () => {
          controller.abort();
        },
      ],
    ]);
    expect(await collect(runner.run(options({ signal: controller.signal })))).toEqual([
      { type: 'done', sessionId: '', ok: false, error: 'aborted' },
    ]);
  });

  it('an explicit done ends the script with exactly one done', async () => {
    const failed: AgentEvent = { type: 'done', sessionId: 's1', ok: false, error: 'x' };
    const runner = new FakeClaudeRunner([[{ type: 'text', text: 'a' }, failed, { type: 'text', text: 'b' }]]);
    expect(await collect(runner.run(options()))).toEqual([{ type: 'text', text: 'a' }, failed]);
  });

  it('a throwing function step ends with a failed done', async () => {
    const runner = new FakeClaudeRunner([
      [
        () => {
          throw new Error('boom');
        },
      ],
    ]);
    expect(await collect(runner.run(options()))).toEqual([
      { type: 'done', sessionId: 'fake-session', ok: false, error: 'boom' },
    ]);
  });

  it('usage limit helpers round-trip', () => {
    expect(usageLimitError(123)).toBe('usage_limit:123');
    expect(parseUsageLimit('usage_limit:123')).toEqual({ resetsAtMs: 123 });
    expect(usageLimitError(null)).toBe('usage_limit');
    expect(parseUsageLimit('usage_limit')).toEqual({ resetsAtMs: null });
    expect(parseUsageLimit('boom')).toBeNull();
    expect(parseUsageLimit(undefined)).toBeNull();
  });
});
