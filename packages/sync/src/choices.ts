import { createHash } from 'node:crypto';
import type { PreviewChoices, SourceGap } from './types.js';
export function choiceKey(file: string, expression: string): string { return createHash('sha256').update(`${file}\0${expression}`).digest('hex'); }
export class PreviewRequired extends Error {
  constructor(readonly gap: SourceGap) { super(`Dynamic expression needs a saved preview choice: ${gap.expression.slice(0,100)}`); }
}
// R9: real apps have many dynamic sites; the bound still stops runaway data.
const MAX_CHOICES = 2000;
const MAX_CHOICES_BYTES = 4 * 1024 * 1024;
/** Choices are JSON data, bounded before they reach source traversal. The final model is validated too. */
export function choicesProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Preview choices must be an object';
  if (Object.keys(value).length > MAX_CHOICES) return `At most ${MAX_CHOICES} preview choices are supported`;
  const json = (item: unknown, depth = 0): boolean => {
    if (depth > 30) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= 20_000;
    if (Array.isArray(item)) return item.length <= 200 && item.every((child) => json(child,depth+1));
    return typeof item === 'object' && item !== null && Object.entries(item).every(([key,child]) => !['__proto__','prototype','constructor'].includes(key) && json(child,depth+1));
  };
  for (const [key, choice] of Object.entries(value)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !choice || typeof choice !== 'object' || Array.isArray(choice) || !json(choice)) return 'Invalid preview choice';
    const raw = choice as Record<string, unknown>;
    if (raw['kind'] === 'value') {
      if (!Object.hasOwn(raw,'value')) return 'A preview value is required';
    } else if (raw['kind'] === 'nodes') { if (!Array.isArray(raw['nodes'])) return 'Preview nodes must be an array'; }
    else return 'Invalid preview choice kind';
  }
  if (JSON.stringify(value).length > MAX_CHOICES_BYTES) return 'Preview choices exceed 4 MB';
  return null;
}
