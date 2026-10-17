import { createHash } from 'node:crypto';
import { DEFAULT_FRAME_SIZES, defaultFrames, sizeKey, validateFrames, type CanvasFrame, type FrameSize, type RenderManifest } from '@hub/protocol';
import type { Db } from '../db.js';

export interface CanvasFramesDeps {
  db: Db;
  /** The pages of the saved design in order, or null when nothing is imported. */
  pages: (app: string) => Promise<{ pageId: string }[] | null>;
  /** The published v2 manifest, or null (none yet, or an older version whose heights are not usable). */
  manifest: (app: string) => Promise<RenderManifest | null>;
}

/** A layout and whether it is provisional: some default frames were placed without known render heights and were not saved. */
export interface FrameLayout { frames: CanvasFrame[]; provisional: boolean }

// Code-point order (UTF-8 byte order), as in the renderer; UTF-16 unit order differs.
function byCodePoint(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A design's pages in the order default rows stack: by route, then id, as the renderer orders them. */
export function pagesInRouteOrder(pages: Record<string, { id: string; route: string }>): { pageId: string }[] {
  return Object.values(pages)
    .sort((a, b) => byCodePoint(a.route, b.route) || byCodePoint(a.id, b.id))
    .map(({ id }) => ({ pageId: id }));
}

/** A default frame's id, the same every time the page is laid out, so a provisional layout keeps its ids once it is saved. */
function defaultFrameId(pageId: string, size: FrameSize): string {
  return 'f' + createHash('sha256').update(`${pageId}\0${sizeKey(size)}`).digest('hex').slice(0, 16);
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

  /**
   * The saved layout plus default frames for pages that have none. Defaults are stacked from the
   * render heights in the v2 manifest; while any height they depend on is unknown (no manifest, a v1
   * manifest, or a page not rendered at that size yet) they are returned but not saved, and the layout
   * is marked provisional so the client asks again once renders land. Saving them with guessed
   * heights would persist overlapping rows, because saved positions are never re-stacked.
   */
  async list(app: string): Promise<FrameLayout> {
    const pages = await this.deps.pages(app);
    if (!pages) return { frames: [], provisional: false };
    const ids = new Set(pages.map((p) => p.pageId));
    const saved = this.load(app);
    const kept = saved.filter((f) => ids.has(f.pageId));
    const manifest = await this.deps.manifest(app);
    const heights = new Map<string, number>();
    if (manifest?.version === 2) {
      for (const page of manifest.pages) for (const [key, render] of Object.entries(page.renders)) heights.set(`${page.pageId}/${key}`, render.height);
    }
    let guessed = false;
    const heightOf = (pageId: string, size: FrameSize) => {
      const h = heights.get(`${pageId}/${sizeKey(size)}`);
      if (h === undefined) guessed = true;
      return Math.max(h ?? 0, size.viewportHeight);
    };
    const all = defaultFrames(pages, kept, heightOf, () => '');
    for (let i = kept.length; i < all.length; i++) all[i] = { ...all[i]!, id: defaultFrameId(all[i]!.pageId, all[i]!) };
    const added = all.length !== kept.length;
    const provisional = added && guessed;
    if (provisional) {
      if (kept.length !== saved.length) this.save(app, kept);
    } else if (kept.length !== saved.length || added) this.save(app, all);
    const order = new Map(pages.map((p, i) => [p.pageId, i]));
    return { frames: [...all].sort((a, b) => order.get(a.pageId)! - order.get(b.pageId)! || a.x - b.x), provisional };
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
