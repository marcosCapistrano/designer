import { expect, test } from '@playwright/test';

test('the app shell loads offline after one visit', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  // The first load was not controlled by the worker; the reload is.
  await page.reload();

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByTestId('offline')).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
