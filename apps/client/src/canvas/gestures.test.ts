import { describe, expect, it } from 'vitest';
import { GestureTracker, wheelAction, type PointerIn, type Tool } from './gestures.js';

const P = (
  id: number,
  kind: PointerIn['kind'],
  x: number,
  y: number,
  pointerType: PointerIn['pointerType'] = 'touch',
  button = 0,
): PointerIn => ({ id, kind, x, y, pointerType, button });
const down = (id: number, x: number, y: number, pointerType: PointerIn['pointerType'] = 'touch', button = 0) =>
  P(id, 'down', x, y, pointerType, button);
const move = (id: number, x: number, y: number, pointerType: PointerIn['pointerType'] = 'touch', button = 0) =>
  P(id, 'move', x, y, pointerType, button);
const up = (id: number, x: number, y: number, pointerType: PointerIn['pointerType'] = 'touch', button = 0) =>
  P(id, 'up', x, y, pointerType, button);

describe('GestureTracker', () => {
  it('tap', () => {
    let tool: Tool = 'pan';
    const t = new GestureTracker(() => tool);
    expect(t.handle(down(1, 100, 100))).toEqual([]);
    expect(t.handle(up(1, 103, 102))).toEqual([{ type: 'tap', x: 100, y: 100 }]);
  });

  it('small moves stay a tap', () => {
    let tool: Tool = 'pan';
    const t = new GestureTracker(() => tool);
    expect(t.handle(down(1, 0, 0))).toEqual([]);
    expect(t.handle(move(1, 5, 5))).toEqual([]);
    expect(t.handle(up(1, 5, 5))).toEqual([{ type: 'tap', x: 0, y: 0 }]);
  });

  it('pan drag', () => {
    let tool: Tool = 'pan';
    const t = new GestureTracker(() => tool);
    expect(t.handle(down(1, 100, 100))).toEqual([]);
    expect(t.handle(move(1, 120, 100))).toEqual([{ type: 'pan', dx: 20, dy: 0 }]);
    expect(t.handle(move(1, 125, 90))).toEqual([{ type: 'pan', dx: 5, dy: -10 }]);
    expect(t.handle(up(1, 125, 90))).toEqual([]);
  });

  it('select tool marquee', () => {
    let tool: Tool = 'select';
    const t = new GestureTracker(() => tool);
    expect(t.handle(down(1, 10, 10))).toEqual([]);
    expect(t.handle(move(1, 50, 60))).toEqual([
      { type: 'marquee', phase: 'move', x0: 10, y0: 10, x1: 50, y1: 60 },
    ]);
    expect(t.handle(up(1, 50, 60))).toEqual([
      { type: 'marquee', phase: 'end', x0: 10, y0: 10, x1: 50, y1: 60 },
    ]);
  });

  it('pen marquees in pan tool', () => {
    let tool: Tool = 'pan';
    const t = new GestureTracker(() => tool);
    expect(t.handle(down(1, 10, 10, 'pen'))).toEqual([]);
    expect(t.handle(move(1, 50, 60, 'pen'))).toEqual([
      { type: 'marquee', phase: 'move', x0: 10, y0: 10, x1: 50, y1: 60 },
    ]);
  });

  it('middle mouse pans in select tool', () => {
    let tool: Tool = 'select';
    const t = new GestureTracker(() => tool);
    expect(t.handle(down(1, 0, 0, 'mouse', 1))).toEqual([]);
    expect(t.handle(move(1, 20, 0, 'mouse', 1))).toEqual([{ type: 'pan', dx: 20, dy: 0 }]);
  });

  it('middle click is not a tap', () => {
    let tool: Tool = 'pan';
    const t = new GestureTracker(() => tool);
    expect(t.handle(down(1, 0, 0, 'mouse', 1))).toEqual([]);
    expect(t.handle(up(1, 0, 0, 'mouse', 1))).toEqual([]);
  });

  it('pinch zoom', () => {
    let tool: Tool = 'pan';
    const t = new GestureTracker(() => tool);
    expect(t.handle(down(1, 100, 100))).toEqual([]);
    expect(t.handle(down(2, 200, 100))).toEqual([]);
    expect(t.handle(move(2, 300, 100))).toEqual([
      { type: 'pan', dx: 50, dy: 0 },
      { type: 'zoom', x: 200, y: 100, factor: 2 },
    ]);
  });

  it('second finger cancels a marquee', () => {
    let tool: Tool = 'select';
    const t = new GestureTracker(() => tool);
    expect(t.handle(down(1, 0, 0))).toEqual([]);
    expect(t.handle(move(1, 40, 40))).toEqual([
      { type: 'marquee', phase: 'move', x0: 0, y0: 0, x1: 40, y1: 40 },
    ]);
    expect(t.handle(down(2, 100, 100))).toEqual([
      { type: 'marquee', phase: 'cancel', x0: 0, y0: 0, x1: 40, y1: 40 },
    ]);
  });

  it('lifting one finger continues as pan', () => {
    let tool: Tool = 'pan';
    const t = new GestureTracker(() => tool);
    expect(t.handle(down(1, 100, 100))).toEqual([]);
    expect(t.handle(down(2, 200, 100))).toEqual([]);
    expect(t.handle(up(2, 200, 100))).toEqual([]);
    expect(t.handle(move(1, 110, 100))).toEqual([{ type: 'pan', dx: 10, dy: 0 }]);
    expect(t.handle(up(1, 110, 100))).toEqual([]);
  });

  it('wheel', () => {
    const z = wheelAction({ x: 5, y: 6, deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: true, metaKey: false });
    expect(z.type).toBe('zoom');
    if (z.type !== 'zoom') throw new Error('expected zoom');
    expect(z.x).toBe(5);
    expect(z.y).toBe(6);
    expect(z.factor).toBeCloseTo(Math.exp(-1));

    expect(wheelAction({ x: 0, y: 0, deltaX: 5, deltaY: 30, deltaMode: 0, ctrlKey: false, metaKey: false })).toEqual({
      type: 'pan',
      dx: -5,
      dy: -30,
    });
    expect(wheelAction({ x: 0, y: 0, deltaX: 0, deltaY: 3, deltaMode: 1, ctrlKey: false, metaKey: false })).toEqual({
      type: 'pan',
      dx: 0,
      dy: -48,
    });
  });

  describe('lost pointer-ups', () => {
    const cancel = (id: number, x: number, y: number, pointerType: PointerIn['pointerType'] = 'touch') =>
      P(id, 'cancel', x, y, pointerType);

    it('reset drops a ghost contact, so the next touch pans instead of pinching', () => {
      const t = new GestureTracker(() => 'pan');
      t.handle(down(1, 100, 100));
      expect(t.handle(move(1, 130, 100))).toEqual([{ type: 'pan', dx: 30, dy: 0 }]);
      // The pointer-up for finger 1 never arrives.
      expect(t.reset()).toEqual([]);

      expect(t.handle(down(2, 400, 400))).toEqual([]);
      expect(t.handle(move(2, 420, 400))).toEqual([{ type: 'pan', dx: 20, dy: 0 }]);
    });

    it('reset when idle does nothing, and the tracker still works', () => {
      const t = new GestureTracker(() => 'pan');
      expect(t.reset()).toEqual([]);
      t.handle(down(1, 5, 5));
      expect(t.handle(up(1, 5, 5))).toEqual([{ type: 'tap', x: 5, y: 5 }]);
    });

    it('reset during a marquee returns its cancel, so the overlay can clear it', () => {
      const t = new GestureTracker(() => 'select');
      t.handle(down(1, 0, 0));
      t.handle(move(1, 40, 30));
      expect(t.reset()).toEqual([{ type: 'marquee', phase: 'cancel', x0: 0, y0: 0, x1: 40, y1: 30 }]);
      expect(t.handle(up(1, 40, 30))).toEqual([]);
    });

    it('a down for an id the tracker already holds starts over (a mouse whose up was lost)', () => {
      const t = new GestureTracker(() => 'pan');
      t.handle(down(1, 10, 10, 'mouse'));
      expect(t.handle(move(1, 50, 10, 'mouse'))).toEqual([{ type: 'pan', dx: 40, dy: 0 }]);

      expect(t.handle(down(1, 200, 200, 'mouse'))).toEqual([]);
      expect(t.handle(move(1, 230, 200, 'mouse'))).toEqual([{ type: 'pan', dx: 30, dy: 0 }]);
    });

    it('a repeated down without movement is a tap at the new position', () => {
      const t = new GestureTracker(() => 'pan');
      t.handle(down(1, 10, 10, 'mouse'));
      t.handle(move(1, 50, 10, 'mouse'));
      t.handle(down(1, 200, 200, 'mouse'));
      expect(t.handle(up(1, 200, 200, 'mouse'))).toEqual([{ type: 'tap', x: 200, y: 200 }]);
    });

    it('a repeated down during a pinch drops the other contact too', () => {
      const t = new GestureTracker(() => 'pan');
      t.handle(down(1, 100, 100));
      t.handle(down(2, 200, 100));
      // Finger 2 lifted without an up, then touched again.
      expect(t.handle(down(2, 300, 300))).toEqual([]);
      expect(t.handle(move(2, 340, 300))).toEqual([{ type: 'pan', dx: 40, dy: 0 }]);
      expect(t.handle(move(1, 110, 100))).toEqual([]);
    });

    it('a repeated down during a marquee cancels it', () => {
      const t = new GestureTracker(() => 'select');
      t.handle(down(1, 0, 0, 'mouse'));
      t.handle(move(1, 40, 30, 'mouse'));
      expect(t.handle(down(1, 90, 90, 'mouse'))).toEqual([
        { type: 'marquee', phase: 'cancel', x0: 0, y0: 0, x1: 40, y1: 30 },
      ]);
    });

    it('cancelling one pinch finger leaves the other panning', () => {
      const t = new GestureTracker(() => 'pan');
      t.handle(down(1, 100, 100));
      t.handle(down(2, 200, 100));
      expect(t.handle(cancel(2, 200, 100))).toEqual([]);
      expect(t.handle(move(1, 110, 100))).toEqual([{ type: 'pan', dx: 10, dy: 0 }]);
    });

    it('a cancel for a pointer that already lifted is ignored', () => {
      const t = new GestureTracker(() => 'pan');
      t.handle(down(1, 100, 100));
      t.handle(down(2, 200, 100));
      t.handle(up(2, 200, 100));
      expect(t.handle(cancel(2, 200, 100))).toEqual([]);
      expect(t.handle(move(1, 110, 100))).toEqual([{ type: 'pan', dx: 10, dy: 0 }]);
    });
  });
});
