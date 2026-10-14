// Public API of the canvas module.
//
// Cache ownership: a BlobCache passed to CanvasView must serve exactly one
// manifest's tiles and hit maps. After each manifest loads, CanvasView calls
// cache.gc with that manifest's keys, which deletes every other entry. Tile
// keys are content-addressed, so sharing one cache across apps looks harmless
// but is not: opening app B would delete app A's tiles. Create one cache per
// app with createIdbCache(name) and pass a distinct name for each.
export { CanvasView } from './CanvasView.js';
export type { CanvasViewProps, HubCanvasDebug } from './CanvasView.js';
export { StaticTileSource } from './source.js';
export type { TileSource } from './source.js';
export { createIdbCache, createNullCache } from './cache.js';
export type { BlobCache } from './cache.js';
