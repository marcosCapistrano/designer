// A hub for the Playwright specs (`pnpm -F @hub/server dev:fake`). It never calls the Claude SDK or GitHub:
// Claude is a script, GitHub is in memory, and the one app lives in a throwaway git checkout under the temp dir.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hashPassphrase } from '../auth/passphrase.js';
import { FakeClaudeRunner } from '../claude/fake.js';
import { openRepo } from '../git/git.js';
import { makeTestRepo, TEST_IDENTITY } from '../git/test-repo.js';
import { FakeGitHub } from '../github/fake.js';
import { startHub } from '../server.js';

// The app manifest of the spec's example, named after the demo app, with build steps that always pass.
const DEMO_MANIFEST = {
  name: 'demo',
  template: 'vite-hono-pg@1',
  design: { dir: 'design', routes: 'web/src/routes.tsx', devices: ['desktop', 'tablet', 'mobile'] },
  build: { install: 'true', typecheck: 'true', test: 'true' },
  deploy: {
    image: 'ghcr.io/marco/demo',
    staging: { server: 'shared-staging', url: 'http://demo.staging.tail1234.ts.net' },
    production: { server: 'shared-production', url: 'https://demo.203.0.113.7.sslip.io', domain: null },
  },
};

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'hub-fake-'));
  const repo = makeTestRepo({
    workDir: join(root, 'apps', 'demo'),
    files: { '.hub/app.json': JSON.stringify(DEMO_MANIFEST), 'app/page.tsx': 'export default () => <main style={{ padding: "32px", color: "#124" }}><h1>Imported demo</h1><button>Start</button></main>' },
  });
  const scratch = [root, dirname(repo.origin)];
  const removeScratch = (): void => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  };

  const passphrase = process.env.HUB_DEV_PASSPHRASE ?? 'hub-dev-passphrase';
  const hub = await startHub({
    config: {
      bind: '127.0.0.1',
      port: Number(process.env.HUB_FAKE_PORT ?? 8787),
      dataDir: join(root, 'data'),
      appsDir: join(root, 'apps'),
      passphraseHash: hashPassphrase(passphrase),
      githubToken: null,
      githubOwner: null,
      claudeOauthToken: null,
    },
    runner: new FakeClaudeRunner([
      [
        async (o) => {
          writeFileSync(join(o.cwd, 'NOTES.md'), `# Notes\n\n${o.prompt}\n`);
        },
        { type: 'text', text: 'Working on it.' },
        (o) => ({ type: 'tool', name: 'Write', input: { file_path: join(o.cwd, 'NOTES.md') } }),
        { type: 'text', text: 'Done.' },
        { type: 'done', sessionId: 'fake-session', ok: true },
      ],
    ]),
    github: new FakeGitHub({ autoGreenAfter: 1 }),
    openRepo: (dir) => openRepo(dir, { identity: TEST_IDENTITY }),
    ciPollMs: 1000,
    clientDir: null,
  }).catch((err: unknown) => {
    removeScratch(); // a taken port, say, must not leave a checkout behind
    throw err;
  });
  console.log(`Fake hub on http://127.0.0.1:${hub.port} (passphrase: ${passphrase})`);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await hub.close();
    } finally {
      removeScratch();
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err: unknown) => {
  console.error(`Fake hub failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
