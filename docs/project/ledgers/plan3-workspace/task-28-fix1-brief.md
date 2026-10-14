# Task 28 fix round 1 (from review acc34c0086682aae8)

Worktree /home/claude/wt-p3-28, branch p3-28. First `git merge --no-ff feat/hub-server` (it has moved). Same port/CI=1 rules as before; do not run perf.spec.ts.

I1 (Important). The BuildArea draft fix has no test that fails without it: the reviewer reverted the fix and the Build-flow e2e passed 4 of 4. Add the reviewer's spec (types into build-input from a MutationObserver in the same task as the mount commit, then waits 500 ms, then expects the value 'early' and Send enabled). Put it before the Build-flow test or in its own spec file; it must not send a prompt (the fake runner has one script). Prove it: revert the fix locally, show the spec failing, restore the fix, show it passing (do not commit the revert). The spec text is in the review report quoted in the controller's message below.

```ts
test('a draft typed as the Build area mounts survives', async ({ page }) => {
  await login(page);
  await expect(page.getByTestId('app-demo')).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => {
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
  }));
  await page.waitForTimeout(500);
  await expect(page.getByTestId('build-input')).toHaveValue('early');
  await expect(page.getByTestId('build-send')).toBeEnabled();
});
```
(Adjust the hash route to the client's real Build route if it differs.)

Minors (all in this round):
M1. build.spec.ts design test: wait for the render manifest response (`page.waitForResponse(/\/render\/manifest\.json/)` registered before clicking tab-design, or the client's real manifest path) before asserting canvas-error has count 0.
M2. pwa.spec.ts: after the controlled reload, poll until the service worker controls the page and every loaded /assets/ URL is in the cache, before going offline.
M3. Comment above the Build-flow test: needs a fresh fake hub (sends the only scripted prompt), so no retries and no reuse.
M4. Build-flow test: also expect build-messages to contain the server's merge message (see apps/server/src/build/ci.ts around line 197 for its exact text), proving the server path.
M5. One-line comment at BuildArea's reset effect: it relies on `api` and `ws` being stable (memoized in App).

Report: append a "Fix round 1" section to task-28-report.txt with the RED/GREEN for I1 and the e2e run output.
