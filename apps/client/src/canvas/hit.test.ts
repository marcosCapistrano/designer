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

  describe('boxSelect edges', () => {
    const box = (nodeId: string, x: number, y: number, w: number, h: number): HitBox => ({ nodeId, x, y, w, h });
    const ALL = { x: 0, y: 0, w: 1000, h: 1000 };

    it('an empty map selects nothing', () => {
      expect(boxSelect([], ALL)).toEqual([]);
    });

    it('a map with nothing inside the rect selects nothing', () => {
      expect(boxSelect([box('a', 500, 500, 10, 10)], { x: 0, y: 0, w: 100, h: 100 })).toEqual([]);
    });

    it('a containment chain keeps only the outermost', () => {
      const map = [box('a', 0, 0, 400, 400), box('b', 10, 10, 300, 300), box('c', 20, 20, 200, 200), box('d', 30, 30, 10, 10)];
      expect(boxSelect(map, ALL)).toEqual(['a']);
    });

    it('a chain whose outer box is not fully inside the rect keeps the outermost box that is', () => {
      const map = [box('a', 0, 0, 400, 400), box('b', 10, 10, 300, 300), box('c', 20, 20, 200, 200)];
      // a sticks out of the rect, so b is the outermost candidate and c is dropped for b.
      expect(boxSelect(map, { x: 5, y: 5, w: 500, h: 500 })).toEqual(['b']);
    });

    it('only an earlier box hides a later one, so an enclosing box that paints later keeps both', () => {
      const map = [box('inner', 10, 10, 20, 20), box('outer', 0, 0, 100, 100)];
      expect(boxSelect(map, ALL)).toEqual(['inner', 'outer']);
    });

    it('siblings and a box enclosed by a later-listed sibling subtree are all kept', () => {
      const map = [box('p', 0, 0, 100, 100), box('s1', 0, 0, 40, 40), box('s2', 50, 0, 40, 40), box('q', 200, 200, 50, 50)];
      expect(boxSelect(map, ALL)).toEqual(['p', 'q']);
      expect(boxSelect(map.slice(1), ALL)).toEqual(['s1', 's2', 'q']);
    });

    it('selects a box whose edges are exactly the rect, and rejects one a pixel over', () => {
      const r = { x: 10, y: 20, w: 100, h: 50 };
      expect(boxSelect([box('on', 10, 20, 100, 50)], r)).toEqual(['on']);
      expect(boxSelect([box('left', 9, 20, 100, 50)], r)).toEqual([]);
      expect(boxSelect([box('top', 10, 19, 100, 50)], r)).toEqual([]);
      expect(boxSelect([box('right', 10, 20, 101, 50)], r)).toEqual([]);
      expect(boxSelect([box('bottom', 10, 20, 100, 51)], r)).toEqual([]);
    });

    it('a box that shares an edge with its enclosing box is still enclosed', () => {
      const map = [box('a', 0, 0, 100, 100), box('flushLeft', 0, 30, 20, 20), box('flushCorner', 80, 80, 20, 20)];
      expect(boxSelect(map, ALL)).toEqual(['a']);
    });

    it('a box overlapping another without being enclosed is kept', () => {
      const map = [box('a', 0, 0, 100, 100), box('b', 50, 50, 100, 100)];
      expect(boxSelect(map, ALL)).toEqual(['a', 'b']);
    });

    it('zero-size boxes follow the same rules', () => {
      const map = [box('a', 0, 0, 100, 100), box('dot', 50, 50, 0, 0), box('lone', 500, 500, 0, 0)];
      expect(boxSelect(map, ALL)).toEqual(['a', 'lone']);
    });

    it('matches a reference that checks every earlier box, on random maps', () => {
      let seed = 12345;
      const rnd = (n: number) => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed % n;
      };
      const reference = (map: readonly HitBox[], r: { x: number; y: number; w: number; h: number }): string[] => {
        const inside = map.filter((b) => b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h);
        return inside
          .filter(
            (b, i) =>
              !inside
                .slice(0, i)
                .some((e) => e.x <= b.x && e.y <= b.y && b.x + b.w <= e.x + e.w && b.y + b.h <= e.y + e.h),
          )
          .map((b) => b.nodeId);
      };
      for (let round = 0; round < 200; round++) {
        const map = Array.from({ length: 1 + rnd(25) }, (_, i) =>
          box(`n${i}`, rnd(60), rnd(60), rnd(60), rnd(60)),
        );
        const r = { x: rnd(20), y: rnd(20), w: 40 + rnd(100), h: 40 + rnd(100) };
        expect(boxSelect(map, r)).toEqual(reference(map, r));
      }
    });

    it('checks the nearest earlier box first', () => {
      // c is enclosed by b but not by a. Scanning down from c stops at b, so adding c to the map must
      // not make boxSelect read a any more often than it did without c.
      const readsOfA = (withC: boolean): number => {
        let reads = 0;
        const a: HitBox = {
          nodeId: 'a',
          get x() {
            reads++;
            return 0;
          },
          y: 0,
          w: 10,
          h: 10,
        };
        const map = [a, box('b', 20, 0, 100, 100), ...(withC ? [box('c', 30, 10, 10, 10)] : [])];
        expect(boxSelect(map, ALL)).toEqual(['a', 'b']);
        return reads;
      };
      expect(readsOfA(true)).toBe(readsOfA(false));
    });
  });

  it('toPagePoint', () => {
    const frame: Frame = {
      frameId: 'f',
      viewportHeight: 900,
      stale: null,
      pending: true,
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
