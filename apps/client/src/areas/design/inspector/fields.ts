// Which properties each inspector section edits, and which of them a target shows: the ones it has a value for
// (its own or inherited on the chosen tier), plus any the user added from the section's + menu.
import type { DesignTarget, Device } from '@hub/protocol';
import { effectiveStyle, sideValues } from './values.js';

export type FieldSection = 'typography' | 'fill' | 'spacing' | 'size' | 'border';
export interface FieldDef { prop: string; label: string; kind: 'length' | 'color' | 'weight' | 'sides' }

export const FIELDS: Record<FieldSection, readonly FieldDef[]> = {
  typography: [
    { prop: 'font-size', label: 'Size', kind: 'length' },
    { prop: 'font-weight', label: 'Weight', kind: 'weight' },
    { prop: 'line-height', label: 'Line height', kind: 'length' },
    { prop: 'color', label: 'Color', kind: 'color' },
  ],
  fill: [{ prop: 'background-color', label: 'Background', kind: 'color' }],
  spacing: [
    { prop: 'padding', label: 'Padding', kind: 'sides' },
    { prop: 'margin', label: 'Margin', kind: 'sides' },
    { prop: 'gap', label: 'Gap', kind: 'length' },
  ],
  size: [
    { prop: 'width', label: 'Width', kind: 'length' },
    { prop: 'height', label: 'Height', kind: 'length' },
    { prop: 'max-width', label: 'Max width', kind: 'length' },
  ],
  border: [
    { prop: 'border-width', label: 'Width', kind: 'length' },
    { prop: 'border-color', label: 'Color', kind: 'color' },
    { prop: 'border-radius', label: 'Radius', kind: 'length' },
  ],
};

export function hasValue(target: DesignTarget, device: Device, prop: string): boolean {
  if (prop === 'padding' || prop === 'margin') return sideValues(target.style, device, prop).some((s) => s.value !== '');
  return effectiveStyle(target.style, device, prop).value !== '';
}

/** The section's properties the target shows, in section order. `added` holds `section:prop` keys. */
export function shownFields(section: FieldSection, target: DesignTarget, device: Device, added: ReadonlySet<string>): string[] {
  return FIELDS[section].filter((f) => added.has(`${section}:${f.prop}`) || hasValue(target, device, f.prop)).map((f) => f.prop);
}

/** Text, or an element whose own content is text: the only targets with typography. */
export const textBearing = (target: DesignTarget): boolean => !!target.textNode;
