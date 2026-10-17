// CSS lengths the inspector can step: a number with one of a few units. Anything else (auto, calc(), var())
// stays text and is never stepped.

export interface Length { number: number; unit: string }

const LENGTH = /^(-?\d*\.?\d+)(px|rem|em|%|vh|vw)$/;

export function parseLength(value: string): Length | null {
  const m = LENGTH.exec(value.trim());
  return m ? { number: Number(m[1]), unit: m[2]! } : null;
}

export function stepFor(unit: string): number {
  return unit === 'rem' || unit === 'em' ? 0.125 : 1;
}

/** Rounds away float noise (0.1 + 0.2) at four decimals, which is finer than any step. */
export function formatLength(number: number, unit: string): string {
  return `${Number(number.toFixed(4))}${unit}`;
}

/** The value moved by `direction` steps of its unit; an unparsable value is returned unchanged. */
export function stepValue(value: string, direction: number): string {
  const length = parseLength(value);
  if (!length) return value;
  return formatLength(length.number + direction * stepFor(length.unit), length.unit);
}
