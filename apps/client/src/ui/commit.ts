// Text fields commit on Enter or blur, never per keystroke, so each committed change is one design edit.
// A blank field commits null (remove the value); an unchanged value commits nothing.

type InputEvent = { currentTarget: { value: string }; key?: string; preventDefault(): void };

export function commitHandlers(current: string, onCommit: (value: string | null) => void) {
  const commit = (raw: string): void => {
    const next = raw.trim();
    if (next === current.trim()) return;
    onCommit(next === '' ? null : next);
  };
  return {
    onKeyDown: (event: Event): void => {
      const e = event as unknown as InputEvent;
      if (e.key !== 'Enter') return;
      e.preventDefault();
      commit(e.currentTarget.value);
    },
    onBlur: (event: Event): void => commit((event as unknown as InputEvent).currentTarget.value),
  };
}
