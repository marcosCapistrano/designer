import type { BuildMessage, BuildTask } from './api.js';
import type { RenderManifest } from './render.js';

export interface RenderReadyMsg { type: 'render.ready'; app: string; manifest: RenderManifest }
export interface BuildMessageMsg { type: 'build.message'; app: string; message: BuildMessage }
export interface BuildTaskMsg { type: 'build.task'; app: string; task: BuildTask; running: boolean }
export interface PongMsg { type: 'pong'; t: number }
/** Server → client. Plans 4 and 6 add variants here and to SERVER_MSG_TYPES. */
export type ServerMsg = RenderReadyMsg | BuildMessageMsg | BuildTaskMsg | PongMsg;
export const SERVER_MSG_TYPES: readonly ServerMsg['type'][] = ['render.ready', 'build.message', 'build.task', 'pong'];

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

/** Returns the message when data is a JSON object whose `type` is a known server message type. Never throws. */
export function parseServerMsg(data: string): ServerMsg | null {
  const obj = parseObject(data);
  if (!obj || !(SERVER_MSG_TYPES as readonly unknown[]).includes(obj.type)) return null;
  return obj as unknown as ServerMsg;
}

/** Returns the message when data is exactly `{ type: 'ping', t: number }`. Never throws. */
export function parseClientMsg(data: string): ClientMsg | null {
  const obj = parseObject(data);
  if (!obj || obj.type !== 'ping' || typeof obj.t !== 'number') return null;
  return { type: 'ping', t: obj.t };
}
