/** Which drag a plain (non-pinch) primary press performs. */
export type Tool = 'pan' | 'select';

/** Movement in CSS px that still counts as a tap. */
export const TAP_SLOP = 8;

export interface PointerIn {
  id: number;
  kind: 'down' | 'move' | 'up' | 'cancel';
  x: number;
  y: number;
  pointerType: 'mouse' | 'touch' | 'pen';
  button: number;
}

export interface WheelIn {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

export type GestureAction =
  | { type: 'pan'; dx: number; dy: number }
  | { type: 'zoom'; x: number; y: number; factor: number }
  | { type: 'tap'; x: number; y: number }
  | { type: 'marquee'; phase: 'move' | 'end' | 'cancel'; x0: number; y0: number; x1: number; y1: number };

interface Pt {
  x: number;
  y: number;
}

/** A pointer the tracker follows. Any other pointer is ignored. */
interface Contact extends Pt {
  pointerType: PointerIn['pointerType'];
}

type State =
  | { mode: 'idle' }
  | { mode: 'pending'; id: number; start: Pt; button: number; drag: 'pan' | 'marquee' }
  | { mode: 'pan'; id: number; last: Pt }
  | { mode: 'marquee'; id: number; start: Pt; last: Pt }
  | { mode: 'pinch'; ids: readonly [number, number]; cx: number; cy: number; d: number };

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function pinchGeometry(p: Pt, q: Pt): { cx: number; cy: number; d: number } {
  return { cx: (p.x + q.x) / 2, cy: (p.y + q.y) / 2, d: dist(p, q) };
}

function marquee(phase: 'move' | 'end' | 'cancel', a: Pt, b: Pt): GestureAction {
  return { type: 'marquee', phase, x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

export class GestureTracker {
  private readonly getTool: () => Tool;
  private readonly contacts = new Map<number, Contact>();
  private state: State = { mode: 'idle' };

  constructor(getTool: () => Tool) {
    this.getTool = getTool;
  }

  /** Whether the tracker follows this pointer. */
  holds(id: number): boolean {
    return this.contacts.has(id);
  }

  /** Whether the tracker follows any pointer. */
  get active(): boolean {
    return this.contacts.size > 0;
  }

  handle(ev: PointerIn): GestureAction[] {
    if (ev.kind === 'down') return this.down(ev);
    if (ev.kind === 'move') return this.move(ev);
    return this.lift(ev, ev.kind === 'cancel');
  }

  /**
   * Forgets every contact, for when their pointer-ups were lost (window blur,
   * tab hidden). Returns the cancel of a marquee in progress so the caller can
   * clear it.
   */
  reset(): GestureAction[] {
    const s = this.state;
    const out = s.mode === 'marquee' ? [marquee('cancel', s.start, s.last)] : [];
    this.clear();
    return out;
  }

  private clear(): void {
    this.contacts.clear();
    this.state = { mode: 'idle' };
  }

  private down(ev: PointerIn): GestureAction[] {
    // A down for an id we still hold means its up was lost (a mouse always has the same id): start over.
    const dropped = this.contacts.has(ev.id) ? this.reset() : [];
    const s = this.state;
    if (s.mode === 'idle') {
      const drag = ev.button === 0 && (this.getTool() === 'select' || ev.pointerType === 'pen') ? 'marquee' : 'pan';
      this.contacts.set(ev.id, { x: ev.x, y: ev.y, pointerType: ev.pointerType });
      this.state = { mode: 'pending', id: ev.id, start: { x: ev.x, y: ev.y }, button: ev.button, drag };
      return dropped;
    }
    // A third pointer, or a second pointer that is not touch, is ignored.
    if (s.mode === 'pinch' || ev.pointerType !== 'touch') return [];
    const primary = this.contacts.get(s.id);
    if (primary?.pointerType !== 'touch') return [];

    const out: GestureAction[] = [];
    if (s.mode === 'marquee') out.push(marquee('cancel', s.start, s.last));
    this.contacts.set(ev.id, { x: ev.x, y: ev.y, pointerType: 'touch' });
    const g = pinchGeometry(primary, ev);
    this.state = { mode: 'pinch', ids: [s.id, ev.id], cx: g.cx, cy: g.cy, d: g.d };
    return out;
  }

  private move(ev: PointerIn): GestureAction[] {
    const c = this.contacts.get(ev.id);
    if (!c) return [];
    c.x = ev.x;
    c.y = ev.y;
    const pos: Pt = { x: ev.x, y: ev.y };
    const s = this.state;
    switch (s.mode) {
      case 'pending': {
        if (dist(s.start, pos) <= TAP_SLOP) return [];
        if (s.drag === 'pan') {
          this.state = { mode: 'pan', id: s.id, last: pos };
          return [{ type: 'pan', dx: pos.x - s.start.x, dy: pos.y - s.start.y }];
        }
        this.state = { mode: 'marquee', id: s.id, start: s.start, last: pos };
        return [marquee('move', s.start, pos)];
      }
      case 'pan': {
        this.state = { mode: 'pan', id: s.id, last: pos };
        return [{ type: 'pan', dx: pos.x - s.last.x, dy: pos.y - s.last.y }];
      }
      case 'marquee': {
        this.state = { ...s, last: pos };
        return [marquee('move', s.start, pos)];
      }
      case 'pinch': {
        const a = this.contacts.get(s.ids[0]);
        const b = this.contacts.get(s.ids[1]);
        if (!a || !b) return [];
        const g = pinchGeometry(a, b);
        const out: GestureAction[] = [{ type: 'pan', dx: g.cx - s.cx, dy: g.cy - s.cy }];
        if (s.d !== 0 && g.d !== 0) out.push({ type: 'zoom', x: g.cx, y: g.cy, factor: g.d / s.d });
        this.state = { ...s, cx: g.cx, cy: g.cy, d: g.d };
        return out;
      }
      case 'idle':
        return [];
    }
  }

  private lift(ev: PointerIn, cancel: boolean): GestureAction[] {
    if (!this.contacts.has(ev.id)) return [];
    const s = this.state;
    switch (s.mode) {
      case 'pending':
        this.clear();
        return !cancel && s.button === 0 ? [{ type: 'tap', x: s.start.x, y: s.start.y }] : [];
      case 'pan':
        this.clear();
        return [];
      case 'marquee':
        this.clear();
        return cancel ? [marquee('cancel', s.start, s.last)] : [marquee('end', s.start, ev)];
      case 'pinch': {
        this.contacts.delete(ev.id);
        const rest = s.ids[0] === ev.id ? s.ids[1] : s.ids[0];
        const p = this.contacts.get(rest);
        if (!p) {
          this.clear();
          return [];
        }
        this.state = { mode: 'pan', id: rest, last: { x: p.x, y: p.y } };
        return [];
      }
      case 'idle':
        return [];
    }
  }
}

export function wheelAction(ev: WheelIn): GestureAction {
  const m = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 800 : 1;
  if (ev.ctrlKey || ev.metaKey) {
    return { type: 'zoom', x: ev.x, y: ev.y, factor: Math.exp(-ev.deltaY * m * 0.01) };
  }
  // `0 - v` rather than `-v` so a zero delta is +0, not -0.
  return { type: 'pan', dx: 0 - ev.deltaX * m, dy: 0 - ev.deltaY * m };
}
