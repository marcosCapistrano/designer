import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ready } from './helpers.js';

// Models the Galaxy Tab S6 Lite: 1333x800 CSS px at devicePixelRatio 1.5 gives the
// 2000x1200 backing store the canvas paints into. Panning cost scales with that
// store, so a 1280x800 @1 profile hides regressions that matter on the tablet.
test.use({ viewport: { width: 1333, height: 800 }, deviceScaleFactor: 1.5 });

const PHASE_MS = 4000;
const CPU_THROTTLE = 4;

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface PhaseResult {
  times: number[];
  before: { camera: Camera; painted: number; previewed: number };
  after: { camera: Camera; painted: number; previewed: number };
  minScale: number;
  maxScale: number;
}

interface Summary {
  frames: number;
  medianMs: number;
  p90Ms: number;
  maxMs: number;
  fps: number;
}

function summarize(times: readonly number[]): Summary {
  const d = times
    .slice(1)
    .map((v, i) => v - (times[i] ?? v))
    .sort((a, b) => a - b);
  const at = (q: number): number => d[Math.min(d.length - 1, Math.floor(d.length * q))] ?? Infinity;
  const medianMs = at(0.5);
  return { frames: d.length, medianMs, p90Ms: at(0.9), maxMs: d[d.length - 1] ?? Infinity, fps: 1000 / medianMs };
}

function line(name: string, s: Summary, r: PhaseResult): string {
  const c0 = r.before.camera;
  const c1 = r.after.camera;
  const cam = (c: Camera): string => `(${c.x.toFixed(0)},${c.y.toFixed(0)} @${c.scale.toFixed(3)})`;
  return (
    `[perf] ${name}: ${s.frames} frames, median ${s.medianMs.toFixed(1)} ms = ${s.fps.toFixed(0)} fps, ` +
    `p90 ${s.p90Ms.toFixed(1)} ms, max ${s.maxMs.toFixed(1)} ms; camera ${cam(c0)} -> ${cam(c1)}; ` +
    `framesPainted ${r.before.painted} -> ${r.after.painted} (previewed ${r.before.previewed} -> ${r.after.previewed})`
  );
}

/**
 * Runs `step` (page code, with `t` in scope) on every animation frame for PHASE_MS and
 * returns the frame timestamps with the camera and paint count on each side. The page
 * code is a string because it runs in Chromium, where tsx's `__name` helpers do not exist.
 */
function runPhase(page: Page, init: string, step: string): Promise<PhaseResult> {
  return page.evaluate<PhaseResult>(`new Promise(resolve => {
    const hub = window.__hubCanvas;
    const snap = () => ({ camera: { ...hub.camera() }, painted: hub.stats().framesPainted, previewed: hub.stats().previewFrames });
    const before = snap();
    let minScale = before.camera.scale; let maxScale = before.camera.scale;
    const times = []; const start = performance.now(); let last = start;
    ${init}
    const tick = t => {
      times.push(t);
      const dt = Math.min(50, t - last); last = t;
      ${step}
      const sc = hub.camera().scale;
      if (sc < minScale) minScale = sc;
      if (sc > maxScale) maxScale = sc;
      if (t - start < ${PHASE_MS}) requestAnimationFrame(tick);
      else resolve({ times, before, after: snap(), minScale, maxScale });
    };
    requestAnimationFrame(tick);
  })`);
}

test.describe('Tab S6 Lite profile, 4x CPU throttle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/harness.html?debug=1');
    await ready(page);
    expect(await page.evaluate<number>('window.__hubCanvas.frames().length')).toBe(150);
    // The profile only means something if the canvas really has the tablet backing store.
    expect(await page.evaluate('[document.querySelector("canvas").width, document.querySelector("canvas").height]')).toEqual([
      2000, 1200,
    ]);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  });

  for (const s of [
    { scale: 0.3, dx: -6, dy: -12 },
    { scale: 0.08, dx: -5, dy: -10 },
  ]) {
    test(`pans 50 pages x 3 devices at scale ${s.scale}: median >= 50 fps, p90 <= 34 ms`, async ({ page }) => {
      await page.evaluate(
        `window.__hubCanvas.setCamera(${JSON.stringify({ x: -40, y: -40, scale: s.scale })})`,
      );
      await page.evaluate('window.__hubCanvas.idle()');
      const r = await runPhase(page, '', `hub.panBy(${s.dx}, ${s.dy});`);
      const sum = summarize(r.times);
      console.log(line(`pan @${s.scale}`, sum, r));
      expect.soft(r.after.camera.x, 'camera x moved').not.toBe(r.before.camera.x);
      expect.soft(r.after.camera.y, 'camera y moved').not.toBe(r.before.camera.y);
      expect.soft(r.after.camera.scale, 'pan keeps the scale').toBe(r.before.camera.scale);
      expect.soft(r.after.painted, 'frames were painted').toBeGreaterThan(r.before.painted);
      expect.soft(sum.fps, 'median fps').toBeGreaterThanOrEqual(50);
      expect.soft(sum.p90Ms, 'p90 frame ms').toBeLessThanOrEqual(34);
    });
  }

  test('ctrl-wheel zooms in and back out: median >= 40 fps', async ({ page }) => {
    await page.evaluate(`window.__hubCanvas.setCamera(${JSON.stringify({ x: -40, y: -40, scale: 0.3 })})`);
    await page.evaluate('window.__hubCanvas.idle()');
    // Zoom in for the first half of the phase and out for the second, each frame a
    // ctrl-wheel event at the viewport centre (factor exp(-deltaY * 0.01)): about 1.5x
    // each way at 60 fps, so the scale crosses tile levels and ends near where it began.
    const init = `const root = document.querySelector('[data-testid=canvas]');`;
    const step = `
      const dir = t - start < ${PHASE_MS / 2} ? -1 : 1;
      root.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dir * 0.3 * (dt / 16.7), deltaMode: 0, ctrlKey: true,
        clientX: innerWidth / 2, clientY: innerHeight / 2, bubbles: true, cancelable: true,
      }));`;
    const r = await runPhase(page, init, step);
    const sum = summarize(r.times);
    console.log(line('ctrl-wheel zoom @0.3', sum, r));
    console.log(`[perf] ctrl-wheel zoom @0.3: scale range ${r.minScale.toFixed(3)} .. ${r.maxScale.toFixed(3)}`);
    expect.soft(r.maxScale, 'scale changed').toBeGreaterThan(r.before.camera.scale * 1.1);
    expect.soft(r.after.painted, 'frames were painted').toBeGreaterThan(r.before.painted);
    expect.soft(sum.fps, 'median fps').toBeGreaterThanOrEqual(40);
  });
});
