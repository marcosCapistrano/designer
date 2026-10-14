import { expect, test } from '@playwright/test';
import { ready } from './helpers.js';

// Each evaluate call takes a string, so the code runs as plain JS in the page.
// Values are interpolated into the string as literals.

test('pans 50 pages x 3 devices at >= 50 fps median with 4x CPU throttle', async ({ page }) => {
  await page.goto('/harness.html?debug=1');
  await ready(page);
  expect(await page.evaluate<number>('window.__hubCanvas.frames().length')).toBe(150);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  for (const s of [
    { scale: 0.3, dx: 0, dy: -12 },
    { scale: 0.08, dx: 0, dy: -10 },
  ]) {
    await page.evaluate(
      `window.__hubCanvas.setCamera(${JSON.stringify({ x: -40, y: -40, scale: s.scale })})`,
    );
    await page.evaluate('window.__hubCanvas.idle()');
    const median = await page.evaluate<number>(`new Promise(resolve => {
      const times = []; const start = performance.now();
      const tick = t => {
        times.push(t); window.__hubCanvas.panBy(${s.dx}, ${s.dy});
        if (t - start < 4000) requestAnimationFrame(tick);
        else {
          const d = times.slice(1).map((v, i) => v - times[i]).sort((a, b) => a - b);
          resolve(d[Math.floor(d.length / 2)]);
        }
      };
      requestAnimationFrame(tick);
    })`);
    console.log(`scale ${s.scale}: median frame ${median.toFixed(1)} ms = ${(1000 / median).toFixed(0)} fps`);
    expect(1000 / median).toBeGreaterThanOrEqual(50);
  }
});
