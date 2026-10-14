import { MANIFEST_PATH, hitMapPath, tilePath, type HitBox, type RenderManifest } from '@hub/protocol';

/** Where the canvas gets manifests, tiles and hit maps. Plan 3 replaces the static implementation with a server-backed one. */
export interface TileSource {
  manifest(): Promise<RenderManifest>;
  tile(key: string, x: number, y: number): Promise<Blob>;
  hitMap(hash: string): Promise<HitBox[]>;
  /** Live updates (render.ready); returns unsubscribe. */
  subscribe(onManifest: (m: RenderManifest) => void): () => void;
}

/** Serves a pre-rendered output directory over HTTP. */
export class StaticTileSource implements TileSource {
  private readonly base: string;
  private readonly fetchFn: (url: string) => Promise<Response>;

  constructor(baseUrl: string, fetchFn: (url: string) => Promise<Response> = (url) => fetch(url)) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.fetchFn = fetchFn;
  }

  async manifest(): Promise<RenderManifest> {
    const res = await this.get(this.url(MANIFEST_PATH));
    return (await res.json()) as RenderManifest;
  }

  async tile(key: string, x: number, y: number): Promise<Blob> {
    const res = await this.get(this.url(tilePath(key, x, y)));
    return res.blob();
  }

  async hitMap(hash: string): Promise<HitBox[]> {
    const res = await this.get(this.url(hitMapPath(hash)));
    return (await res.json()) as HitBox[];
  }

  subscribe(_onManifest: (m: RenderManifest) => void): () => void {
    return () => {};
  }

  private url(path: string): string {
    return `${this.base}/${path}`;
  }

  private async get(url: string): Promise<Response> {
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
  }
}
