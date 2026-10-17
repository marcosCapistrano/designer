// Where the canvas keeps its frame layout. The hub stores it per app
// (ServerFrameStore in net/frame-store.ts); MemoryFrameStore serves the dev
// harness and tests with the default layout of a manifest.

import { defaultFrames, sizeKey } from '@hub/protocol';
import type { CanvasFrame, FrameSize, RenderManifest } from '@hub/protocol';

export interface FrameStore {
  load(): Promise<CanvasFrame[]>;
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

  async load(): Promise<CanvasFrame[]> {
    if (this.frames === null) {
      const m = await this.manifest;
      this.frames ??= defaultFrames(m.pages, [], (pageId, size) => frameHeightIn(m, pageId, size), this.newId);
    }
    return this.frames.map((f) => ({ ...f }));
  }

  async save(frames: readonly CanvasFrame[]): Promise<CanvasFrame[]> {
    this.frames = frames.map((f) => ({ ...f }));
    return this.frames.map((f) => ({ ...f }));
  }
}
