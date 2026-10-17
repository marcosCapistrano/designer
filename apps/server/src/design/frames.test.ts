import { DEFAULT_FRAME_SIZES, ROW_GAP, sizeKey, type CanvasFrame, type RenderManifest } from '@hub/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, type Db } from '../db.js';
import Database from 'better-sqlite3';
import { CanvasFrames, pagesInRouteOrder } from './frames.js';

let db: Db;
let pages: { pageId: string }[];
let manifest: RenderManifest | null;
const make = () => new CanvasFrames({ db, pages: async () => pages, manifest: async () => manifest });
const render = (width: number, viewportHeight: number, height: number) => ({ device: 'base', hash: 'h', width, viewportHeight, height, levels: [] }) as unknown as RenderManifest['pages'][number]['renders'][string];
const rows = () => db.prepare('SELECT * FROM canvas_frames ORDER BY id').all() as { page_id: string }[];

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  pages = [{ pageId: 'p1' }, { pageId: 'p2' }];
  manifest = null;
});

describe('CanvasFrames', () => {
  const allRendered = (height = 1000): RenderManifest => ({
    version: 2,
    pages: pages.map((p) => ({ pageId: p.pageId, name: '', route: '/', renders: Object.fromEntries(DEFAULT_FRAME_SIZES.map((s) => [sizeKey(s), render(s.width, s.viewportHeight, height)])) })),
  });

  it('materializes and persists six default frames on first list once every height is known', async () => {
    manifest = allRendered();
    const f = make();
    const first = await f.list('demo');
    expect(first.frames).toHaveLength(6);
    expect(first.provisional).toBe(false);
    expect(rows()).toHaveLength(6);
    expect((await f.list('demo')).frames.map((x) => x.id)).toEqual(first.frames.map((x) => x.id));
  });

  it('does not persist defaults while the manifest is absent or v1, and re-lays them out once heights land', async () => {
    const f = make();
    const before = await f.list('demo');
    expect(before.provisional).toBe(true);
    expect(before.frames).toHaveLength(6);
    expect(rows()).toHaveLength(0);
    manifest = { version: 1, pages: [] } as unknown as RenderManifest; // FsTileStore.readManifest gives null for v1; be safe either way
    expect((await f.list('demo')).provisional).toBe(true);
    expect(rows()).toHaveLength(0);
    manifest = allRendered(5401);
    const after = await f.list('demo');
    expect(after.provisional).toBe(false);
    expect(after.frames.filter((x) => x.pageId === 'p2').every((x) => x.y === 5401 + ROW_GAP)).toBe(true);
    expect(rows()).toHaveLength(6);
    // Provisional and persisted defaults share ids, so a selection survives the reload.
    expect(after.frames.map((x) => x.id).sort()).toEqual(before.frames.map((x) => x.id).sort());
  });

  it('does not persist defaults for a page that has no render yet, but keeps the rest of the layout', async () => {
    manifest = allRendered();
    const f = make();
    await f.list('demo');
    pages = [...pages, { pageId: 'p3' }];
    const out = await f.list('demo');
    expect(out.provisional).toBe(true);
    expect(out.frames.filter((x) => x.pageId === 'p3')).toHaveLength(3);
    expect(rows()).toHaveLength(6);
  });

  it('counts a failed render as known, placing the next row at least a viewport below', async () => {
    manifest = allRendered();
    manifest.pages[0]!.renders = Object.fromEntries(DEFAULT_FRAME_SIZES.map((s) => [sizeKey(s), { ...render(s.width, s.viewportHeight, 0), error: 'boom' }]));
    const out = await make().list('demo');
    expect(out.provisional).toBe(false);
    expect(out.frames.find((x) => x.pageId === 'p2')!.y).toBe(Math.max(...DEFAULT_FRAME_SIZES.map((s) => s.viewportHeight)) + ROW_GAP);
  });

  it('returns [] when nothing is imported', async () => {
    const f = new CanvasFrames({ db, pages: async () => null, manifest: async () => null });
    expect(await f.list('demo')).toEqual({ frames: [], provisional: false });
  });

  it('places rows using manifest heights', async () => {
    manifest = allRendered(100);
    manifest.pages[0]!.renders[sizeKey(DEFAULT_FRAME_SIZES[2]!)] = render(390, 844, 5401);
    const { frames: out } = await make().list('demo');
    const p2 = out.filter((x) => x.pageId === 'p2');
    expect(p2[0]!.y).toBe(5401 + ROW_GAP);
    expect(out.filter((x) => x.pageId === 'p1').map((x) => x.pageId)).toHaveLength(3);
  });

  it('drops frames of pages that no longer exist', async () => {
    manifest = allRendered();
    const f = make();
    await f.list('demo');
    pages = [{ pageId: 'p1' }];
    const { frames: out } = await f.list('demo');
    expect(out.every((x) => x.pageId === 'p1')).toBe(true);
    expect(out).toHaveLength(3);
    expect(rows().every((r) => r.page_id === 'p1')).toBe(true);
  });

  it('rejects invalid replace without changes and round-trips a valid one', async () => {
    manifest = allRendered();
    const f = make();
    const { frames: before } = await f.list('demo');
    const bad = { ...before[0]!, width: 239 };
    expect(await f.replace('demo', [bad])).toEqual({ ok: false, error: 'frames[0].width must be an integer from 240 to 3840' });
    expect((await f.list('demo')).frames).toEqual(before);
    const next: CanvasFrame[] = [{ id: 'f0123456789abcdef', pageId: 'p2', x: 8, y: 16, width: 1000, viewportHeight: 700 }];
    const res = await f.replace('demo', next);
    expect(res).toEqual({ ok: true, frames: next });
    const { frames: after } = await f.list('demo');
    expect(after.filter((x) => x.pageId === 'p2')).toEqual(next);
    expect(after.filter((x) => x.pageId === 'p1')).toHaveLength(3); // defaults materialize for p1
  });

  it('sizesByPage dedupes saved sizes, defaults others, and never writes', async () => {
    pages = [{ pageId: 'p1' }, { pageId: 'p3' }];
    const f = make();
    const frame = (id: string, w: number, h: number): CanvasFrame => ({ id, pageId: 'p1', x: 0, y: 0, width: w, viewportHeight: h });
    await f.replace('demo', [frame('f0000000000000001', 1600, 900), frame('f0000000000000002', 1600, 900), frame('f0000000000000003', 390, 844)]);
    const before = rows();
    const sizes = await f.sizesByPage('demo');
    expect(sizes('p1')).toEqual([{ width: 1600, viewportHeight: 900 }, { width: 390, viewportHeight: 844 }]);
    expect(sizes('p3')).toEqual(DEFAULT_FRAME_SIZES);
    expect(rows()).toEqual(before);
  });

  it('missingRenders', async () => {
    const f = make();
    manifest = allRendered();
    await f.list('demo');
    expect(await f.missingRenders('demo', null)).toBe(true);
    expect(await f.missingRenders('demo', { version: 1, pages: [] } as unknown as RenderManifest)).toBe(true);
    const all = (): RenderManifest => allRendered();
    expect(await f.missingRenders('demo', all())).toBe(false);
    const { frames } = await f.list('demo');
    await f.replace('demo', [...frames, { id: 'f00000000000000aa', pageId: 'p1', x: 0, y: 99999, width: 1280, viewportHeight: 800 }]);
    expect(await f.missingRenders('demo', all())).toBe(true);
  });
});

describe('pagesInRouteOrder', () => {
  it('orders pages by route, then id, like the renderer', () => {
    const pages = { b: { id: 'b', route: '/z' }, a: { id: 'a', route: '/about' }, c: { id: 'c', route: '/' }, d: { id: 'd', route: '/about' } };
    expect(pagesInRouteOrder(pages)).toEqual([{ pageId: 'c' }, { pageId: 'a' }, { pageId: 'd' }, { pageId: 'b' }]);
  });
});
