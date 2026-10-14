import { applyOp, exportPage, sampleDoc, type DesignDoc, type Result } from '@hub/design-model';
import { hitMapPath, tilePath, type Device, type PageRender } from '@hub/protocol';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { cssForDevice } from './html.js';
import { BrowserPool } from './pool.js';
import { renderDoc, renderJob, type RenderDocResult, type RenderJob } from './render.js';
import { MemoryTileStore } from './store.js';
import type { TileFile } from './tiles.js';

let pool: BrowserPool;
let store: ScriptedStore;

beforeAll(() => {
  pool = new BrowserPool({ size: 2 });
});

afterAll(async () => {
  await pool.close();
});

beforeEach(() => {
  store = new ScriptedStore();
});

/** Memory store that can report levels as missing, fail reads, or fail tile writes on demand. */
class ScriptedStore extends MemoryTileStore {
  readonly missing = new Set<string>();
  /** The next this-many hasLevel calls throw. */
  hasLevelFailures = 0;
  putFails = false;

  override async hasLevel(key: string): Promise<boolean> {
    if (this.hasLevelFailures > 0) {
      this.hasLevelFailures--;
      throw new Error('hasLevel failed');
    }
    if (this.missing.has(key)) return false;
    return super.hasLevel(key);
  }

  override async putTiles(tiles: readonly TileFile[]): Promise<void> {
    if (this.putFails) throw new Error('disk full');
    return super.putTiles(tiles);
  }
}

const all = ['base', 'tablet', 'mobile'] as const;
const must = (r: Result<{ doc: DesignDoc }>): DesignDoc => {
  if (!r.ok) throw new Error(r.error);
  return r.value.doc;
};

const addAbout = (doc: DesignDoc): DesignDoc =>
  must(
    applyOp(doc, {
      op: 'addPage',
      page: {
        id: 'about',
        name: 'About',
        route: '/about',
        root: { id: 'n9', kind: 'element', tag: 'main', attrs: {}, style: { base: {} }, children: [] },
      },
    }),
  );
const withAbout = (): DesignDoc => addAbout(sampleDoc());
const brokenDoc = (): DesignDoc => {
  const broken = structuredClone(sampleDoc());
  delete broken.components.Card;
  return broken;
};
const mobileEdited = (): DesignDoc =>
  must(applyOp(sampleDoc(), { op: 'setStyle', node: 'n3', device: 'mobile', prop: 'padding', value: '4px' }));

const renderOf = (r: RenderDocResult, pageId: string, device: Device): PageRender => {
  const found = r.manifest.pages.find((p) => p.pageId === pageId)?.renders[device];
  if (!found) throw new Error(`no render for ${pageId}@${device}`);
  return found;
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
  // Reused renders are copies: the new manifest never shares a levels array with prev.
  expect(renderOf(second, 'home', 'base').levels).not.toBe(renderOf(first, 'home', 'base').levels);
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
  const first = await renderDoc(pool, withAbout(), { devices: all, prev: null, store });
  const edited = must(applyOp(withAbout(), { op: 'setStyle', node: 'n7', device: 'base', prop: 'color', value: '#ff0000' }));
  const second = await renderDoc(pool, edited, { devices: all, prev: first.manifest, store });
  expect(second.rendered).toEqual(['home@base', 'home@mobile', 'home@tablet']);
  expect(second.reused).toEqual(['about@base', 'about@mobile', 'about@tablet']);
});

test('pages are ordered by route', async () => {
  const result = await renderDoc(pool, withAbout(), { devices: all, prev: null, store });
  expect(result.manifest.pages.map((p) => p.pageId)).toEqual(['home', 'about']);
});

test('failed export keeps the last good render with an error', async () => {
  const first = await renderDoc(pool, sampleDoc(), { devices: all, prev: null, store });
  const second = await renderDoc(pool, brokenDoc(), { devices: all, prev: first.manifest, store });
  expect(second.failed).toHaveLength(3);
  const prevBase = renderOf(first, 'home', 'base');
  const base = renderOf(second, 'home', 'base');
  expect(base.levels).toEqual(prevBase.levels);
  expect(base.levels).not.toBe(prevBase.levels);
  expect(base.hash).toBe(prevBase.hash);
  expect(base.error).toContain('Component Card not found');
});

test('failed export without a previous render gives an empty placeholder', async () => {
  const result = await renderDoc(pool, brokenDoc(), { devices: all, prev: null, store });
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

test('subset render carries the other devices over from prev unchanged', async () => {
  const first = await renderDoc(pool, sampleDoc(), { devices: all, prev: null, store });
  const second = await renderDoc(pool, mobileEdited(), { devices: ['mobile'], prev: first.manifest, store });
  expect(second.rendered).toEqual(['home@mobile']);
  expect(second.manifest.pages[0]!.renders.base).toEqual(first.manifest.pages[0]!.renders.base);
  expect(second.manifest.pages[0]!.renders.tablet).toEqual(first.manifest.pages[0]!.renders.tablet);
  expect(Object.keys(second.manifest.pages[0]!.renders)).toEqual(['base', 'tablet', 'mobile']);
});

test('subset render without prev yields only the requested devices', async () => {
  const result = await renderDoc(pool, sampleDoc(), { devices: ['tablet'], prev: null, store });
  expect(result.rendered).toEqual(['home@tablet']);
  expect(Object.keys(result.manifest.pages[0]!.renders)).toEqual(['tablet']);
});

test('a carried-over render keeps its error unchanged', async () => {
  const first = await renderDoc(pool, sampleDoc(), { devices: all, prev: null, store });
  const failedRun = await renderDoc(pool, brokenDoc(), { devices: all, prev: first.manifest, store });
  const mobileOnly = await renderDoc(pool, sampleDoc(), { devices: ['mobile'], prev: failedRun.manifest, store });
  expect(mobileOnly.reused).toEqual(['home@mobile']);
  expect(mobileOnly.rendered).toEqual([]);
  const kept = mobileOnly.manifest.pages[0]!.renders;
  expect(kept.base).toEqual(renderOf(failedRun, 'home', 'base'));
  expect(kept.base!.error).toContain('Component Card not found');
  expect(kept.tablet).toEqual(renderOf(failedRun, 'home', 'tablet'));
});

test('pages that left the doc are not carried over', async () => {
  const first = await renderDoc(pool, withAbout(), { devices: all, prev: null, store });
  const result = await renderDoc(pool, sampleDoc(), { devices: ['mobile'], prev: first.manifest, store });
  expect(result.manifest.pages.map((p) => p.pageId)).toEqual(['home']);
});

test('reused render has no error property', async () => {
  const first = await renderDoc(pool, sampleDoc(), { devices: all, prev: null, store });
  const failedRun = await renderDoc(pool, brokenDoc(), { devices: all, prev: first.manifest, store });
  expect(failedRun.failed).toHaveLength(3);
  const back = await renderDoc(pool, sampleDoc(), { devices: all, prev: failedRun.manifest, store });
  expect(back.reused).toEqual(['home@base', 'home@mobile', 'home@tablet']);
  for (const device of all) {
    expect(renderOf(back, 'home', device)).not.toHaveProperty('error');
  }
});

test('re-renders a device when a prev level is missing from the store', async () => {
  const first = await renderDoc(pool, sampleDoc(), { devices: all, prev: null, store });
  store.missing.add(renderOf(first, 'home', 'base').levels[0]!.key);
  const second = await renderDoc(pool, sampleDoc(), { devices: all, prev: first.manifest, store });
  expect(second.rendered).toEqual(['home@base']);
  expect(second.reused).toEqual(['home@mobile', 'home@tablet']);
});

test('a hasLevel error counts as a miss and re-renders', async () => {
  const first = await renderDoc(pool, sampleDoc(), { devices: all, prev: null, store });
  store.hasLevelFailures = 1;
  const second = await renderDoc(pool, sampleDoc(), { devices: all, prev: first.manifest, store });
  expect(second.failed).toEqual([]);
  expect(second.rendered).toEqual(['home@base']);
  expect(second.reused).toEqual(['home@mobile', 'home@tablet']);
  expect(renderOf(second, 'home', 'base')).toEqual(renderOf(first, 'home', 'base'));
});

test('a failed tile write falls back to the last good render', async () => {
  const first = await renderDoc(pool, sampleDoc(), { devices: all, prev: null, store });
  store.putFails = true;
  const second = await renderDoc(pool, mobileEdited(), { devices: all, prev: first.manifest, store });
  expect(second.failed).toEqual(['home@mobile']);
  expect(second.reused).toEqual(['home@base', 'home@tablet']);
  expect(renderOf(second, 'home', 'mobile')).toEqual({ ...renderOf(first, 'home', 'mobile'), error: 'disk full' });
});

test('runs at most `concurrency` render jobs at once', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  // Stub pool: each job holds its slot briefly, then fails, so only the scheduling is measured.
  const stub = {
    withPage: async (): Promise<never> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      throw new Error('stub page');
    },
  } as unknown as BrowserPool;
  const result = await renderDoc(stub, withAbout(), { devices: all, prev: null, store, concurrency: 2 });
  expect(maxInFlight).toBe(2);
  expect(result.failed).toHaveLength(6);
  expect(result.rendered).toEqual([]);
});
