// Text fields commit on Enter or blur, never per keystroke, so each committed change is one design edit.
// A blank field commits null (remove the value); an unchanged value commits nothing.

type InputEvent = { currentTarget: { value: string }; key?: string; preventDefault(): void };

/** The value each field last committed, so Enter followed by blur (tapping elsewhere) commits once, not twice. */
const committed = new WeakMap<object, string>();

export function commitHandlers(current: string, onCommit: (value: string | null) => void) {
  const commit = (field: { value: string }): void => {
    const next = field.value.trim();
    if (next === current.trim() || committed.get(field) === next) return;
    committed.set(field, next);
    onCommit(next === '' ? null : next);
  };
  return {
    onKeyDown: (event: Event): void => {
      const e = event as unknown as InputEvent;
      if (e.key !== 'Enter') return;
      e.preventDefault();
      commit(e.currentTarget);
    },
    onBlur: (event: Event): void => commit((event as unknown as InputEvent).currentTarget),
  };
}
