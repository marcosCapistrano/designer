import { describe, expect, it, vi } from 'vitest';
import { FRAME_GAP, FRAME_PRESETS, MAX_FRAMES_PER_PAGE, validateFrames } from '@hub/protocol';
import type { CanvasFrame } from '@hub/protocol';
import type { ComponentChild, VNode } from 'preact';
import { FrameMenuView } from './FrameMenu.js';
import type { MenuDraft } from './FrameMenu.js';

const fr = (id: string, pageId: string, x: number, width: number, y = 0): CanvasFrame => ({
  id,
  pageId,
  x,
  y,
  width,
  viewportHeight: 900,
});
const id = (n: number) => 'f' + n.toString(16).padStart(16, '0');

const A0 = fr(id(1), 'a', 0, 1440);
const A1 = fr(id(2), 'a', 1520, 834);
const B0 = fr(id(3), 'b', 0, 1440, 1100);

/** Every element of a rendered tree, depth first. */
function elements(node: ComponentChild, out: VNode[] = []): VNode[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (node !== null && typeof node === 'object') {
    out.push(node as VNode);
    elements((node as VNode).props.children as ComponentChild, out);
  }
  return out;
}
const text = (node: ComponentChild): string =>
  Array.isArray(node)
    ? node.map(text).join('')
    : node === null || node === undefined || typeof node === 'boolean'
      ? ''
      : typeof node === 'object'
        ? text((node as VNode).props.children as ComponentChild)
        : String(node);

function setup(frame: CanvasFrame, frames: CanvasFrame[], draft: Partial<MenuDraft> = {}) {
  const onChange = vi.fn();
  const onClose = vi.fn();
  const setDraft = vi.fn();
  const full: MenuDraft = { width: '', height: '', error: null, ...draft };
  const tree = FrameMenuView({ frame, frames, onChange, onClose, draft: full, setDraft });
  const els = elements(tree);
  const byId = (t: string): VNode => {
    const e = els.find((v) => (v.props as Record<string, unknown>)['data-testid'] === t);
    if (!e) throw new Error('no element ' + t);
    return e;
  };
  const click = (t: string): void => {
    const h = (byId(t).props as { onClick?: () => void }).onClick;
    h?.();
  };
  const disabled = (t: string): boolean => Boolean((byId(t).props as { disabled?: boolean }).disabled);
  return { onChange, onClose, setDraft, byId, click, disabled, tree, els };
}

describe('FrameMenu', () => {
  it('sizes the frame to a preset and keeps the rest of the layout', () => {
    const m = setup(A0, [A0, A1, B0]);
    expect(text(m.byId('size-1600x900'))).toBe('1600 × 900');
    m.click('size-1600x900');
    expect(m.onChange).toHaveBeenCalledWith([{ ...A0, width: 1600, viewportHeight: 900 }, A1, B0]);
  });

  it('offers the ten presets in order for size and for add', () => {
    const m = setup(A0, [A0]);
    const keys = FRAME_PRESETS.map((p) => `${p.width}x${p.viewportHeight}`);
    for (const k of keys) {
      m.byId('size-' + k);
      m.byId('add-' + k);
    }
    expect(m.els.filter((e) => String((e.props as Record<string, unknown>)['data-testid']).startsWith('size-'))).toHaveLength(10);
  });

  it('refuses a custom width of 239 with the limit and does not apply', () => {
    const m = setup(A0, [A0], { width: '239', height: '900' });
    m.click('custom-apply');
    expect(m.onChange).not.toHaveBeenCalled();
    expect(m.setDraft).toHaveBeenCalledWith(expect.objectContaining({ error: 'Width must be 240–3840' }));
    const shown = setup(A0, [A0], { width: '239', height: '900', error: 'Width must be 240–3840' });
    expect(text(shown.byId('custom-error'))).toBe('Width must be 240–3840');
  });

  it('refuses a custom height outside 320–4000 and a non-integer', () => {
    const lo = setup(A0, [A0], { width: '800', height: '319' });
    lo.click('custom-apply');
    expect(lo.setDraft).toHaveBeenCalledWith(expect.objectContaining({ error: 'Height must be 320–4000' }));
    const frac = setup(A0, [A0], { width: '800.5', height: '900' });
    frac.click('custom-apply');
    expect(frac.setDraft).toHaveBeenCalledWith(expect.objectContaining({ error: 'Width must be 240–3840' }));
    expect(frac.onChange).not.toHaveBeenCalled();
  });

  it('applies a valid custom size', () => {
    const m = setup(A1, [A0, A1], { width: '1000', height: '700' });
    m.click('custom-apply');
    expect(m.onChange).toHaveBeenCalledWith([A0, { ...A1, width: 1000, viewportHeight: 700 }]);
  });

  it('adds a frame right of the page rightmost frame, at this frame y, with a fresh id', () => {
    const lower = { ...A0, y: 40 };
    const m = setup(lower, [lower, A1, B0]);
    m.click('add-1280x800');
    const next = m.onChange.mock.calls[0]![0] as CanvasFrame[];
    expect(next).toHaveLength(4);
    const added = next[3]!;
    expect(added).toMatchObject({ pageId: 'a', width: 1280, viewportHeight: 800, x: 1520 + 834 + FRAME_GAP, y: 40 });
    expect([lower, A1, B0].map((f) => f.id)).not.toContain(added.id);
    expect(validateFrames(next, new Set(['a', 'b'])).ok).toBe(true);
  });

  it('duplicates at the same size, placed like an added frame (right of the page rightmost)', () => {
    const m = setup(A0, [A0, A1]);
    m.click('duplicate');
    const next = m.onChange.mock.calls[0]![0] as CanvasFrame[];
    expect(next[2]).toMatchObject({ pageId: 'a', width: 1440, viewportHeight: 900, x: 1520 + 834 + FRAME_GAP, y: 0 });
    expect(next[2]!.id).not.toBe(A0.id);
    expect(next[2]!.id).toMatch(/^f[0-9a-f]{16}$/);
  });

  it('deletes a frame, but not the last frame of its page', () => {
    const two = setup(A0, [A0, A1, B0]);
    expect(two.disabled('delete')).toBe(false);
    two.click('delete');
    expect(two.onChange).toHaveBeenCalledWith([A1, B0]);

    const only = setup(B0, [A0, A1, B0]);
    expect(only.disabled('delete')).toBe(true);
    only.click('delete');
    expect(only.onChange).not.toHaveBeenCalled();
  });

  it('disables add and duplicate at 12 frames on the page, and says so', () => {
    const many = Array.from({ length: MAX_FRAMES_PER_PAGE }, (_, i) => fr(id(100 + i), 'a', i * 100, 240));
    const m = setup(many[0]!, many);
    expect(m.disabled('add-1600x900')).toBe(true);
    expect(m.disabled('duplicate')).toBe(true);
    expect(text(m.tree)).toContain('12 frames per page');
    m.click('add-1600x900');
    expect(m.onChange).not.toHaveBeenCalled();
    // One short of the cap is still open.
    const open = setup(many[0]!, many.slice(1));
    expect(open.disabled('add-1600x900')).toBe(false);
  });

  it('keeps every action target at least 44 px tall', () => {
    const m = setup(A0, [A0]);
    const buttons = m.els.filter((e) => e.type === 'button');
    expect(buttons.length).toBeGreaterThan(20);
    for (const b of buttons) expect(String((b.props as { style?: string }).style)).toMatch(/min-height:44px/);
  });
});
