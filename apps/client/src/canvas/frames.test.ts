import { describe, expect, it } from 'vitest';
import type { CanvasFrame, PageRender, RenderManifest } from '@hub/protocol';
import { MemoryFrameStore } from './frames.js';
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
    const frames = await store.load();
    expect(frames).toEqual(framesFor(M));
    // Page rows sit below the tallest frame of the row above.
    expect(frames.filter((f) => f.pageId === 'p2').map((f) => f.y)).toEqual([2200, 2200, 2200]);
  });

  it('accepts a manifest that is still loading', async () => {
    const store = new MemoryFrameStore(Promise.resolve(M), sequentialIds());
    expect(await store.load()).toEqual(framesFor(M));
  });

  it('save keeps the whole layout and returns it; later loads return it', async () => {
    const store = new MemoryFrameStore(M, sequentialIds());
    const [first] = await store.load();
    const next: CanvasFrame[] = [{ ...first!, x: 64 }];
    const saved = await store.save(next);
    expect(saved).toEqual(next);
    next[0]!.x = 999;
    expect(await store.load()).toEqual([{ ...first!, x: 64 }]);
  });

  it('makes frame ids in the protocol format by default', async () => {
    const frames = await new MemoryFrameStore(M).load();
    for (const f of frames) expect(f.id).toMatch(/^f[0-9a-f]{16}$/);
    expect(new Set(frames.map((f) => f.id)).size).toBe(frames.length);
  });
});
