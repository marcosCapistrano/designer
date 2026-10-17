// Component mode on the canvas. Hit-map ids nest through instances (`a/x`, `a/b/y`); the scope is the path of the
// instance being edited ('' outside component mode), and a hit selects one level below it.
import type { HitBox } from '@hub/protocol';

/** The id a hit selects under `scope`, or null when the hit is outside it. */
export function scopedId(hit: string, scope: string): string | null {
  const depth = scope === '' ? 0 : scope.split('/').length;
  if (scope !== '' && !hit.startsWith(`${scope}/`)) return null;
  return hit.split('/').slice(0, depth + 1).join('/');
}

/** The scope of a component-mode stack: its innermost instance, or '' outside the mode. */
export function prefixOf(stack: readonly string[]): string {
  return stack.at(-1) ?? '';
}

/** A node's box: its own hit box, else the union of the boxes under it (an instance has none of its own). */
export function boxOf(map: readonly HitBox[], id: string): HitBox | null {
  const own = map.find((b) => b.nodeId === id);
  if (own) return own;
  const prefix = `${id}/`;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of map) {
    if (!b.nodeId.startsWith(prefix)) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return x0 === Infinity ? null : { nodeId: id, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
