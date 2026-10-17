import type { CanvasFrame } from '@hub/protocol';
import type { FrameStore } from '../canvas/frames.js';
import type { ApiClient } from './api.js';

/** One app's canvas layout, stored by the hub. A refused save rejects with the hub's ApiError. */
export class ServerFrameStore implements FrameStore {
  constructor(
    private readonly app: string,
    private readonly api: Pick<ApiClient, 'designFrames' | 'saveDesignFrames'>,
  ) {}

  load(): Promise<CanvasFrame[]> {
    return this.api.designFrames(this.app);
  }

  save(frames: readonly CanvasFrame[]): Promise<CanvasFrame[]> {
    return this.api.saveDesignFrames(this.app, frames);
  }
}
