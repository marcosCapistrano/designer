import { describe, expect, it, vi } from 'vitest';
import { Segmented } from './Segmented.js';
import { Toggle } from './Toggle.js';
import { IconButton } from './IconButton.js';
import { Button } from './Button.js';
import { createToastStore } from './toasts.js';
import { byTestId, elements, props, text } from './test-vnode.js';

describe('Segmented', () => {
  const options = [
    { value: 'base', label: 'Desktop' },
    { value: 'tablet', label: 'Tablet' },
  ] as const;
  it('is a radiogroup with the current option checked', () => {
    const els = elements(Segmented({ value: 'tablet', options: [...options], onChange: () => {}, label: 'Device', 'data-testid': 'd' }));
    expect(props(byTestId(els, 'd')).role).toBe('radiogroup');
    expect(props(byTestId(els, 'd-base'))['aria-checked']).toBe('false');
    expect(props(byTestId(els, 'd-tablet'))['aria-checked']).toBe('true');
    expect(props(byTestId(els, 'd-base')).role).toBe('radio');
  });
  it('reports the tapped option', () => {
    const onChange = vi.fn();
    const els = elements(Segmented({ value: 'tablet', options: [...options], onChange, label: 'Device', 'data-testid': 'd' }));
    (props(byTestId(els, 'd-base')).onClick as () => void)();
    expect(onChange).toHaveBeenCalledWith('base');
  });
});

describe('Toggle', () => {
  it('is a switch reporting the opposite state', () => {
    const onChange = vi.fn();
    const els = elements(Toggle({ checked: true, onChange, label: 'Visible', 'data-testid': 't' }));
    expect(props(byTestId(els, 't')).role).toBe('switch');
    expect(props(byTestId(els, 't'))['aria-checked']).toBe('true');
    (props(byTestId(els, 't')).onClick as () => void)();
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe('IconButton and Button', () => {
  it('labels an icon button and exposes pressed state', () => {
    const els = elements(IconButton({ label: 'Select', icon: 'S', onClick: () => {}, pressed: true, 'data-testid': 'i' }));
    expect(props(byTestId(els, 'i'))['aria-label']).toBe('Select');
    expect(props(byTestId(els, 'i'))['aria-pressed']).toBe('true');
    expect(props(byTestId(els, 'i')).title).toBe('Select');
  });
  it('disables a busy button and shows a spinner', () => {
    const els = elements(Button({ busy: true, onClick: () => {}, children: 'Save', 'data-testid': 'b' }));
    expect(props(byTestId(els, 'b')).disabled).toBe(true);
    expect(els.some((e) => String(props(e).class ?? '').includes('ui-spinner'))).toBe(true);
    expect(text(byTestId(els, 'b'))).toContain('Save');
  });
});

describe('toast store', () => {
  function fakeTimers() {
    const timers = new Map<number, () => void>();
    let next = 1;
    return {
      set: (fn: () => void, _ms: number) => { const id = next++; timers.set(id, fn); return id; },
      clear: (id: number) => { timers.delete(id); },
      fireAll: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
      count: () => timers.size,
    };
  }

  it('pushes toasts with increasing ids and auto-dismisses non-sticky ones after 4000 ms', () => {
    const t = fakeTimers();
    const delays: number[] = [];
    const store = createToastStore({ setTimer: (fn, ms) => { delays.push(ms); return t.set(fn, ms); }, clearTimer: t.clear });
    const a = store.push({ kind: 'ok', text: 'Saved' });
    const b = store.push({ kind: 'error', text: 'Failed', sticky: true });
    expect(b).toBeGreaterThan(a);
    expect(delays).toEqual([4000]);
    t.fireAll();
    expect(store.toasts().map((x) => x.text)).toEqual(['Failed']);
  });

  it('dismisses by id, clears its timer and notifies listeners', () => {
    const t = fakeTimers();
    const store = createToastStore({ setTimer: t.set, clearTimer: t.clear });
    const listener = vi.fn();
    store.subscribe(listener);
    const id = store.push({ kind: 'info', text: 'Hi' });
    store.dismiss(id);
    expect(store.toasts()).toEqual([]);
    expect(t.count()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
