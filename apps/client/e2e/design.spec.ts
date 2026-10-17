import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fitRectInset, worldToScreen } from '../src/canvas/geom.js';
import { CANVAS_INSETS } from '../src/areas/design/layout.js';
import { layoutBounds, layoutFrames } from '../src/canvas/layout.js';

async function openDesign(page: Page, app: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('passphrase').fill('hub-dev-passphrase');
  await page.getByTestId('login-submit').click();
  await page.getByTestId(`app-${app}`).click();
  await page.getByTestId('tab-design').click();
  await expect(page.getByTestId('topbar')).toBeVisible();
}

async function openImport(page: Page): Promise<void> {
  await page.getByTestId('topbar-menu').click();
  await page.getByTestId('menu-import').click();
  await expect(page.getByTestId('import-sheet')).toBeVisible();
}

async function importPages(page: Page): Promise<void> {
  await openImport(page);
  await page.getByTestId('import-submit').click();
}

const toasts = (page: Page) => page.locator('.ui-toasts');

/** The screen point of the last hit box of the first page's 1440×900 frame, as the first-page fit (clear of the chrome) places it. */
async function lastBoxPoint(page: Page): Promise<{ x: number; y: number }> {
  const manifest = await (await page.request.get('/api/apps/demo/render/manifest.json')).json();
  const boxes = await (await page.request.get(`/api/apps/demo/render/hitmaps/${manifest.pages[0].renders['1440x900'].hash}.json`)).json();
  const box = boxes[boxes.length - 1];
  const bounds = await page.getByTestId('canvas').first().boundingBox();
  if (!bounds) throw new Error('No canvas');
  const { frames } = await (await page.request.get('/api/apps/demo/design/frames')).json();
  const firstPage = layoutFrames(frames, manifest).filter((f) => f.pageId === manifest.pages[0].pageId);
  const camera = fitRectInset(layoutBounds(firstPage), { w: bounds.width, h: bounds.height }, 40, CANVAS_INSETS);
  const desktop = firstPage.find((f) => f.w === 1440 && f.viewportHeight === 900)!;
  return worldToScreen(camera, { x: desktop.x + box.x + box.w / 2, y: desktop.y + box.y + box.h / 2 });
}

/** Taps the last hit box (the second Button instance) with the Select tool. */
async function selectLastBox(page: Page): Promise<void> {
  const point = await lastBoxPoint(page);
  await page.getByTestId('tool-select').first().click();
  await page.getByTestId('canvas').first().click({ position: point });
  await expect(page.getByTestId('inspector')).toBeVisible();
}

const pending = async (page: Page): Promise<number> => (await (await page.request.get('/api/apps/demo/design')).json()).pending;

test('authenticated import renders pages, reuses baseline and preserves design on source diagnostics', async ({ page }) => {
  await openDesign(page, 'demo');
  await importPages(page);
  await expect(toasts(page)).toContainText('Imported 1 pages; reused 0.', { timeout: 60_000 });
  await expect(page.getByTestId('import-sheet')).toHaveCount(0);
  const rendered = await (await page.request.get('/api/apps/demo/render/manifest.json')).json();
  expect(rendered.pages).toHaveLength(1);
  expect(rendered.pages[0].renders['1440x900'].levels.length).toBeGreaterThan(0);
  expect(rendered.pages[0].renders['1440x900'].error).toBeUndefined();
  await importPages(page);
  await expect(toasts(page)).toContainText('Imported 0 pages; reused 1.');
  await openImport(page);
  await page.getByTestId('import-mode').selectOption('react');
  await page.getByTestId('import-file').fill('missing.tsx');
  await page.getByTestId('import-submit').click();
  // A missing entry is a failed route of an applied import: a sticky warning whose details name the route.
  await expect(toasts(page)).toContainText('1 route failed to import');
  await toasts(page).getByRole('button', { name: 'Details' }).click();
  await expect(page.getByTestId('details')).toContainText('Missing source missing.tsx');
  expect((await (await page.request.get('/api/apps/demo/design')).json()).pages).toHaveLength(1);
});

test('dynamic source samples require review and are reused on the next import', async ({ page }) => {
  await openDesign(page, 'samples');
  await importPages(page);
  await expect(toasts(page)).toContainText('Import was not applied');
  await toasts(page).getByRole('button', { name: 'Details' }).last().click();
  await expect(page.getByTestId('details')).toContainText('saved preview choice');
  await page.getByTestId('details-close').click();
  expect((await (await page.request.get('/api/apps/samples/design')).json()).imported).toBe(false);
  await page.getByLabel('Preview state or sample data').fill('Use Alice as the sample user');
  await page.getByRole('button', { name: 'Generate sample preview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Source sample preview' })).toBeVisible();
  expect((await (await page.request.get('/api/apps/samples/design')).json()).imported).toBe(false);
  await page.getByRole('button', { name: 'Apply samples and import', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Source sample preview' })).toHaveCount(0);
  await expect(toasts(page)).toContainText('Imported 1 pages');
  await page.getByTestId('import-submit').click();
  await expect(toasts(page)).toContainText('Imported 0 pages; reused 1.');
});

test('Design chat streams a proposal, persists messages and waits for Apply', async ({ page }) => {
  await openDesign(page, 'demo');
  await importPages(page);
  await expect(toasts(page)).toContainText('Imported');
  const before = await pending(page);
  await page.getByTestId('chat-input').fill('Make all buttons purple');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('preview-banner')).toBeVisible();
  await page.getByTestId('chat-toggle').click();
  await expect(page.getByRole('log', { name: 'Design messages' })).toContainText('Tap Apply to change it.');
  await expect(page.getByTestId('chat-messages').getByText('Preview ready')).toBeVisible();
  expect(await pending(page)).toBe(before);
  await page.getByTestId('preview-apply').click();
  await expect(page.getByTestId('preview-banner')).toHaveCount(0);
  expect(await pending(page)).toBe(before + 1);
  await page.reload();
  await page.getByTestId('chat-toggle').click();
  await expect(page.getByRole('log', { name: 'Design messages' })).toContainText('Make all buttons purple');
});

test('a tapped component is its instance: instance edits apply at once, with undo and redo', async ({ page }) => {
  await openDesign(page, 'demo');
  await importPages(page);
  await expect(toasts(page)).toContainText('Imported');
  const initial = await pending(page);
  await selectLastBox(page);
  await expect(page.getByTestId('inspector-kind')).toHaveText('Button');
  // A box without text has no Typography, and empty sections add their fields from +.
  await expect(page.getByTestId('section-typography')).toHaveCount(0);
  await page.getByTestId('section-fill-add').selectOption('background-color');
  await page.getByTestId('fill-background-color-input').fill('red');
  await page.getByTestId('fill-background-color-input').press('Enter');
  // A successful inspector edit is confirmed by the field, not a toast.
  await expect.poll(() => pending(page)).toBe(initial + 1);
  await expect(page.getByTestId('topbar-undo')).toBeEnabled();
  await page.getByTestId('topbar-undo').click();
  await expect.poll(() => pending(page)).toBe(initial);
  await expect(page.getByTestId('topbar-redo')).toBeEnabled();
  await page.getByTestId('topbar-redo').click();
  await expect.poll(() => pending(page)).toBe(initial + 1);
});

test('tapping a layer row selects it on the canvas, with its name in the inspector', async ({ page }) => {
  await openDesign(page, 'demo');
  await importPages(page);
  await expect(toasts(page)).toContainText('Imported');
  await selectLastBox(page);
  await expect(page.getByTestId('layers')).toBeVisible();
  const heading = page.getByTestId('layers').getByRole('treeitem').filter({ hasText: 'Imported demo' });
  await heading.getByRole('button', { name: /h1/ }).click();
  await expect(heading).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('inspector-name')).toHaveValue('h1');
  await expect(page.getByTestId('inspector-kind')).toHaveText('Text');
});

test('Edit component edits every instance at once; Done leaves', async ({ page }) => {
  await openDesign(page, 'demo');
  await importPages(page);
  await expect(toasts(page)).toContainText('Imported');
  const initial = await pending(page);
  await selectLastBox(page);
  await page.getByTestId('inspector-edit-component').click();
  await expect(page.getByTestId('mode-chip')).toContainText('used 2×');
  await expect(page.getByTestId('inspector-shared-note')).toHaveCount(0);
  // The component's text color is set (the chat test made the buttons purple), so its field shows.
  await expect(page.getByTestId('inspector-kind')).toHaveText('Text');
  await page.getByTestId('typography-color-input').fill('blue');
  await page.getByTestId('typography-color-input').press('Enter');
  await expect.poll(() => pending(page)).toBe(initial + 1);
  await expect(page.getByTestId('preview-banner')).toHaveCount(0);
  await page.getByTestId('topbar-undo').click();
  await expect.poll(() => pending(page)).toBe(initial);
  await page.getByTestId('mode-done').click();
  await expect(page.getByTestId('mode-chip')).toHaveCount(0);
});

test('on a tablet-width screen the inspector is a bottom sheet and chat stays reachable', async ({ page }) => {
  await page.setViewportSize({ width: 834, height: 1194 });
  await openDesign(page, 'demo');
  await importPages(page);
  await expect(toasts(page)).toContainText('Imported');
  await selectLastBox(page);
  await expect(page.getByTestId('inspector-sheet')).toHaveClass(/ui-sheet-bottom/);
  await page.getByTestId('chat-input').fill('Make it bigger');
  await expect(page.getByTestId('chat-send')).toBeVisible();
  await expect(page.getByTestId('chat-send')).toBeEnabled();
  // The inspector ends where the chat begins: nothing of either is covered.
  const chat = await page.getByTestId('chat-sheet').boundingBox();
  const sheet = await page.getByTestId('inspector-sheet').boundingBox();
  expect(sheet!.y + sheet!.height).toBeLessThanOrEqual(chat!.y + 1);
  await expect(page.getByTestId('section-raw')).toBeVisible();
});

test('on a tablet, a double tap enters a component and a tap outside leaves it; layers open as a sheet', async ({ page }) => {
  await page.setViewportSize({ width: 834, height: 1194 });
  await openDesign(page, 'demo');
  await importPages(page);
  await expect(toasts(page)).toContainText('Imported');
  const point = await lastBoxPoint(page);
  await page.getByTestId('tool-select').first().click();
  const canvas = page.getByTestId('canvas').first();
  await canvas.dblclick({ position: point });
  await expect(page.getByTestId('mode-chip')).toBeVisible();
  // The top-left of the first frame is outside the instance.
  await canvas.click({ position: { x: point.x, y: point.y - 60 } });
  await expect(page.getByTestId('mode-chip')).toHaveCount(0);
  await expect(page.getByTestId('layers')).toHaveCount(0);
  await page.getByTestId('topbar-layers').click();
  await expect(page.getByTestId('layers')).toBeVisible();
  // The sheet covers the left of the canvas: tap the canvas to its right.
  await canvas.click({ position: { x: 600, y: point.y } });
  await expect(page.getByTestId('layers')).toHaveCount(0);
});
