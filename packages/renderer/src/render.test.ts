import { applyOp, exportPage, sampleDoc, type DesignDoc, type Result } from '@hub/design-model';
import {
  DEFAULT_FRAME_SIZES,
  hitMapPath,
  tilePath,
  type FrameSize,
  type PageRender,
  type RenderManifest,
} from '@hub/protocol';
import sharp from 'sharp';
import type { Page } from 'playwright';
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

const [BASE, TABLET, MOBILE] = DEFAULT_FRAME_SIZES as readonly [FrameSize, FrameSize, FrameSize];
const BASE_KEY = '1440x900';
const TABLET_KEY = '834x1194';
const MOBILE_KEY = '390x844';
const defaults = () => DEFAULT_FRAME_SIZES;
const all = { sizes: defaults };
const only = (...sizes: FrameSize[]) => ({ sizes: () => sizes });
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

const renderOf = (r: RenderDocResult, pageId: string, key: string): PageRender => {
  const found = r.manifest.pages.find((p) => p.pageId === pageId)?.renders[key];
  if (!found) throw new Error(`no render for ${pageId}@${key}`);
  return found;
};

test('renders every page and device the first time', async () => {
  const result = await renderDoc(pool, sampleDoc(), { ...all, prev: null, store });
  expect(result.rendered).toEqual(['home@1440x900', 'home@390x844', 'home@834x1194']);
  expect(result.reused).toEqual([]);
  expect(result.failed).toEqual([]);

  const page = result.manifest.pages[0]!;
  expect(page).toMatchObject({ pageId: 'home', name: 'Home', route: '/' });
  const base = page.renders[BASE_KEY]!;
  expect({ width: base.width, height: base.height, viewportHeight: base.viewportHeight, device: base.device }).toEqual({
    width: 1440,
    height: 900,
    viewportHeight: 900,
    device: 'base',
  });
  expect(base.levels.length).toBe(3);
  expect(store.files.has(tilePath(base.levels[2]!.key, 0, 0))).toBe(true);
  expect(store.files.has(hitMapPath(base.hash))).toBe(true);
});

test('unchanged doc re-renders nothing', async () => {
  const doc = sampleDoc();
  const first = await renderDoc(pool, doc, { ...all, prev: null, store });
  const second = await renderDoc(pool, doc, { ...all, prev: first.manifest, store });
  expect(second.rendered).toEqual([]);
  expect(second.reused).toHaveLength(3);
  expect(second.manifest).toEqual(first.manifest);
  // Reused renders are copies: the new manifest never shares a levels array with prev.
  expect(renderOf(second, 'home', BASE_KEY).levels).not.toBe(renderOf(first, 'home', BASE_KEY).levels);
});

test('mobile-only edit re-renders only mobile', async () => {
  const doc = sampleDoc();
  const first = await renderDoc(pool, doc, { ...all, prev: null, store });
  const doc2 = must(applyOp(doc, { op: 'setStyle', node: 'n3', device: 'mobile', prop: 'padding', value: '4px' }));
  const second = await renderDoc(pool, doc2, { ...all, prev: first.manifest, store });
  expect(second.rendered).toEqual(['home@390x844']);
  expect(second.reused).toEqual(['home@1440x900', 'home@834x1194']);
});

test('component edit re-renders only pages that use it', async () => {
  const first = await renderDoc(pool, withAbout(), { ...all, prev: null, store });
  const edited = must(applyOp(withAbout(), { op: 'setStyle', node: 'n7', device: 'base', prop: 'color', value: '#ff0000' }));
  const second = await renderDoc(pool, edited, { ...all, prev: first.manifest, store });
  expect(second.rendered).toEqual(['home@1440x900', 'home@390x844', 'home@834x1194']);
  expect(second.reused).toEqual(['about@1440x900', 'about@390x844', 'about@834x1194']);
});

test('pages are ordered by route', async () => {
  const result = await renderDoc(pool, withAbout(), { ...all, prev: null, store });
  expect(result.manifest.pages.map((p) => p.pageId)).toEqual(['home', 'about']);
});

test('failed export keeps the last good render with an error', async () => {
  const first = await renderDoc(pool, sampleDoc(), { ...all, prev: null, store });
  const second = await renderDoc(pool, brokenDoc(), { ...all, prev: first.manifest, store });
  expect(second.failed).toHaveLength(3);
  const prevBase = renderOf(first, 'home', BASE_KEY);
  const base = renderOf(second, 'home', BASE_KEY);
  expect(base.levels).toEqual(prevBase.levels);
  expect(base.levels).not.toBe(prevBase.levels);
  expect(base.hash).toBe(prevBase.hash);
  expect(base.error).toContain('Component Card not found');
});

test('failed export without a previous render gives an empty placeholder', async () => {
  const result = await renderDoc(pool, brokenDoc(), { ...all, prev: null, store });
  expect(result.manifest.pages[0]!.renders[BASE_KEY]).toEqual({
    device: 'base',
    hash: '',
    width: 1440,
    viewportHeight: 900,
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
    size: MOBILE,
    html: exported.value.html,
    css: cssForDevice(exported.value.css, 'mobile'),
  };
  const a = await renderJob(pool, job);
  const b = await renderJob(pool, job);
  expect(a.render).toEqual(b.render);
  expect(a.hitMap).toEqual(b.hitMap);
  expect(a.tiles).toEqual(b.tiles);
});

test('a call that drops a size returns a manifest without it', async () => {
  const first = await renderDoc(pool, sampleDoc(), { ...all, prev: null, store });
  const second = await renderDoc(pool, sampleDoc(), { ...only(BASE, TABLET), prev: first.manifest, store });
  expect(second.rendered).toEqual([]);
  expect(second.reused).toEqual(['home@1440x900', 'home@834x1194']);
  expect(Object.keys(second.manifest.pages[0]!.renders)).toEqual([BASE_KEY, TABLET_KEY]);
});

test('a size absent from prev renders without touching the others', async () => {
  const first = await renderDoc(pool, sampleDoc(), { ...only(TABLET), prev: null, store });
  const second = await renderDoc(pool, sampleDoc(), { ...all, prev: first.manifest, store });
  expect(second.rendered).toEqual(['home@1440x900', 'home@390x844']);
  expect(second.reused).toEqual(['home@834x1194']);
  expect(Object.keys(second.manifest.pages[0]!.renders).sort()).toEqual([BASE_KEY, MOBILE_KEY, TABLET_KEY]);
});

test('a failed render at one size keeps the previous render for that key with an error', async () => {
  const first = await renderDoc(pool, sampleDoc(), { ...all, prev: null, store });
  store.putFails = true;
  const second = await renderDoc(pool, mobileEdited(), { ...all, prev: first.manifest, store });
  expect(second.failed).toEqual(['home@390x844']);
  expect(renderOf(second, 'home', MOBILE_KEY)).toEqual({ ...renderOf(first, 'home', MOBILE_KEY), error: 'disk full' });
});

test('duplicate sizes render once and each size is keyed', async () => {
  const wide: FrameSize = { width: 1600, viewportHeight: 900 };
  const result = await renderDoc(pool, withAbout(), { ...only(wide, wide, MOBILE), prev: null, store });
  expect(result.rendered).toEqual(['about@1600x900', 'about@390x844', 'home@1600x900', 'home@390x844']);
  for (const page of result.manifest.pages) {
    expect(Object.keys(page.renders)).toEqual(['1600x900', '390x844']);
    expect(page.renders['1600x900']).toMatchObject({ width: 1600, viewportHeight: 900, device: 'base' });
  }
  const second = await renderDoc(pool, withAbout(), { ...only(wide, wide, MOBILE), prev: result.manifest, store });
  expect(second.rendered).toEqual([]);
  expect(second.reused).toEqual(result.rendered);
});

test('a prev manifest that is not version 2 is ignored', async () => {
  const first = await renderDoc(pool, sampleDoc(), { ...all, prev: null, store });
  const old = { ...first.manifest, version: 1 } as unknown as RenderManifest;
  const second = await renderDoc(pool, sampleDoc(), { ...all, prev: old, store });
  expect(second.reused).toEqual([]);
  expect(second.rendered).toHaveLength(3);
  expect(second.manifest.version).toBe(2);
});

test('css is reduced for the tier of each width', async () => {
  let doc = sampleDoc();
  for (const [node, device, prop, value] of [
    ['n1', 'base', 'width', '50px'],
    ['n1', 'base', 'height', '50px'],
    ['n1', 'base', 'background-color', '#ff0000'],
    ['n1', 'tablet', 'background-color', '#0000ff'],
  ] as const) {
    doc = must(applyOp(doc, { op: 'setStyle', node, device, prop, value }));
  }
  const exported = exportPage(doc, 'home');
  if (!exported.ok) throw new Error(exported.error);
  const css = exported.value.css;

  // Records the document each capture loads, so the css the job carried is observable.
  const docs: string[] = [];
  const spy = {
    withPage: <T>(fn: (page: Page) => Promise<T>): Promise<T> =>
      pool.withPage((page) => {
        const orig = page.setContent.bind(page);
        page.setContent = (async (html: string, opts?: Parameters<Page['setContent']>[1]) => {
          docs.push(html);
          return orig(html, opts);
        }) as Page['setContent'];
        return fn(page).finally(() => {
          page.setContent = orig;
        });
      }),
  } as unknown as BrowserPool;

  const pixel = async (r: RenderDocResult, key: string): Promise<[number, number, number]> => {
    const level = renderOf(r, 'home', key).levels[2]!;
    const tile = store.files.get(tilePath(level.key, 0, 0));
    const { data } = await sharp(tile as Buffer).raw().toBuffer({ resolveWithObject: true });
    return [data[0]!, data[1]!, data[2]!] as [number, number, number];
  };

  const at1023 = await renderDoc(spy, doc, { ...only({ width: 1023, viewportHeight: 400 }), prev: null, store });
  const at1024 = await renderDoc(spy, doc, { ...only({ width: 1024, viewportHeight: 400 }), prev: null, store });
  expect(docs).toHaveLength(2);
  expect(docs[0]).toContain(cssForDevice(css, 'tablet'));
  expect(docs[0]).toContain('@media (max-width: 1023px)');
  expect(docs[1]).toContain(cssForDevice(css, 'base'));
  expect(docs[1]).not.toContain('@media (max-width: 1023px)');
  expect(renderOf(at1023, 'home', '1023x400').device).toBe('tablet');
  expect(renderOf(at1024, 'home', '1024x400').device).toBe('base');
  const [r1, g1, b1] = await pixel(at1023, '1023x400');
  // Tiles are lossy WebP, so compare channel dominance instead of exact colors.
  expect(b1).toBeGreaterThan(r1 + 40);
  expect(b1).toBeGreaterThan(g1 + 40);
  const [r2, g2, b2] = await pixel(at1024, '1024x400');
  expect(r2).toBeGreaterThan(b2 + 40);
  expect(r2).toBeGreaterThan(g2 + 40);
});

test('pages that left the doc are not carried over', async () => {
  const first = await renderDoc(pool, withAbout(), { ...all, prev: null, store });
  const result = await renderDoc(pool, sampleDoc(), { ...only(MOBILE), prev: first.manifest, store });
  expect(result.manifest.pages.map((p) => p.pageId)).toEqual(['home']);
});

test('reused render has no error property', async () => {
  const first = await renderDoc(pool, sampleDoc(), { ...all, prev: null, store });
  const failedRun = await renderDoc(pool, brokenDoc(), { ...all, prev: first.manifest, store });
  expect(failedRun.failed).toHaveLength(3);
  const back = await renderDoc(pool, sampleDoc(), { ...all, prev: failedRun.manifest, store });
  expect(back.reused).toEqual(['home@1440x900', 'home@390x844', 'home@834x1194']);
  for (const key of [BASE_KEY, TABLET_KEY, MOBILE_KEY]) {
    expect(renderOf(back, 'home', key)).not.toHaveProperty('error');
  }
});

test('re-renders a device when a prev level is missing from the store', async () => {
  const first = await renderDoc(pool, sampleDoc(), { ...all, prev: null, store });
  store.missing.add(renderOf(first, 'home', BASE_KEY).levels[0]!.key);
  const second = await renderDoc(pool, sampleDoc(), { ...all, prev: first.manifest, store });
  expect(second.rendered).toEqual(['home@1440x900']);
  expect(second.reused).toEqual(['home@390x844', 'home@834x1194']);
});

test('a hasLevel error counts as a miss and re-renders', async () => {
  const first = await renderDoc(pool, sampleDoc(), { ...all, prev: null, store });
  store.hasLevelFailures = 1;
  const second = await renderDoc(pool, sampleDoc(), { ...all, prev: first.manifest, store });
  expect(second.failed).toEqual([]);
  expect(second.rendered).toEqual(['home@1440x900']);
  expect(second.reused).toEqual(['home@390x844', 'home@834x1194']);
  expect(renderOf(second, 'home', BASE_KEY)).toEqual(renderOf(first, 'home', BASE_KEY));
});

test('a failed tile write falls back to the last good render', async () => {
  const first = await renderDoc(pool, sampleDoc(), { ...all, prev: null, store });
  store.putFails = true;
  const second = await renderDoc(pool, mobileEdited(), { ...all, prev: first.manifest, store });
  expect(second.failed).toEqual(['home@390x844']);
  expect(second.reused).toEqual(['home@1440x900', 'home@834x1194']);
  expect(renderOf(second, 'home', MOBILE_KEY)).toEqual({ ...renderOf(first, 'home', MOBILE_KEY), error: 'disk full' });
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
  const result = await renderDoc(stub, withAbout(), { ...all, prev: null, store, concurrency: 2 });
  expect(maxInFlight).toBe(2);
  expect(result.failed).toHaveLength(6);
  expect(result.rendered).toEqual([]);
});
