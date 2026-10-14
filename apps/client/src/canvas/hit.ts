// Hit testing and box selection over render hit maps. Hit maps are in page CSS
// px at zoom 1, in paint order, so later boxes paint on top.

import type { HitBox } from '@hub/protocol';
import type { Point, Rect } from './geom.js';
import type { Frame } from './layout.js';

function containsPoint(b: HitBox, p: Point): boolean {
  return b.x <= p.x && p.x < b.x + b.w && b.y <= p.y && p.y < b.y + b.h;
}

// True when `inner` lies within `outer` (edges may touch).
function encloses(outer: HitBox, inner: HitBox): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function hitTest(map: readonly HitBox[], p: Point): string | null {
  for (let i = map.length - 1; i >= 0; i--) {
    const b = map[i];
    if (b && containsPoint(b, p)) return b.nodeId;
  }
  return null;
}

// Boxes fully inside r, minus any box enclosed by an earlier box in the map.
// Dropping against earlier boxes (kept or not) gives the same result as
// dropping only against kept ones, since enclosure is transitive. The scan runs
// from the nearest earlier box backwards (a box's ancestors tend to sit near it
// in paint order); the result does not depend on the scan direction.
export function boxSelect(map: readonly HitBox[], r: Rect): string[] {
  const inside: HitBox[] = [];
  for (const b of map) {
    if (b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h) {
      inside.push(b);
    }
  }
  const out: string[] = [];
  for (let i = 0; i < inside.length; i++) {
    const box = inside[i];
    if (!box) continue;
    let covered = false;
    for (let j = i - 1; j >= 0 && !covered; j--) {
      const earlier = inside[j];
      if (earlier && encloses(earlier, box)) covered = true;
    }
    if (!covered) out.push(box.nodeId);
  }
  return out;
}

export function toPagePoint(f: Frame, world: Point): Point {
  return { x: world.x - f.x, y: world.y - f.y };
}
