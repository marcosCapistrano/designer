import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  workers: 1,
  use: { baseURL: 'http://localhost:4174', viewport: { width: 1280, height: 800 } },
  webServer: [
    {
      command: 'pnpm build && pnpm preview --port 4174 --strictPort',
      url: 'http://localhost:4174',
      env: { HUB_DEV_URL: 'http://127.0.0.1:8791' },
      timeout: 180_000,
      reuseExistingServer: false,
    },
    {
      // The fake hub runs under node directly, not through `pnpm dev:fake`: on SIGTERM the pnpm wrapper dies
      // but its tsx/node children would keep port 8787 and the scratch directories.
      command: 'node --import tsx src/dev/fake-hub.ts',
      cwd: fileURLToPath(new URL('../server', import.meta.url)),
      url: 'http://127.0.0.1:8791/api/health',
      env: { HUB_FAKE_PORT: '8791' },
      timeout: 120_000,
      reuseExistingServer: false,
      // SIGTERM lets the hub close its sockets and delete its scratch directories (the default is SIGKILL).
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    },
  ],
});
