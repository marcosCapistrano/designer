import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { generateDoc } from '../dev/generate.js';
import { basePixel, frameOf, hitMapOf, layerTransform, nextPaint, ready, rgbOf, toScreen } from './helpers.js';
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

/** Moves the camera and waits until the tiles it needs are loaded and painted. */
async function setCamera(page: Page, cam: Camera): Promise<void> {
  await page.evaluate(`window.__hubCanvas.setCamera(${JSON.stringify(cam)})`);
  // The frame that asks for the tiles runs on the next animation frame; only then is there
  // anything for idle() to wait for. The load's own frame then paints the tiles.
  await nextPaint(page);
  await page.evaluate('window.__hubCanvas.idle()');
  await nextPaint(page);
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
  await page.goto('/?debug=1');
  await ready(page);
  expect(await frameCount(page)).toBe(150);
  // The paint that follows the last tile load runs after idle() resolves, so poll.
  await expect.poll(async () => (await stats(page)).tilesDrawn).toBeGreaterThan(0);
  expect((await stats(page)).loader.failed).toBe(0);
});

test('tap selects the node under the pointer', async ({ page }) => {
  await page.goto('/?debug=1');
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
  await page.goto('/?debug=1');
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
  await page.goto('/?debug=1');
  await ready(page);
  await page.getByTestId('device-mobile').click();
  await expect.poll(() => frameCount(page)).toBe(100);
  await page.getByTestId('device-mobile').click();
  await expect.poll(() => frameCount(page)).toBe(150);
});

test('reload serves visible tiles from IndexedDB', async ({ page }) => {
  await page.goto('/?debug=1');
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

/** The first grid card of a generated page: its node id and the background the generator gave it. */
function firstCard(pageId: string): { nodeId: string; background: string } {
  // The fixtures are rendered from this same document (`test:e2e`: --pages 50 --seed 1).
  const page = generateDoc({ pages: 50, seed: 1 }).pages[pageId];
  if (page === undefined) throw new Error(`no generated page ${pageId}`);
  const stack = [page.root as unknown];
  while (stack.length > 0) {
    const node = stack.shift() as {
      id: string;
      kind: string;
      style?: { base?: Record<string, string> };
      children?: unknown[];
    };
    const background = node.kind === 'element' ? node.style?.base?.background : undefined;
    if (background !== undefined) return { nodeId: node.id, background };
    stack.push(...(node.children ?? []));
  }
  throw new Error(`no card with a background on ${pageId}`);
}

/** Each channel within a small tolerance of the expected colour (tiles are lossy WebP). */
function expectNear(actual: readonly number[], expected: readonly number[], label: string): void {
  const near = expected.every((v, i) => Math.abs((actual[i] ?? -999) - v) <= 8);
  expect(near, `${label}: got rgb(${actual.join(',')}), want rgb(${expected.join(',')}) +-8`).toBe(true);
}

/**
 * Puts a generated card's left edge at screen x = 120 at scale 1 and returns the screen points just
 * inside it (the card's background) and just outside it (the page's white).
 */
async function showCard(page: Page): Promise<{ inside: [number, number]; outside: [number, number]; background: string }> {
  const card = firstCard('gen-02');
  const f = await frameOf(page, 'gen-02', 'base');
  const b = boxOf(await hitMapOf(page, hashOf(f)), card.nodeId);
  await setCamera(page, { x: f.x + b.x - 120, y: f.y + b.y - 120, scale: 1 });
  const y = 120 + b.h / 2;
  return { inside: [126, y], outside: [114, y], background: card.background };
}

test('a card is painted where its hit box says it is', async ({ page }) => {
  await page.goto('/?debug=1');
  await ready(page);
  const { inside, outside, background } = await showCard(page);
  // The tap and box tests take their coordinates from the hit map, so they cannot see tiles drawn
  // at the wrong offset; the card's own edge can: the background just inside it, white just outside.
  expectNear(await basePixel(page, ...inside), rgbOf(background), 'inside the card');
  expectNear(await basePixel(page, ...outside), [255, 255, 255], 'outside the card');
});

test('a ctrl-wheel zoom is previewed by a transform and settles to the same picture', async ({ page }) => {
  await page.goto('/?debug=1');
  await ready(page);
  const { inside, outside, background } = await showCard(page);
  // Zoom about the card's left edge, so the edge stays at screen x = 120, and look at where the
  // shown canvas ends up two frames later, well inside the 150 ms before the camera settles.
  const preview = await page.evaluate<{ transform: string; left: number; top: number; width: number }>(`(async () => {
    const root = document.querySelector('[data-testid=canvas]');
    root.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, ctrlKey: true, clientX: 120, clientY: ${inside[1]}, bubbles: true, cancelable: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const shown = [...document.querySelectorAll('[data-testid=canvas-base]')].find((e) => getComputedStyle(e).visibility === 'visible');
    const r = shown.getBoundingClientRect();
    return { transform: root.firstElementChild.style.transform, left: r.left, top: r.top, width: r.width };
  })()`);
  expect(preview.transform).toMatch(/^translate\(.*\) scale\(1\.\d+\)$/);
  const ratio = preview.width / 1280;
  expect(ratio).toBeGreaterThan(1.1);
  // The zoom anchor does not move: the painted card edge, scaled about the canvas's moved origin, is still there.
  expect(preview.left + 120 * ratio).toBeCloseTo(120, 0);
  expect(preview.top + inside[1] * ratio).toBeCloseTo(inside[1], 0);
  // After the camera settles the layers are repainted at the new scale and shown untransformed.
  await expect.poll(() => layerTransform(page)).toBe('');
  await page.evaluate('window.__hubCanvas.idle()');
  await nextPaint(page);
  expect((await page.evaluate<Camera>('window.__hubCanvas.camera()')).scale).toBeGreaterThan(1.1);
  expectNear(await basePixel(page, ...inside), rgbOf(background), 'inside the card');
  expectNear(await basePixel(page, ...outside), [255, 255, 255], 'outside the card');
});

test('tap hits the node under the pointer while a zoom preview is on screen', async ({ page }) => {
  await page.goto('/?debug=1');
  await ready(page);
  const cam: Camera = { x: -40, y: -40, scale: 0.5 };
  await setCamera(page, cam);
  const f = await frameOf(page, 'home', 'base');
  const b = boxOf(await hitMapOf(page, hashOf(f)), 'n3');
  // Keep the zoom unsettled with a stream of tiny alternating ctrl-wheel events (a net change of
  // about 0.01%), so the layers stay under a transform while the tap lands.
  await page.evaluate(`(() => {
    const root = document.querySelector('[data-testid=canvas]'); let dir = 1;
    window.__zoomJitter = setInterval(() => {
      root.dispatchEvent(new WheelEvent('wheel', { deltaY: dir * 0.01, ctrlKey: true, clientX: 640, clientY: 400, bubbles: true, cancelable: true }));
      dir = -dir;
    }, 16);
  })()`);
  await expect.poll(() => layerTransform(page)).not.toBe('');
  const now = await page.evaluate<Camera>('window.__hubCanvas.camera()');
  const p = toScreen(now, f, b.x + b.w / 2, b.y + b.h / 2);
  await page.mouse.click(p.x, p.y);
  expect(await layerTransform(page)).not.toBe('');
  await page.evaluate('clearInterval(window.__zoomJitter)');
  await expect.poll(() => selection(page)).toEqual({ pageId: 'home', device: 'base', nodeIds: ['n3'] });
});
