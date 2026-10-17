import { describe, expect, it, vi } from 'vitest';
import { createValueStore } from './value-store.js';

describe('value store', () => {
  it('holds a value and notifies only on a change', () => {
    const store = createValueStore(100);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.set(100);
    expect(listener).not.toHaveBeenCalled();
    store.set(37);
    expect(store.get()).toBe(37);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    store.set(50);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
