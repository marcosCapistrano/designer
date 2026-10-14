import { join } from 'node:path';
import type { DesignDoc } from '@hub/design-model';
import { FsSyncStore, discoverNextRoutes, synchronizePages, type SyncStore } from '@hub/sync';
import { APP_NAME_RE } from '@hub/protocol/manifest';
import type { DesignSummary, ImportRequest, ImportResponse, RenderManifest } from '@hub/protocol';
import { BrowserPool, FsTileStore, renderDoc } from '@hub/renderer';
import type { AppRegistry } from '../apps/registry.js';
import { BuildError } from '../build/ci.js';
import type { BuildService } from '../build/service.js';
import type { WsHub } from '../ws/hub.js';
import { renderDir } from '../design/render-files.js';
import { readSourceProject } from './source.js';

export interface SyncDeps {
  registry: Pick<AppRegistry, 'get'>;
  build: Pick<BuildService, 'withCheckout'>;
  hub: WsHub;
  dataDir: string;
  readSource?: typeof readSourceProject;
  store?: (app: string) => SyncStore;
  render?: (app: string, doc: DesignDoc) => Promise<{ manifest: RenderManifest; warnings: string[] }>;
}
export class SyncService {
  private readonly stores = new Map<string, SyncStore>();
  private readonly pool = new BrowserPool();
  constructor(private readonly deps: SyncDeps) {}
  async close(): Promise<void> { await this.pool.close(); }
  async load(app: string) { await this.entry(app); return this.store(app).load(); }
  async save(app: string, state: import('@hub/sync').SyncState, revision: string | null) { await this.entry(app); return this.store(app).save(state, revision); }
  async source(app: string, request: ImportRequest) {
    const entry = await this.entry(app);
    const source = await (this.deps.readSource ?? readSourceProject)(entry.dir);
    const appDir = request.mode === 'next' ? request.appDir ?? (Object.keys(source.project.files).some((file) => file.startsWith('src/app/')) ? 'src/app' : 'app') : '';
    const entries = request.mode === 'react' ? request.entries : discoverNextRoutes(source.project, appDir);
    if (!entries.length) throw new Error('No page routes found. Choose a React entry file or the Next app directory.');
    return { ...source, entries };
  }
  private store(app: string): SyncStore {
    let store = this.stores.get(app);
    if (!store) { store = this.deps.store?.(app) ?? new FsSyncStore(join(this.deps.dataDir, 'design', app)); this.stores.set(app, store); }
    return store;
  }
  private async entry(app: string) {
    const entry = APP_NAME_RE.test(app) ? await this.deps.registry.get(app) : null;
    if (!entry) throw new BuildError('Unknown app', 404);
    return entry;
  }
  async summary(app: string): Promise<DesignSummary> {
    await this.entry(app);
    const saved = await this.store(app).load();
    return { imported: saved !== null, revision: saved?.revision ?? null, pages: Object.values(saved?.state.doc.pages ?? {}).map(({ id, route, name }) => ({ id, route, name })), pending: saved?.state.pending.length ?? 0 };
  }
  async import(app: string, request: ImportRequest): Promise<ImportResponse> {
    return this.deps.build.withCheckout(app, async () => {
      await this.entry(app);
      const previous = await this.store(app).load();
      let source: Awaited<ReturnType<SyncService['source']>>;
      try {
        source = await this.source(app,request);
      } catch (error) { return { ok: false, kind: 'source', diagnostics: [{ file: '', message: error instanceof Error ? error.message : 'Source could not be read' }] }; }
      const prepared = synchronizePages({ ...source, previous: previous?.state });
      if (!prepared.ok) return prepared;
      const revision = await this.store(app).save(prepared.state, previous?.revision ?? null);
      const preview = await this.preview(app, prepared.state.doc);
      return { ok: true, revision, rebuilt: prepared.rebuilt, reused: prepared.reused, removed: prepared.removed, ...preview };
    });
  }
  async preview(app: string, doc: DesignDoc, publish = true): Promise<{ manifest: RenderManifest | null; warnings: string[] }> {
    try {
      if (this.deps.render) {
        const out = await this.deps.render(app, doc);
        if (publish) this.deps.hub.broadcast({ type: 'render.ready', app, manifest: out.manifest });
        return out;
      }
      const store = new FsTileStore(renderDir(this.deps.dataDir, app));
      const out = await renderDoc(this.pool, doc, { devices: ['base', 'tablet', 'mobile'], prev: await store.readManifest(), store });
      if (publish) {
        await store.writeManifest(out.manifest);
        this.deps.hub.broadcast({ type: 'render.ready', app, manifest: out.manifest });
      }
      return { manifest: out.manifest, warnings: out.failed.map((key) => `Preview failed for ${key}; the last good image is retained.`) };
    } catch { return { manifest: null, warnings: ['Design saved. Preview could not be updated; retry the preview.'] }; }
  }
  async retryPreview(app: string) {
    return this.deps.build.withCheckout(app, async () => {
      await this.entry(app);
      const saved = await this.store(app).load();
      if (!saved) throw new BuildError('Import pages first.', 409);
      return this.preview(app, saved.state.doc);
    });
  }
}
