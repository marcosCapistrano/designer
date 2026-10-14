import { createHash } from 'node:crypto';
import type { Device, Zoom } from '@hub/protocol';

/** Level key: sha256 of the plain concatenation html + css + device + zoom, lowercase hex. */
export function tileKey(html: string, css: string, device: Device, zoom: Zoom): string {
  return createHash('sha256').update(html + css + device + String(zoom)).digest('hex');
}
