import { defaultFrames } from '@hub/protocol';
import type { CanvasFrame, RenderManifest } from '@hub/protocol';
import { frameHeightIn } from './frames.js';
import type { TileImage } from './loader.js';

/** One recorded canvas call, with the style state in effect when it ran. */
export interface Call {
  m: string;
  a: unknown[];
  fill: string;
  stroke: string;
  lw: number;
  smooth: boolean;
}

const METHODS = [
  'save',
  'restore',
  'setTransform',
  'beginPath',
  'rect',
  'clip',
  'fillRect',
  'strokeRect',
  'clearRect',
  'fillText',
  'drawImage',
  'setLineDash',
  'moveTo',
  'lineTo',
  'stroke',
] as const;

/**
 * A recording stand-in for CanvasRenderingContext2D, for painter unit tests.
 * `saveDepth()` is the number of save() calls not yet matched by restore();
 * a restore() at depth 0 is ignored, as on a real canvas.
 */
export function fakeCtx(
  width = 800,
  height = 600,
): { ctx: CanvasRenderingContext2D; calls: Call[]; saveDepth: () => number } {
  const calls: Call[] = [];
  let depth = 0;
  const ctx = {
    canvas: { width, height },
    fillStyle: '#000000' as string,
    strokeStyle: '#000000' as string,
    lineWidth: 1,
    font: '10px sans-serif',
    textBaseline: 'alphabetic' as string,
    imageSmoothingEnabled: true,
  };
  const methods: Record<string, (...a: unknown[]) => void> = {};
  for (const m of METHODS) {
    methods[m] = (...a: unknown[]) => {
      calls.push({
        m,
        a,
        fill: ctx.fillStyle,
        stroke: ctx.strokeStyle,
        lw: ctx.lineWidth,
        smooth: ctx.imageSmoothingEnabled,
      });
      if (m === 'save') depth++;
      if (m === 'restore') depth = Math.max(0, depth - 1);
    };
  }
  return {
    ctx: Object.assign(ctx, methods) as unknown as CanvasRenderingContext2D,
    calls,
    saveDepth: () => depth,
  };
}

/** A tile image whose identity is its `id`, so draw calls can be asserted by name. */
export function img(id: string): TileImage & { id: string } {
  return { id, width: 512, height: 512, close() {} };
}

/** Ids f0000000000000001, f0000000000000002, ... in call order. */
export function sequentialIds(): () => string {
  let n = 0;
  return () => `f${(++n).toString(16).padStart(16, '0')}`;
}

/** The server's default layout for `m`: three frames per page, one row per page. */
export function framesFor(m: RenderManifest): CanvasFrame[] {
  return defaultFrames(m.pages, [], (pageId, size) => frameHeightIn(m, pageId, size), sequentialIds());
}
