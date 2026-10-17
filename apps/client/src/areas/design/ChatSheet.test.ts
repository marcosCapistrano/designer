import { describe, expect, it, vi } from 'vitest';
import type { DesignMessage } from '@hub/protocol';
import { byTestId, elements, inputEvent, props, text } from '../../ui/test-vnode.js';
import { ChatSheetView } from './ChatSheet.js';
import type { ChatSheetViewProps } from './ChatSheet.js';

const msg = (id: number, kind: DesignMessage['kind'], t: string): DesignMessage => ({ id, app: 'a', kind, text: t, at: id });

function render(extra: Partial<ChatSheetViewProps> = {}) {
  const h = { onText: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), onToggle: vi.fn(), onDetach: vi.fn(), onPreview: vi.fn() };
  const p: ChatSheetViewProps = {
    messages: [msg(1, 'user', 'make it red'), msg(2, 'assistant', 'Done.'), msg(3, 'error', 'Failed')],
    running: false, error: null, tags: new Map([[2, 'preview' as const]]), text: '', expanded: false,
    selection: null, disabled: false, docked: false, ...h, ...extra,
  };
  const els = elements(ChatSheetView(p));
  return { ...h, els, get: (id: string) => byTestId(els, id) };
}
const click = (v: unknown) => (props(v as never).onClick as () => void)();

describe('ChatSheetView', () => {
  it('prompts for a design change without a selection, and for the selected element with one', () => {
    expect(props(render().get('chat-input')).placeholder).toBe('Describe a design change…');
    const s = render({ selection: { label: 'h3', device: 'base' } });
    expect(props(s.get('chat-input')).placeholder).toBe('Edit the selected h3…');
    expect(text(s.get('chat-chip'))).toContain('h3 · Desktop');
  });

  it('detaches the selection from the chip', () => {
    const s = render({ selection: { label: 'h3', device: 'tablet' } });
    click(s.get('chat-chip-detach'));
    expect(s.onDetach).toHaveBeenCalled();
  });

  it('sends on the button and on Enter, with the 20,000 character limit', () => {
    const s = render({ text: 'make it red' });
    expect(props(s.get('chat-input')).maxLength).toBe(20_000);
    click(s.get('chat-send'));
    (props(s.get('chat-input')).onKeyDown as (e: Event) => void)(inputEvent('make it red', 'Enter'));
    expect(s.onSend).toHaveBeenCalledTimes(2);
    (props(s.get('chat-input')).onInput as (e: Event) => void)(inputEvent('x'));
    expect(s.onText).toHaveBeenCalledWith('x');
  });

  it('disables send for blank text or while disabled', () => {
    expect(props(render().get('chat-send')).disabled).toBe(true);
    expect(props(render({ text: 'x', disabled: true }).get('chat-send')).disabled).toBe(true);
  });

  it('shows Stop instead of send while running', () => {
    const s = render({ running: true, text: 'x' });
    expect(() => s.get('chat-send')).toThrow();
    click(s.get('chat-stop'));
    expect(s.onStop).toHaveBeenCalled();
  });

  it('has the mic, disabled, with the coming-later label', () => {
    const mic = render().get('mic');
    expect(props(mic).disabled).toBe(true);
    expect(props(mic)['aria-label']).toBe('Voice coming later');
  });

  it('hides history when collapsed and shows bubbles by kind when expanded', () => {
    expect(() => render().get('chat-messages')).toThrow();
    const s = render({ expanded: true });
    expect(String(props(s.get('chat-msg-1')).class)).toContain('chat-msg-user');
    expect(String(props(s.get('chat-msg-2')).class)).toContain('chat-msg-assistant');
    expect(String(props(s.get('chat-msg-3')).class)).toContain('chat-msg-error');
  });

  it('tags the answer that produced a preview, and the tag opens it', () => {
    const s = render({ expanded: true });
    expect(text(s.get('chat-tag-2'))).toBe('Preview ready');
    click(s.get('chat-tag-2'));
    expect(s.onPreview).toHaveBeenCalled();
  });

  it('toggles the history from its button', () => {
    const s = render();
    click(s.get('chat-toggle'));
    expect(s.onToggle).toHaveBeenCalled();
  });

  it('shows the last error', () => {
    expect(text(render({ error: 'offline' }).get('chat-error'))).toBe('offline');
  });
});
