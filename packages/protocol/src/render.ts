export type Device = 'base' | 'tablet' | 'mobile';
export const DEVICES: readonly Device[] = ['base', 'tablet', 'mobile'];
export const DEVICE_WIDTH: Readonly<Record<Device, number>> = { base: 1440, tablet: 834, mobile: 390 };
/** Minimum page height and the browser viewport height used while rendering. */
export const DEVICE_VIEWPORT_HEIGHT: Readonly<Record<Device, number>> = { base: 900, tablet: 1194, mobile: 844 };
export const DEVICE_LABEL: Readonly<Record<Device, string>> = { base: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' };
export type Zoom = 0.25 | 0.5 | 1;
export const ZOOMS: readonly Zoom[] = [0.25, 0.5, 1];
export const TILE_SIZE = 512;
export const MAX_PAGE_HEIGHT = 16000;
export const MANIFEST_PATH = 'manifest.json';

/** Page CSS px at zoom 1. nodeId is the element's data-d-id (instance internals look like "n5/n6"). */
export interface HitBox { nodeId: string; x: number; y: number; w: number; h: number }
export interface TileLevel { zoom: Zoom; key: string; cols: number; rows: number }
/**
 * hash = the zoom-1 level key; it also names the hit map file.
 * Never rendered successfully: hash '', height 0, levels [].
 * error is set when the latest render failed; levels/hash are then the last good ones.
 */
export interface PageRender {
  /** Always tierForWidth(width). */
  device: Device;
  hash: string;
  width: number;
  /** The browser viewport height the render used (what 100vh meant). */
  viewportHeight: number;
  height: number;
  levels: TileLevel[];
  error?: string;
}
export interface ManifestPage { pageId: string; name: string; route: string; /** Keyed by sizeKey(size), e.g. "1440x900". */ renders: Record<string, PageRender> }
export interface RenderManifest { version: 2; pages: ManifestPage[] }
/** What the canvas selected; sent with prompts in plan 6. */
export interface NodeSelection { pageId: string; device: Device; nodeIds: string[] }

export function tileId(key: string, x: number, y: number): string {
  return `${key}/${x}_${y}`;
}

export function tilePath(key: string, x: number, y: number): string {
  return `tiles/${key}/${x}_${y}.webp`;
}

export function hitMapPath(hash: string): string {
  return `hitmaps/${hash}.json`;
}
