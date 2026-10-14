import type { BuildMessage, BuildTask } from './api.js';
import type { RenderManifest } from './render.js';
import type { DesignEditResult, DesignMessage } from './design.js';

export interface RenderReadyMsg { type: 'render.ready'; app: string; manifest: RenderManifest }
export interface BuildMessageMsg { type: 'build.message'; app: string; message: BuildMessage }
export interface BuildTaskMsg { type: 'build.task'; app: string; task: BuildTask; running: boolean }
export interface PongMsg { type: 'pong'; t: number }
export interface DesignMessageMsg { type: 'design.message'; app: string; message: DesignMessage }
export interface DesignStatusMsg { type: 'design.status'; app: string; running: boolean; edit?: DesignEditResult | null }
/** Server → client. Plans 4 and 6 add variants here and to SERVER_MSG_TYPES. */
export type ServerMsg = RenderReadyMsg | BuildMessageMsg | BuildTaskMsg | DesignMessageMsg | DesignStatusMsg | PongMsg;

/**
 * Every ServerMsg type, once. `satisfies Record<ServerMsg['type'], true>` makes the compiler reject a new
 * ServerMsg variant that is missing here, and a type here that is not a variant.
 */
const SERVER_MSG_TYPE_SET = {
  'render.ready': true,
  'build.message': true,
  'build.task': true,
  'design.message': true,
  'design.status': true,
  pong: true,
} satisfies Record<ServerMsg['type'], true>;
export const SERVER_MSG_TYPES: readonly ServerMsg['type'][] = Object.keys(SERVER_MSG_TYPE_SET) as ServerMsg['type'][];

export interface PingMsg { type: 'ping'; t: number }
/** Client → server. */
export type ClientMsg = PingMsg;

function parseObject(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Returns the message when data is a JSON object whose `type` is a known server message type. Never throws.
 * The check is on the tag only: the payload is not validated, so a consumer must not trust its shape
 * beyond `type` (the sender is the hub, so the payload is only as wrong as a hub bug).
 */
export function parseServerMsg(data: string): ServerMsg | null {
  const obj = parseObject(data);
  if (!obj || !(SERVER_MSG_TYPES as readonly unknown[]).includes(obj.type)) return null;
  return obj as unknown as ServerMsg;
}

/** Returns the message when data is `{ type: 'ping', t }` with a finite number `t`. Never throws. */
export function parseClientMsg(data: string): ClientMsg | null {
  const obj = parseObject(data);
  if (!obj || obj.type !== 'ping' || typeof obj.t !== 'number' || !Number.isFinite(obj.t)) return null;
  return { type: 'ping', t: obj.t };
}
