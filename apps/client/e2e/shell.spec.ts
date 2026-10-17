import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const PASSPHRASE = 'hub-dev-passphrase';

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('passphrase').fill(PASSPHRASE);
  await page.getByTestId('login-submit').click();
}

test('the app list says it is loading until the hub answers', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/apps', async (route) => {
    await gate;
    await route.continue();
  });
  await login(page);
  await expect(page.getByTestId('apps-loading')).toBeVisible();
  await expect(page.getByTestId('no-apps')).toHaveCount(0);
  release();
  await expect(page.getByTestId('app-demo')).toBeVisible();
  await expect(page.getByTestId('apps-loading')).toHaveCount(0);
});

test('a failed logout error does not come back after the session ends and the user logs in again', async ({ page }) => {
  await login(page);
  await expect(page.getByTestId('app-demo')).toBeVisible();

  // The logout request fails, so the user stays logged in and is told why.
  await page.route('**/api/logout', (route) => route.fulfill({ status: 500, json: { error: 'boom' } }));
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('logout-error')).toHaveText('Could not log out. Try again.');

  // The session then ends another way: the hub answers the Build area's first request with 401.
  const buildRoute = /\/api\/apps\/demo\/build(\?|$)/;
  await page.route(buildRoute, (route) => route.fulfill({ status: 401, json: { error: 'Not logged in' } }));
  await page.evaluate(() => {
    location.hash = '#/apps/demo/build';
  });
  await expect(page.getByTestId('login')).toBeVisible();
  await page.unroute(buildRoute);

  // Logging in again must not bring the old error back.
  await page.getByTestId('passphrase').fill(PASSPHRASE);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('logout')).toBeVisible();
  await expect(page.getByTestId('logout-error')).toHaveCount(0);
});

test('the app list and an app page style themselves with classes, not inline styles', async ({ page }) => {
  await login(page);
  await expect(page.getByTestId('app-demo')).toBeVisible();
  await expect(page.locator('.app-list-page')).toBeVisible();
  expect(await page.locator('.app-list-page [style], .app-list-page[style]').count()).toBe(0);
  await page.getByTestId('app-demo').click();
  await expect(page.getByTestId('tab-build')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.app-view')).toBeVisible();
  expect(await page.locator('.app-view [style], .app-view[style]').count()).toBe(0);
  // The tab strip and the selected tab still render as designed.
  await expect(page.getByTestId('tab-build')).toHaveCSS('border-bottom-color', 'rgb(76, 141, 255)');
  await expect(page.getByTestId('tab-design')).toHaveCSS('border-bottom-color', 'rgba(0, 0, 0, 0)');
});
