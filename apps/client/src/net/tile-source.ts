import type { HitBox, RenderManifest, ServerMsg } from '@hub/protocol';
import { StaticTileSource, type TileSource } from '../canvas/source.js';
import type { WsClient } from './ws.js';

export function renderBase(app: string): string {
  return `/api/apps/${encodeURIComponent(app)}/render`;
}

/** Serves one app's renders from the hub, and forwards its render.ready messages. */
export class ServerTileSource implements TileSource {
  private readonly app: string;
  private readonly ws: Pick<WsClient, 'on'>;
  private readonly files: StaticTileSource;

  constructor(app: string, ws: Pick<WsClient, 'on'>, fetchFn?: (url: string) => Promise<Response>) {
    this.app = app;
    this.ws = ws;
    this.files = new StaticTileSource(renderBase(app), fetchFn);
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
