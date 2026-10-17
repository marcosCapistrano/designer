import { describe, expect, it } from 'vitest';
import type { DesignEditResult } from '@hub/protocol';
import { resultToast } from './result-toast.js';

const applied = (warnings: string[] = []): DesignEditResult => ({ mode: 'applied', revision: 'r', warnings });
const preview: DesignEditResult = { mode: 'preview', proposal: { id: 'p', revision: 'r', descriptions: [], manifest: null, warnings: [] } };

describe('resultToast', () => {
  it('stays quiet for a successful inspector edit: the field itself is the feedback', () => {
    expect(resultToast(applied(), 'inspector')).toBeNull();
  });
  it('still shows an inspector edit’s warnings', () => {
    expect(resultToast(applied(['Render failed for p@390x844.']), 'inspector')).toEqual({ kind: 'warning', text: 'Render failed for p@390x844.' });
  });
  it('confirms chat and preview applies, and undo/redo with their word plus any warning', () => {
    expect(resultToast(applied(), 'chat')).toEqual({ kind: 'ok', text: 'Design updated.' });
    expect(resultToast(applied(), 'apply')).toEqual({ kind: 'ok', text: 'Design updated.' });
    expect(resultToast(applied(), 'undo')).toEqual({ kind: 'ok', text: 'Undone.' });
    expect(resultToast(applied(['Shared change.']), 'redo')).toEqual({ kind: 'ok', text: 'Redone. Shared change.' });
  });
  it('shows nothing for a preview: the banner is the feedback', () => {
    expect(resultToast(preview, 'chat')).toBeNull();
  });
});
