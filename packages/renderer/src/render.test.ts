import { cssForDevice } from './html.js';
import { MemoryTileStore } from './store.js';
import { BrowserPool } from './pool.js';
import { renderDoc, renderJob, type RenderJob } from './render.js';
import { exportPage, applyOp, sampleDoc, type DesignDoc, type Result } from '@hub/design-model';
import { hitMapPath, tilePath } from '@hub/protocol';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

let pool: BrowserPool;
let store: MemoryTileStore;

beforeAll(() => {
  pool = new BrowserPool({ size: 2 });
});

afterAll(async () => {
  await pool.close();
});

beforeEach(() => {
  store = new MemoryTileStore();
});

const all = ['base', 'tablet', 'mobile'] as const;
const must = (r: Result<{ doc: DesignDoc }>): DesignDoc => {
  if (!r.ok) throw new Error(r.error);
  return r.value.doc;
};

test('renders every page and device the first time', async () => {
  const result = await renderDoc(pool, sampleDoc(), { devices: all, prev: null, store });
  expect(result.rendered).toEqual(['home@base', 'home@mobile', 'home@tablet']);
  expect(result.reused).toEqual([]);
  expect(result.failed).toEqual([]);

  const page = result.manifest.pages[0]!;
  expect(page).toMatchObject({ pageId: 'home', name: 'Home', route: '/' });
  const base = page.renders.base!;
  expect({ width: base.width, height: base.height }).toEqual({ width: 1440, height: 900 });
  expect(base.levels.length).toBe(3);
  expect(store.files.has(tilePath(base.levels[2]!.key, 0, 0))).toBe(true);
  expect(store.files.has(hitMapPath(base.hash))).toBe(true);
});

test('unchanged doc re-renders nothing', async () => {
  const doc = sampleDoc();
  const first = await renderDoc(pool, doc, { devices: all, prev: null, store });
  const second = await renderDoc(pool, doc, { devices: all, prev: first.manifest, store });
  expect(second.rendered).toEqual([]);
  expect(second.reused).toHaveLength(3);
  expect(second.manifest).toEqual(first.manifest);
});

test('mobile-only edit re-renders only mobile', async () => {
  const doc = sampleDoc();
  const first = await renderDoc(pool, doc, { devices: all, prev: null, store });
  const doc2 = must(applyOp(doc, { op: 'setStyle', node: 'n3', device: 'mobile', prop: 'padding', value: '4px' }));
  const second = await renderDoc(pool, doc2, { devices: all, prev: first.manifest, store });
  expect(second.rendered).toEqual(['home@mobile']);
  expect(second.reused).toEqual(['home@base', 'home@tablet']);
});

test('component edit re-renders only pages that use it', async () => {
  const withAbout = must(
    applyOp(sampleDoc(), {
      op: 'addPage',
      page: {
        id: 'about',
        name: 'About',
        route: '/about',
        root: { id: 'n9', kind: 'element', tag: 'main', attrs: {}, style: { base: {} }, children: [] },
      },
    }),
  );
  const first = await renderDoc(pool, withAbout, { devices: all, prev: null, store });
  const edited = must(applyOp(withAbout, { op: 'setStyle', node: 'n7', device: 'base', prop: 'color', value: '#ff0000' }));
  const second = await renderDoc(pool, edited, { devices: all, prev: first.manifest, store });
  expect(second.rendered).toEqual(['home@base', 'home@mobile', 'home@tablet']);
  expect(second.reused).toEqual(['about@base', 'about@mobile', 'about@tablet']);
});

test('pages are ordered by route', async () => {
  const withAbout = must(
    applyOp(sampleDoc(), {
      op: 'addPage',
      page: {
        id: 'about',
        name: 'About',
        route: '/about',
        root: { id: 'n9', kind: 'element', tag: 'main', attrs: {}, style: { base: {} }, children: [] },
      },
    }),
  );
  const result = await renderDoc(pool, withAbout, { devices: all, prev: null, store });
  expect(result.manifest.pages.map((p) => p.pageId)).toEqual(['home', 'about']);
});

test('failed export keeps the last good render with an error', async () => {
  const first = await renderDoc(pool, sampleDoc(), { devices: all, prev: null, store });
  const broken = structuredClone(sampleDoc());
  delete broken.components.Card;
  const second = await renderDoc(pool, broken, { devices: all, prev: first.manifest, store });
  expect(second.failed).toHaveLength(3);
  const prevBase = first.manifest.pages[0]!.renders.base!;
  const base = second.manifest.pages[0]!.renders.base!;
  expect(base.levels).toEqual(prevBase.levels);
  expect(base.hash).toBe(prevBase.hash);
  expect(base.error).toContain('Component Card not found');
});

test('failed export without a previous render gives an empty placeholder', async () => {
  const broken = structuredClone(sampleDoc());
  delete broken.components.Card;
  const result = await renderDoc(pool, broken, { devices: all, prev: null, store });
  expect(result.manifest.pages[0]!.renders.base).toEqual({
    device: 'base',
    hash: '',
    width: 1440,
    height: 0,
    levels: [],
    error: expect.stringContaining('Component Card not found'),
  });
});

test('renderJob is deterministic', async () => {
  const exported = exportPage(sampleDoc(), 'home');
  if (!exported.ok) throw new Error(exported.error);
  const job: RenderJob = {
    pageId: 'home',
    device: 'mobile',
    html: exported.value.html,
    css: cssForDevice(exported.value.css, 'mobile'),
  };
  const a = await renderJob(pool, job);
  const b = await renderJob(pool, job);
  expect(a.render).toEqual(b.render);
  expect(a.hitMap).toEqual(b.hitMap);
  expect(a.tiles).toEqual(b.tiles);
});
