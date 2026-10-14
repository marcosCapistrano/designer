import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const PASSPHRASE = 'hub-dev-passphrase';

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('passphrase').fill(PASSPHRASE);
  await page.getByTestId('login-submit').click();
}

test('wrong passphrase shows an error, the right one opens the app list', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('passphrase').fill('not the passphrase');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toHaveText('Wrong passphrase.');

  await page.getByTestId('passphrase').fill(PASSPHRASE);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('app-demo')).toBeVisible();
});

// Sends no prompt, so it leaves the fake runner's one script for the Build-flow test below.
test('a draft typed as the Build area mounts survives', async ({ page }) => {
  await login(page);
  await expect(page.getByTestId('app-demo')).toBeVisible();
  // The observer runs in the same task as the commit that mounts the Build area, before its effects do.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const mo = new MutationObserver(() => {
          const t = document.querySelector<HTMLTextAreaElement>('[data-testid=build-input]');
          if (t === null) return;
          mo.disconnect();
          t.value = 'early';
          t.dispatchEvent(new Event('input', { bubbles: true }));
          resolve();
        });
        mo.observe(document.body, { childList: true, subtree: true });
        location.hash = '#/apps/demo/build';
      }),
  );
  await page.waitForTimeout(500);
  await expect(page.getByTestId('build-input')).toHaveValue('early');
  await expect(page.getByTestId('build-send')).toBeEnabled();
});

// Needs a fresh fake hub: it sends the only scripted prompt, so no retries and no reuse of a hub that already ran it.
test('a Build prompt streams, opens a PR, and merges after CI', async ({ page }) => {
  await login(page);
  await page.getByTestId('app-demo').click();
  await expect(page.getByTestId('tab-build')).toHaveAttribute('aria-selected', 'true');

  await page.getByTestId('build-input').fill('Add a notes file');
  await page.getByTestId('build-send').click();

  await expect(page.getByTestId('msg-user')).toContainText('Add a notes file');
  await expect(page.getByTestId('build-messages')).toContainText('Done.', { timeout: 30_000 });

  await expect(page.getByTestId('pr-link')).toContainText('PR #', { timeout: 30_000 });
  await expect(page.getByTestId('ci-state')).toHaveText('success', { timeout: 30_000 });

  const merge = page.getByTestId('merge');
  await expect(merge).toBeEnabled();
  await merge.click();
  await expect(page.getByTestId('task-status')).toHaveText('Merged');
  // The server's own announcement (build/ci.ts mergeTask), so the merge went through the hub and not only the client.
  await expect(page.getByTestId('build-messages')).toContainText(/Merged pull request #\d+\./);
});

test("design tab shows the app's canvas", async ({ page }) => {
  await login(page);
  await page.getByTestId('app-demo').click();
  // The canvas reports a failed manifest load as canvas-error, so wait for that load before checking it is absent.
  const manifest = page.waitForResponse((r) => /\/render\/manifest\.json/.test(r.url()));
  await page.getByTestId('tab-design').click();
  expect((await manifest).ok()).toBe(true);
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.getByTestId('canvas-error')).toHaveCount(0);
});

test('deploy tab shows the placeholder', async ({ page }) => {
  await login(page);
  await page.getByTestId('app-demo').click();
  await page.getByTestId('tab-deploy').click();
  await expect(page.getByTestId('deploy-placeholder')).toHaveText('Deploy is not set up yet.');
});

test('log out returns to the login screen', async ({ page }) => {
  await login(page);
  await expect(page.getByTestId('app-demo')).toBeVisible();
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('login')).toBeVisible();
  await expect(page.getByTestId('app-demo')).toHaveCount(0);
});
