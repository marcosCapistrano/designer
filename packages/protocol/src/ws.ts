import type { RenderManifest } from './render.js';
export interface RenderReadyMsg { type: 'render.ready'; app: string; manifest: RenderManifest }
/** Server → client WebSocket messages. Plans 3, 4 and 6 add variants to this union. */
export type ServerMsg = RenderReadyMsg;
