import { expect, test } from '@playwright/test';

test('the served service worker has its cache name stamped by the build', async ({ request }) => {
  const res = await request.get('/sw.js');
  expect(res.ok()).toBe(true);
  const source = await res.text();
  expect(source).not.toContain('__BUILD_ID__');
  expect(source).toMatch(/const CACHE = 'hub-shell-[0-9a-f]{12}';/);
});

test('the app shell loads offline after one visit', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  // The first load was not controlled by the worker; the reload is.
  await page.reload();

  // The worker caches /assets/ files as the controlled page fetches them, after the fetch returns. Going offline
  // before that finishes would fail the reload for a reason that has nothing to do with the shell.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          if (navigator.serviceWorker.controller === null) return ['(page is not controlled)'];
          const assets = performance
            .getEntriesByType('resource')
            .map((e) => new URL(e.name).pathname)
            .filter((p) => p.startsWith('/assets/'));
          if (assets.length === 0) return ['(no /assets/ files loaded)'];
          // Compare cached request URLs rather than caches.match(): a response's Vary header can make a match miss.
          const cached = new Set<string>();
          for (const name of await caches.keys()) {
            for (const req of await (await caches.open(name)).keys()) cached.add(new URL(req.url).pathname);
          }
          return ['/', ...assets].filter((p) => !cached.has(p));
        }),
      { timeout: 10_000 },
    )
    .toEqual([]);

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByTestId('offline')).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
