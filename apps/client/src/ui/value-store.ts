// A value that changes often (the camera zoom) and is shown in one small place: only that place subscribes, so a
// change never re-renders the screen around it.
import { useEffect, useState } from 'preact/hooks';

export interface ValueStore<T> { get(): T; set(value: T): void; subscribe(listener: () => void): () => void }

export function createValueStore<T>(initial: T): ValueStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T): void { if (Object.is(next, value)) return; value = next; listeners.forEach((l) => l()); },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export function useValue<T>(store: ValueStore<T>): T {
  const [value, setValue] = useState(store.get());
  useEffect(() => { setValue(store.get()); return store.subscribe(() => setValue(store.get())); }, [store]);
  return value;
}
