// Where the canvas keeps its frame layout. The hub stores it per app
// (ServerFrameStore in net/frame-store.ts); MemoryFrameStore serves the dev
// harness and tests with the default layout of a manifest. Preview canvases
// get stores that never save: previewFrameStore lays out exactly the sizes a
// preview manifest was rendered at, and readOnlyFrameStore shows a stored
// layout without writing to it.

import { DEFAULT_FRAME_SIZES, FRAME_GAP, ROW_GAP, defaultFrames, parseSizeKey, sizeKey } from '@hub/protocol';
import type { CanvasFrame, FrameSize, RenderManifest } from '@hub/protocol';

/**
 * A loaded layout. `provisional` means the store placed some frames without knowing their pages'
 * heights and did not keep them; the canvas asks again when a new manifest arrives.
 */
export interface FrameLayout {
  frames: CanvasFrame[];
  provisional?: boolean;
}

export interface FrameStore {
  load(): Promise<FrameLayout>;
  /** Replaces the whole layout; resolves with the layout as stored. */
  save(frames: readonly CanvasFrame[]): Promise<CanvasFrame[]>;
}

/** A frame id in the protocol format: f and 16 lowercase hex characters. */
export function randomFrameId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return 'f' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** How tall a page is at a size: its render's height, at least the viewport. */
export function frameHeightIn(m: RenderManifest, pageId: string, size: FrameSize): number {
  const r = m.pages.find((p) => p.pageId === pageId)?.renders[sizeKey(size)];
  return Math.max(r?.height ?? 0, size.viewportHeight);
}

export class MemoryFrameStore implements FrameStore {
  private readonly manifest: Promise<RenderManifest>;
  private readonly newId: () => string;
  private frames: CanvasFrame[] | null = null;

  constructor(manifest: RenderManifest | PromiseLike<RenderManifest>, newId: () => string = randomFrameId) {
    this.manifest = Promise.resolve(manifest);
    this.newId = newId;
  }

  async load(): Promise<FrameLayout> {
    if (this.frames === null) {
      const m = await this.manifest;
      this.frames ??= defaultFrames(m.pages, [], (pageId, size) => frameHeightIn(m, pageId, size), this.newId);
    }
    return { frames: this.frames.map((f) => ({ ...f })) };
  }

  async save(frames: readonly CanvasFrame[]): Promise<CanvasFrame[]> {
    this.frames = frames.map((f) => ({ ...f }));
    return this.frames.map((f) => ({ ...f }));
  }
}

/**
 * A preview manifest's own layout: one row per page, one frame per size the page was rendered at
 * (widest first), so the preview shows what was rendered rather than sizes it lacks. A page with no
 * renders at all gets the default sizes. Saves are ignored.
 */
export function previewFrameStore(m: RenderManifest, newId: () => string = randomFrameId): FrameStore {
  const frames: CanvasFrame[] = [];
  let y = 0;
  for (const page of m.pages) {
    const rendered = Object.keys(page.renders)
      .map(parseSizeKey)
      .filter((s): s is FrameSize => s !== null)
      .sort((a, b) => b.width - a.width || b.viewportHeight - a.viewportHeight);
    let x = 0;
    let rowHeight = 0;
    for (const size of rendered.length > 0 ? rendered : DEFAULT_FRAME_SIZES) {
      frames.push({ id: newId(), pageId: page.pageId, x, y, width: size.width, viewportHeight: size.viewportHeight });
      x += size.width + FRAME_GAP;
      rowHeight = Math.max(rowHeight, frameHeightIn(m, page.pageId, size));
    }
    y += rowHeight + ROW_GAP;
  }
  return {
    load: async () => ({ frames: frames.map((f) => ({ ...f })) }),
    save: async (next) => next.map((f) => ({ ...f })),
  };
}

/** `store`'s layout, shown without ever being written back. */
export function readOnlyFrameStore(store: FrameStore): FrameStore {
  return {
    load: () => store.load(),
    save: async (next) => next.map((f) => ({ ...f })),
  };
}
