import { randomBytes } from 'node:crypto';
import { DEFAULT_FRAME_SIZES, defaultFrames, sizeKey, validateFrames, type CanvasFrame, type FrameSize, type RenderManifest } from '@hub/protocol';
import type { Db } from '../db.js';

export interface CanvasFramesDeps {
  db: Db;
  /** The pages of the saved design in order, or null when nothing is imported. */
  pages: (app: string) => Promise<{ pageId: string }[] | null>;
  manifest: (app: string) => Promise<RenderManifest | null>;
  newId?: () => string;
}
interface Row { id: string; page_id: string; x: number; y: number; width: number; viewport_height: number }

/** Per-app canvas frame layout: stored in SQLite, validated against the saved design's pages. */
export class CanvasFrames {
  constructor(private readonly deps: CanvasFramesDeps) {}

  private load(app: string): CanvasFrame[] {
    const rows = this.deps.db.prepare('SELECT id, page_id, x, y, width, viewport_height FROM canvas_frames WHERE app = ? ORDER BY rowid').all(app) as Row[];
    return rows.map((r) => ({ id: r.id, pageId: r.page_id, x: r.x, y: r.y, width: r.width, viewportHeight: r.viewport_height }));
  }
  private save(app: string, frames: readonly CanvasFrame[]): void {
    const { db } = this.deps;
    const insert = db.prepare('INSERT INTO canvas_frames (app, id, page_id, x, y, width, viewport_height) VALUES (?, ?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      db.prepare('DELETE FROM canvas_frames WHERE app = ?').run(app);
      for (const f of frames) insert.run(app, f.id, f.pageId, f.x, f.y, f.width, f.viewportHeight);
    })();
  }

  async list(app: string): Promise<CanvasFrame[]> {
    const pages = await this.deps.pages(app);
    if (!pages) return [];
    const ids = new Set(pages.map((p) => p.pageId));
    const saved = this.load(app);
    const kept = saved.filter((f) => ids.has(f.pageId));
    const manifest = await this.deps.manifest(app);
    const heights = new Map<string, number>();
    for (const page of manifest?.pages ?? []) for (const [key, render] of Object.entries(page.renders)) heights.set(`${page.pageId}/${key}`, render.height);
    const heightOf = (pageId: string, size: FrameSize) => heights.get(`${pageId}/${sizeKey(size)}`) ?? size.viewportHeight;
    const newId = this.deps.newId ?? (() => 'f' + randomBytes(8).toString('hex'));
    const all = defaultFrames(pages, kept, heightOf, newId);
    if (kept.length !== saved.length || all.length !== kept.length) this.save(app, all);
    const order = new Map(pages.map((p, i) => [p.pageId, i]));
    return [...all].sort((a, b) => order.get(a.pageId)! - order.get(b.pageId)! || a.x - b.x);
  }

  async replace(app: string, frames: unknown): Promise<{ ok: true; frames: CanvasFrame[] } | { ok: false; error: string }> {
    const pages = (await this.deps.pages(app)) ?? [];
    const result = validateFrames(frames, new Set(pages.map((p) => p.pageId)));
    if (!result.ok) return result;
    this.save(app, result.frames);
    return result;
  }

  async sizesByPage(app: string): Promise<(pageId: string) => readonly FrameSize[]> {
    const byPage = new Map<string, Map<string, FrameSize>>();
    for (const f of this.load(app)) {
      const sizes = byPage.get(f.pageId) ?? new Map<string, FrameSize>();
      const size = { width: f.width, viewportHeight: f.viewportHeight };
      if (!sizes.has(sizeKey(size))) sizes.set(sizeKey(size), size);
      byPage.set(f.pageId, sizes);
    }
    return (pageId) => (byPage.has(pageId) ? [...byPage.get(pageId)!.values()] : DEFAULT_FRAME_SIZES);
  }

  async missingRenders(app: string, manifest: RenderManifest | null): Promise<boolean> {
    if (!manifest || manifest.version !== 2) return true;
    const pages = (await this.deps.pages(app)) ?? [];
    const sizesOf = await this.sizesByPage(app);
    const renders = new Map(manifest.pages.map((p) => [p.pageId, p.renders]));
    return pages.some(({ pageId }) => sizesOf(pageId).some((size) => !renders.get(pageId)?.[sizeKey(size)]));
  }
}
