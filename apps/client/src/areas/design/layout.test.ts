import { describe, expect, it } from 'vitest';
import type { ImportResponse, RenderManifest } from '@hub/protocol';
import { INSPECTOR_BREAKPOINT, panelLayout } from './layout.js';
import { importOutcome } from './import-result.js';
import { proposalSource } from './preview-source.js';

describe('panelLayout', () => {
  it('puts the inspector on the right and docks chat under it at 900 px and wider', () => {
    expect(INSPECTOR_BREAKPOINT).toBe(900);
    expect(panelLayout(900, true)).toEqual({ inspector: 'right', chatDocked: true });
    expect(panelLayout(1600, true)).toEqual({ inspector: 'right', chatDocked: true });
  });
  it('uses a bottom sheet below 900 px, with chat undocked so its bar stays reachable', () => {
    expect(panelLayout(899, true)).toEqual({ inspector: 'bottom', chatDocked: false });
    expect(panelLayout(390, true)).toEqual({ inspector: 'bottom', chatDocked: false });
  });
  it('has no inspector and an undocked chat when closed', () => {
    expect(panelLayout(1600, false)).toEqual({ inspector: 'none', chatDocked: false });
  });
});

const okBase = { ok: true as const, revision: 'r', rebuilt: ['/a', '/b', '/c'], reused: [], removed: [], failed: [], inlined: [], sourceOnlyRules: 0, manifest: null, warnings: [] };

describe('importOutcome', () => {
  it('reports a clean import as a passing ok toast', () => {
    const [only, ...rest] = importOutcome(okBase);
    expect(rest).toEqual([]);
    expect(only!.toast).toMatchObject({ kind: 'ok', text: expect.stringContaining('Imported 3 pages') });
    expect(only!.toast.sticky).toBeFalsy();
    expect(only!.details).toBeNull();
  });

  it('reports failed routes as a sticky warning with the routes and diagnostics as details', () => {
    const out: ImportResponse = { ...okBase, failed: [{ route: '/x', diagnostics: [{ file: 'app/x/page.tsx', message: 'Unsupported hook useState' }] }] };
    const [first] = importOutcome(out);
    expect(first!.toast).toMatchObject({ kind: 'warning', sticky: true, text: expect.stringContaining('1 route failed to import') });
    expect(first!.details).toEqual({ title: 'Routes not imported', items: ['/x — app/x/page.tsx: Unsupported hook useState'] });
  });

  it('adds the import’s warnings as their own sticky warning', () => {
    const out = importOutcome({ ...okBase, warnings: ['Preview failed for p@1440x900.'] });
    expect(out[1]!.toast).toMatchObject({ kind: 'warning', sticky: true, text: 'Preview failed for p@1440x900.' });
  });

  it('reports a source failure as a sticky error with its diagnostics', () => {
    const [first] = importOutcome({ ok: false, kind: 'source', diagnostics: [{ file: 'a.tsx', message: 'boom' }, { file: '', message: 'no file' }] });
    expect(first!.toast).toMatchObject({ kind: 'error', sticky: true, text: 'Import was not applied. Your previous design and edits are preserved.' });
    expect(first!.details).toEqual({ title: 'Why the import was not applied', items: ['a.tsx: boom', 'no file'] });
  });

  it('reports a replay conflict with each conflict and the blocked count', () => {
    const [first] = importOutcome({ ok: false, kind: 'replay', conflicts: [{ index: 2, op: {}, message: 'node gone' }], blocked: [3, 4] });
    expect(first!.details!.items).toEqual(['Edit 3: node gone', '2 later edits are blocked.']);
  });
});

describe('proposalSource', () => {
  it('serves the proposal manifest and delegates tiles and hit maps to the live source', async () => {
    const manifest: RenderManifest = { version: 2, pages: [] };
    const live = { manifest: async () => ({ version: 2, pages: [{ pageId: 'x' }] }) as never, tile: async () => new Blob(['t']), hitMap: async () => [], subscribe: () => () => {} };
    const s = proposalSource(manifest, live);
    expect(await s.manifest()).toBe(manifest);
    expect(await (await s.tile('k', 0, 0)).text()).toBe('t');
    const unsub = s.subscribe(() => { throw new Error('a preview never updates'); });
    unsub();
  });
});
