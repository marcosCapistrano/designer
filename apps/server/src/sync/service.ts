import { join } from 'node:path';
import type { DesignDoc } from '@hub/design-model';
import { ADAPTERS_FILE, FsSyncStore, countSourceOnly, discoverNextRoutes, projectAliases, synchronizePages, type SyncResult, type SyncState, type SyncStore } from '@hub/sync';
import { APP_MANIFEST_FILE, APP_NAME_RE, routeIncluded } from '@hub/protocol/manifest';
import { parseAdapters } from '@hub/protocol/adapters';
import { DEFAULT_FRAME_SIZES, type DesignSummary, ImportRequest, ImportResponse, type RenderManifest } from '@hub/protocol';
import { BrowserPool, FsTileStore, renderDoc } from '@hub/renderer';
import type { AppRegistry } from '../apps/registry.js';
import { BuildError } from '../build/ci.js';
import type { BuildService } from '../build/service.js';
import type { WsHub } from '../ws/hub.js';
import { renderDir } from '../design/render-files.js';
import { readSourceProject } from './source.js';

/** Import configuration that cannot be used; the diagnostic names the file. */
export class SourceConfigError extends Error { constructor(readonly file: string, message: string) { super(message); } }
/** The applied-import response for a successful preparation that was saved as `revision`. */
export function importApplied(prepared: Extract<SyncResult, { ok: true }>, revision: string, preview: { manifest: RenderManifest | null; warnings: string[] }): ImportResponse {
  const { rebuilt, reused, removed, failed, inlined, sourceOnlyRules } = prepared;
  return { ok: true, revision, rebuilt, reused, removed, failed, inlined, sourceOnlyRules, ...preview };
}
/** What the saved design's latest import reported, over the routes it extracted (kept previous versions excluded). */
function importFacts(state: SyncState | undefined): Pick<DesignSummary, 'sourceOnlyRules' | 'inlined'> {
  return { sourceOnlyRules: countSourceOnly(Object.values(state?.baseline.pages ?? {})), inlined: state?.baseline.inlined ?? [] };
}
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
  async save(app: string, state: SyncState, revision: string | null) { await this.entry(app); return this.store(app).save(state, revision); }
  async source(app: string, request: ImportRequest) {
    const entry = await this.entry(app);
    const source = await (this.deps.readSource ?? readSourceProject)(entry.dir);
    const { files } = source.project, config = source.config ?? {};
    const design = entry.manifest?.design;
    const hasDir = (dir: string) => Object.keys(files).some((file) => file.startsWith(`${dir}/`));
    // R8: the manifest's design.routes names the Next app directory when the request does not.
    const appDir = request.mode === 'next' ? request.appDir ?? (design && hasDir(design.routes) ? design.routes : hasDir('src/app') ? 'src/app' : 'app') : '';
    const include = design?.include;
    const entries = request.mode === 'react' ? request.entries.filter((item) => routeIncluded(include, item.route)) : discoverNextRoutes(source.project, appDir, include);
    if (!entries.length) {
      if (include) throw new SourceConfigError(APP_MANIFEST_FILE, `No page routes match design.include (${include.join(', ')}).`);
      throw new Error('No page routes found. Choose a React entry file or the Next app directory.');
    }
    const aliases = projectAliases(config, request.mode === 'next' ? appDir : entries[0]!.file.split('/').slice(0, -1).join('/'));
    if (!aliases.ok) throw new SourceConfigError(aliases.diagnostic.file, aliases.diagnostic.message);
    let adapters;
    if (Object.hasOwn(config, ADAPTERS_FILE)) {
      const parsed = parseAdapters(config[ADAPTERS_FILE]!);
      if (!parsed.ok) throw new SourceConfigError(ADAPTERS_FILE, parsed.error);
      adapters = parsed.adapters;
    }
    const project = { files, ...(Object.keys(aliases.aliases).length ? { aliases: aliases.aliases } : {}), ...(adapters ? { adapters } : {}) };
    return { project, commit: source.commit, entries };
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
    return { imported: saved !== null, revision: saved?.revision ?? null, pages: Object.values(saved?.state.doc.pages ?? {}).map(({ id, route, name }) => ({ id, route, name })), pending: saved?.state.pending.length ?? 0, ...importFacts(saved?.state) };
  }
  async import(app: string, request: ImportRequest): Promise<ImportResponse> {
    return this.deps.build.withCheckout(app, async () => {
      await this.entry(app);
      const previous = await this.store(app).load();
      let source: Awaited<ReturnType<SyncService['source']>>;
      try {
        source = await this.source(app,request);
      } catch (error) { return { ok: false, kind: 'source', diagnostics: [{ file: error instanceof SourceConfigError ? error.file : '', message: error instanceof Error ? error.message : 'Source could not be read' }] }; }
      const prepared = synchronizePages({ ...source, previous: previous?.state });
      if (!prepared.ok) return prepared;
      const revision = await this.store(app).save(prepared.state, previous?.revision ?? null);
      const preview = await this.preview(app, prepared.state.doc);
      return importApplied(prepared, revision, preview);
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
      const out = await renderDoc(this.pool, doc, { sizes: () => DEFAULT_FRAME_SIZES, prev: await store.readManifest(), store });
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
