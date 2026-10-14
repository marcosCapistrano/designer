import { describe, expect, it, vi } from 'vitest';
import { SessionCheck } from './session-check.js';

function deferredApi() {
  const calls: Array<{ resolve: (ok: boolean) => void; reject: (e: unknown) => void }> = [];
  const api = {
    session: () => new Promise<boolean>((resolve, reject) => calls.push({ resolve, reject })),
  };
  return { api, calls };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('SessionCheck', () => {
  it('reports the answer', async () => {
    const { api, calls } = deferredApi();
    const onResult = vi.fn();
    new SessionCheck(api, { onResult, onError: vi.fn() }).run();
    calls[0]!.resolve(false);
    await tick();
    expect(onResult).toHaveBeenCalledWith(false);
  });

  it('reports a failure to ask', async () => {
    const { api, calls } = deferredApi();
    const onError = vi.fn();
    new SessionCheck(api, { onResult: vi.fn(), onError }).run();
    const err = new TypeError('Failed to fetch');
    calls[0]!.reject(err);
    await tick();
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('drops the answer to a check that was stopped', async () => {
    const { api, calls } = deferredApi();
    const handlers = { onResult: vi.fn(), onError: vi.fn() };
    const check = new SessionCheck(api, handlers);
    check.run();
    check.stop();
    calls[0]!.resolve(false);
    await tick();
    expect(handlers.onResult).not.toHaveBeenCalled();
  });

  it('drops a stopped check that failed too', async () => {
    const { api, calls } = deferredApi();
    const handlers = { onResult: vi.fn(), onError: vi.fn() };
    const check = new SessionCheck(api, handlers);
    check.run();
    check.stop();
    calls[0]!.reject(new Error('late'));
    await tick();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it('only the newest of two overlapping checks is heard', async () => {
    const { api, calls } = deferredApi();
    const onResult = vi.fn();
    const check = new SessionCheck(api, { onResult, onError: vi.fn() });
    check.run();
    check.run();
    calls[1]!.resolve(true);
    calls[0]!.resolve(false);
    await tick();
    expect(onResult.mock.calls).toEqual([[true]]);
  });

  it('can run again after stop', async () => {
    const { api, calls } = deferredApi();
    const onResult = vi.fn();
    const check = new SessionCheck(api, { onResult, onError: vi.fn() });
    check.run();
    check.stop();
    check.run();
    calls[1]!.resolve(true);
    await tick();
    expect(onResult).toHaveBeenCalledWith(true);
  });
});
