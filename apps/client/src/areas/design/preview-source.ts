import type { RenderManifest } from '@hub/protocol';
import type { TileSource } from '../../canvas/source.js';

/** A fixed proposal manifest over the live source's tiles and hit maps. A preview never receives updates. */
export function proposalSource(manifest: RenderManifest, live: TileSource): TileSource {
  return { manifest: async () => manifest, tile: (key, x, y) => live.tile(key, x, y), hitMap: (hash) => live.hitMap(hash), subscribe: () => () => {} };
}
