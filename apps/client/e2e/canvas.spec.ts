import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { frameOf, hitMapOf, ready, toScreen } from './helpers.js';
import type { E2EBox, E2EFrame } from './helpers.js';

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface CanvasSelection {
  pageId: string;
  device: string;
  nodeIds: string[];
}

interface CanvasStats {
  framesPainted: number;
  tilesDrawn: number;
  loader: { images: number; inFlight: number; queued: number; failed: number };
}

// Each call evaluates a string in the page, so the code runs as plain JS there.
function frameCount(page: Page): Promise<number> {
  return page.evaluate<number>('window.__hubCanvas.frames().length');
}

function stats(page: Page): Promise<CanvasStats> {
  return page.evaluate<CanvasStats>('window.__hubCanvas.stats()');
}

function selection(page: Page): Promise<CanvasSelection | null> {
  return page.evaluate<CanvasSelection | null>('window.__hubCanvas.selection()');
}

async function setCamera(page: Page, cam: Camera): Promise<void> {
  await page.evaluate(`window.__hubCanvas.setCamera(${JSON.stringify(cam)})`);
  await page.evaluate('window.__hubCanvas.idle()');
}

function hashOf(f: E2EFrame): string {
  if (f.render === null) throw new Error(`${f.pageId}/${f.device} has no render`);
  return f.render.hash;
}

function boxOf(boxes: readonly E2EBox[], nodeId: string): E2EBox {
  const box = boxes.find((b) => b.nodeId === nodeId);
  if (box === undefined) throw new Error(`no hit box for ${nodeId}`);
  return box;
}

test('shows 50 pages x 3 devices and draws tiles', async ({ page }) => {
  await page.goto('/harness.html?debug=1');
  await ready(page);
  expect(await frameCount(page)).toBe(150);
  // The paint that follows the last tile load runs after idle() resolves, so poll.
  await expect.poll(async () => (await stats(page)).tilesDrawn).toBeGreaterThan(0);
  expect((await stats(page)).loader.failed).toBe(0);
});

test('tap selects the node under the pointer', async ({ page }) => {
  await page.goto('/harness.html?debug=1');
  await ready(page);
  const cam: Camera = { x: -40, y: -40, scale: 0.5 };
  await setCamera(page, cam);
  const f = await frameOf(page, 'home', 'base');
  const b = boxOf(await hitMapOf(page, hashOf(f)), 'n3');
  const p = toScreen(cam, f, b.x + b.w / 2, b.y + b.h / 2);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => selection(page)).toEqual({ pageId: 'home', device: 'base', nodeIds: ['n3'] });
  await expect(page.getByTestId('selection')).toContainText('n3');
});

test('drag in select tool selects a box', async ({ page }) => {
  await page.goto('/harness.html?debug=1');
  await ready(page);
  const cam: Camera = { x: -40, y: -40, scale: 0.5 };
  await setCamera(page, cam);
  await page.getByTestId('tool-select').click();
  const f = await frameOf(page, 'home', 'base');
  const h = boxOf(await hitMapOf(page, hashOf(f)), 'n2');
  const start = toScreen(cam, f, -20, -20);
  const end = toScreen(cam, f, 1460, h.y + h.h + 5);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await selection(page))?.nodeIds).toEqual(['n2']);
});

test('device toggle hides frames', async ({ page }) => {
  await page.goto('/harness.html?debug=1');
  await ready(page);
  await page.getByTestId('device-mobile').click();
  await expect.poll(() => frameCount(page)).toBe(100);
  await page.getByTestId('device-mobile').click();
  await expect.poll(() => frameCount(page)).toBe(150);
});

test('reload serves visible tiles from IndexedDB', async ({ page }) => {
  await page.goto('/harness.html?debug=1');
  await ready(page);
  const tileRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/dev-renders/tiles/')) tileRequests.push(req.url());
  });
  await page.reload();
  await ready(page);
  expect(tileRequests).toEqual([]);
  // An empty request list only proves the cache if tiles were actually loaded from it.
  expect((await stats(page)).loader.images).toBeGreaterThan(0);
});
