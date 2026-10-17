// Toast messages: a plain store (testable without a DOM) and a hook that renders from it.
import { useEffect, useMemo, useState } from 'preact/hooks';

export const TOAST_MS = 4000;

export interface ToastInput { kind: 'ok' | 'warning' | 'error' | 'info'; text: string; sticky?: boolean; action?: { label: string; run(): void } }
export interface ToastItem extends ToastInput { id: number }

export interface ToastTimers { setTimer(fn: () => void, ms: number): number; clearTimer(id: number): void }

export function createToastStore(timers: ToastTimers) {
  let items: ToastItem[] = [];
  let next = 1;
  const pending = new Map<number, number>();
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((l) => l());
  const dismiss = (id: number): void => {
    const timer = pending.get(id);
    if (timer !== undefined) { timers.clearTimer(timer); pending.delete(id); }
    items = items.filter((t) => t.id !== id);
    notify();
  };
  return {
    toasts: (): readonly ToastItem[] => items,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); },
    push(input: ToastInput): number {
      const id = next++;
      items = [...items, { ...input, id }];
      if (!input.sticky) pending.set(id, timers.setTimer(() => { pending.delete(id); dismiss(id); }, TOAST_MS));
      notify();
      return id;
    },
    dismiss,
  };
}

export type ToastStore = ReturnType<typeof createToastStore>;

const browserTimers: ToastTimers = {
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (id) => window.clearTimeout(id),
};

export function useToasts(): ToastStore & { items: readonly ToastItem[] } {
  const store = useMemo(() => createToastStore(browserTimers), []);
  const [items, setItems] = useState(store.toasts());
  useEffect(() => store.subscribe(() => setItems(store.toasts())), [store]);
  return { ...store, items };
}
