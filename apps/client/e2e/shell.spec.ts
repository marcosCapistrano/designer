import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const PASSPHRASE = 'hub-dev-passphrase';

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('passphrase').fill(PASSPHRASE);
  await page.getByTestId('login-submit').click();
}

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
  await expect(page.getByTestId('tab-build')).toHaveCSS('border-bottom-color', 'rgb(26, 115, 232)');
  await expect(page.getByTestId('tab-design')).toHaveCSS('border-bottom-color', 'rgba(0, 0, 0, 0)');
});
