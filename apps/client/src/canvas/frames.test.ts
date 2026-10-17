import { describe, expect, it } from 'vitest';
import type { CanvasFrame, PageRender, RenderManifest } from '@hub/protocol';
import { MemoryFrameStore, previewFrameStore, readOnlyFrameStore } from './frames.js';
import type { FrameStore } from './frames.js';
import { framesFor, sequentialIds } from './test-utils.js';

const render = (height: number): PageRender => ({ device: 'base', hash: 'h', width: 1440, viewportHeight: 900, height, levels: [] });
const M: RenderManifest = {
  version: 2,
  pages: [
    { pageId: 'p1', name: 'Home', route: '/', renders: { '1440x900': render(2000) } },
    { pageId: 'p2', name: 'About', route: '/about', renders: {} },
  ],
};

describe('MemoryFrameStore', () => {
  it('loads the default layout of the manifest it was given', async () => {
    const store = new MemoryFrameStore(M, sequentialIds());
    const { frames } = await store.load();
    expect(frames).toEqual(framesFor(M));
    // Page rows sit below the tallest frame of the row above.
    expect(frames.filter((f) => f.pageId === 'p2').map((f) => f.y)).toEqual([2200, 2200, 2200]);
  });

  it('accepts a manifest that is still loading', async () => {
    const store = new MemoryFrameStore(Promise.resolve(M), sequentialIds());
    expect(await store.load()).toEqual({ frames: framesFor(M) });
  });

  it('save keeps the whole layout and returns it; later loads return it', async () => {
    const store = new MemoryFrameStore(M, sequentialIds());
    const {
      frames: [first],
    } = await store.load();
    const next: CanvasFrame[] = [{ ...first!, x: 64 }];
    const saved = await store.save(next);
    expect(saved).toEqual(next);
    next[0]!.x = 999;
    expect((await store.load()).frames).toEqual([{ ...first!, x: 64 }]);
  });

  it('makes frame ids in the protocol format by default', async () => {
    const { frames } = await new MemoryFrameStore(M).load();
    for (const f of frames) expect(f.id).toMatch(/^f[0-9a-f]{16}$/);
    expect(new Set(frames.map((f) => f.id)).size).toBe(frames.length);
  });
});

describe('previewFrameStore', () => {
  const r = (width: number, viewportHeight: number, height: number): PageRender => ({ device: 'base', hash: `h${width}`, width, viewportHeight, height, levels: [] });
  const P: RenderManifest = {
    version: 2,
    pages: [
      { pageId: 'p1', name: 'Home', route: '/', renders: { '390x844': r(390, 844, 3000), '1600x900': r(1600, 900, 1200) } },
      { pageId: 'p2', name: 'About', route: '/about', renders: { '1600x900': r(1600, 900, 0) } },
      { pageId: 'p3', name: 'New', route: '/new', renders: {} },
    ],
  };

  it('lays out one frame per rendered size of each page, widest first, rows below the tallest render', async () => {
    const { frames } = await previewFrameStore(P, sequentialIds()).load();
    const sizes = (pageId: string) => frames.filter((f) => f.pageId === pageId).map((f) => [f.x, f.y, f.width, f.viewportHeight]);
    expect(sizes('p1')).toEqual([
      [0, 0, 1600, 900],
      [1680, 0, 390, 844],
    ]);
    expect(sizes('p2')).toEqual([[0, 3200, 1600, 900]]);
    // A page with no renders at all gets the default sizes.
    expect(sizes('p3').map(([, y, w]) => [y, w])).toEqual([
      [4300, 1440],
      [4300, 834],
      [4300, 390],
    ]);
  });

  it('never stores a change', async () => {
    const store = previewFrameStore(P, sequentialIds());
    const { frames } = await store.load();
    await store.save([{ ...frames[0]!, x: 999 }]);
    expect((await store.load()).frames).toEqual(frames);
  });
});

describe('readOnlyFrameStore', () => {
  it('loads from the store it wraps and never saves to it', async () => {
    const frame: CanvasFrame = { id: 'f0123456789abcdef', pageId: 'p1', x: 0, y: 0, width: 1440, viewportHeight: 900 };
    const saves: unknown[] = [];
    const inner: FrameStore = { load: async () => ({ frames: [frame], provisional: true }), save: async (f) => (saves.push(f), [...f]) };
    const store = readOnlyFrameStore(inner);
    expect(await store.load()).toEqual({ frames: [frame], provisional: true });
    expect(await store.save([{ ...frame, x: 8 }])).toEqual([{ ...frame, x: 8 }]);
    expect(saves).toEqual([]);
  });
});
