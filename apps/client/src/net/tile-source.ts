import type { HitBox, RenderManifest, ServerMsg } from '@hub/protocol';
import { StaticTileSource, type TileSource } from '../canvas/source.js';
import type { WsClient } from './ws.js';

export function renderBase(app: string): string {
  return `/api/apps/${encodeURIComponent(app)}/render`;
}

export interface ServerTileSourceOptions {
  fetchFn?: (url: string) => Promise<Response>;
  /** Called when the hub answers a render file with 401, so an expired session sends the user to login. */
  onUnauthorized?: () => void;
}

/** Serves one app's renders from the hub, and forwards its render.ready messages. */
export class ServerTileSource implements TileSource {
  private readonly app: string;
  private readonly ws: Pick<WsClient, 'on'>;
  private readonly files: StaticTileSource;

  constructor(app: string, ws: Pick<WsClient, 'on'>, opts: ServerTileSourceOptions = {}) {
    this.app = app;
    this.ws = ws;
    const fetchFn = opts.fetchFn ?? ((url: string) => fetch(url));
    this.files = new StaticTileSource(renderBase(app), async (url) => {
      const res = await fetchFn(url);
      if (res.status === 401) opts.onUnauthorized?.();
      return res;
    });
  }

  manifest(): Promise<RenderManifest> {
    return this.files.manifest();
  }

  tile(key: string, x: number, y: number): Promise<Blob> {
    return this.files.tile(key, x, y);
  }

  hitMap(hash: string): Promise<HitBox[]> {
    return this.files.hitMap(hash);
  }

  subscribe(onManifest: (m: RenderManifest) => void): () => void {
    return this.ws.on((msg: ServerMsg) => {
      if (msg.type === 'render.ready' && msg.app === this.app) onManifest(msg.manifest);
    });
  }
}
