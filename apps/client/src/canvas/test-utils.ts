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
] as const;

/** A recording stand-in for CanvasRenderingContext2D, for painter unit tests. */
export function fakeCtx(width = 800, height = 600): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
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
    };
  }
  return { ctx: Object.assign(ctx, methods) as unknown as CanvasRenderingContext2D, calls };
}

/** A tile image whose identity is its `id`, so draw calls can be asserted by name. */
export function img(id: string): TileImage & { id: string } {
  return { id, width: 512, height: 512, close() {} };
}
