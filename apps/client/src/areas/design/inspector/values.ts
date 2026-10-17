// What the inspector shows for a property on a device tier. A tier without its own value shows the value it
// inherits: tablet from base, mobile from tablet, then base (the device media cascade).
import { DEVICE_LABEL } from '@hub/protocol';
import type { Device, DesignTarget } from '@hub/protocol';

export type TierStyle = DesignTarget['style'];
export interface Shown { value: string; inherited: Device | null }

const CHAIN: Record<Device, readonly Device[]> = { base: ['base'], tablet: ['tablet', 'base'], mobile: ['mobile', 'tablet', 'base'] };

export function effectiveStyle(style: TierStyle | undefined, device: Device, prop: string): Shown {
  for (const tier of CHAIN[device]) {
    const value = style?.[tier]?.[prop];
    if (value !== undefined) return { value, inherited: tier === device ? null : tier };
  }
  return { value: '', inherited: null };
}

export const inheritedLabel = (tier: Device): string => `inherits ${DEVICE_LABEL[tier]}`;

export type SideKind = 'padding' | 'margin';
export const sideProps = (kind: SideKind): string[] => ['top', 'right', 'bottom', 'left'].map((side) => `${kind}-${side}`);

/** CSS's 1–4 value expansion: top, right, bottom, left. */
function expand(shorthand: string): string[] | null {
  const parts = shorthand.trim().split(/\s+(?![^(]*\))/);
  if (parts.length < 1 || parts.length > 4 || parts[0] === '') return null;
  const [t, r = t, b = t, l = r] = parts as [string, string?, string?, string?];
  return [t, r!, b!, l!];
}

/**
 * The four sides as shown on a tier. Per tier from closest to farthest, a longhand wins over that tier's
 * shorthand, and the closest tier that sets either wins — the order the sorted export cascades in.
 */
export function sideValues(style: TierStyle | undefined, device: Device, kind: SideKind): Shown[] {
  return sideProps(kind).map((prop, index) => {
    for (const tier of CHAIN[device]) {
      const own = style?.[tier];
      const inherited = tier === device ? null : tier;
      if (own?.[prop] !== undefined) return { value: own[prop]!, inherited };
      const shorthand = own?.[kind];
      const sides = shorthand !== undefined ? expand(shorthand) : null;
      if (sides) return { value: sides[index]!, inherited };
    }
    return { value: '', inherited: null };
  });
}
