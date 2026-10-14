import { describe, expect, it } from 'vitest';
import type { HitBox } from '@hub/protocol';
import { boxSelect, hitTest, toPagePoint } from './hit.js';
import type { Frame } from './layout.js';

const MAP: HitBox[] = [
  { nodeId: 'n1', x: 0, y: 0, w: 1440, h: 2000 },
  { nodeId: 'n2', x: 0, y: 0, w: 1440, h: 80 },
  { nodeId: 'n3', x: 20, y: 20, w: 100, h: 40 },
  { nodeId: 'n5', x: 0, y: 100, w: 400, h: 300 },
  { nodeId: 'ov', x: 10, y: 10, w: 50, h: 50 },
];

describe('hit testing and box selection', () => {
  it('topmost wins', () => {
    expect(hitTest(MAP, { x: 30, y: 30 })).toBe('ov');
    expect(hitTest(MAP, { x: 100, y: 30 })).toBe('n3');
    expect(hitTest(MAP, { x: 500, y: 50 })).toBe('n2');
    expect(hitTest(MAP, { x: 500, y: 1000 })).toBe('n1');
  });

  it('right edge is exclusive', () => {
    expect(hitTest(MAP, { x: 120, y: 30 })).toBe('n2');
  });

  it('outside everything', () => {
    expect(hitTest(MAP, { x: 2000, y: 10 })).toBeNull();
  });

  it('box select fully contained', () => {
    expect(boxSelect(MAP, { x: 0, y: 90, w: 500, h: 400 })).toEqual(['n5']);
    expect(boxSelect(MAP, { x: 0, y: 0, w: 200, h: 70 })).toEqual(['n3', 'ov']);
  });

  it('keeps outermost', () => {
    const map: HitBox[] = [
      { nodeId: 'a', x: 0, y: 0, w: 100, h: 100 },
      { nodeId: 'b', x: 10, y: 10, w: 20, h: 20 },
    ];
    expect(boxSelect(map, { x: 0, y: 0, w: 200, h: 200 })).toEqual(['a']);
  });

  it('equal boxes keep the first', () => {
    const map: HitBox[] = [
      { nodeId: 'a', x: 5, y: 5, w: 30, h: 30 },
      { nodeId: 'b', x: 5, y: 5, w: 30, h: 30 },
    ];
    expect(boxSelect(map, { x: 0, y: 0, w: 200, h: 200 })).toEqual(['a']);
  });

  it('toPagePoint', () => {
    const frame: Frame = {
      pageId: 'p1',
      name: 'Home',
      device: 'base',
      x: 1520,
      y: 3200,
      w: 1440,
      h: 2000,
      render: null,
    };
    expect(toPagePoint(frame, { x: 1530, y: 3210 })).toEqual({ x: 10, y: 10 });
  });
});
