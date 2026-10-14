import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassphrase } from './auth/passphrase.js';

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
const MAIN = join(SERVER_DIR, 'src', 'main.ts');
const CLIENT_INDEX = fileURLToPath(new URL('../../client/dist/index.html', import.meta.url));
const HASH = hashPassphrase('correct horse battery staple', Buffer.alloc(16, 1));
const WAIT_MS = 20_000;
const POLL_MS = 25;

/** Throws from a SIGUSR2 handler and rejects from a SIGHUP handler, so a test can trigger either crash. */
const CRASH_HOOKS = `data:text/javascript,${encodeURIComponent(`
process.on('SIGUSR2', () => { throw new Error('boom token=abc\\nsecond line'); });
process.on('SIGHUP', () => { Promise.reject(new Error('refused ghp_secret')); });
`)}`;

interface Launched {
  child: ChildProcess;
  output(): string;
  exited: Promise<number | null>;
  waitFor(pattern: RegExp): Promise<void>;
}

let root: string;
let children: ChildProcess[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hub-main-'));
  children = [];
});

afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Runs main.ts under tsx with only the given environment, so nothing of the test runner's own leaks in. */
function launch(env: Record<string, string>, preload: string[] = []): Launched {
  const child = spawn(process.execPath, ['--import', 'tsx', ...preload.flatMap((p) => ['--import', p]), MAIN], {
    cwd: SERVER_DIR,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? root, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let text = '';
  child.stdout?.on('data', (d: Buffer) => (text += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (text += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  const waitFor = async (pattern: RegExp): Promise<void> => {
    for (let waited = 0; !pattern.test(text); waited += POLL_MS) {
      if (child.exitCode !== null) throw new Error(`exited ${child.exitCode} before ${pattern}: ${text}`);
      if (waited >= WAIT_MS) throw new Error(`timed out waiting for ${pattern}: ${text}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  };
  return { child, output: () => text, exited, waitFor };
}

async function validEnv(): Promise<Record<string, string> & { HUB_PORT: string }> {
  return {
    HUB_BIND: '127.0.0.1',
    HUB_PORT: String(await freePort()),
    HUB_DATA_DIR: join(root, 'data'),
    HUB_APPS_DIR: join(root, 'apps'),
    HUB_PASSPHRASE_HASH: HASH,
  };
}

describe('main', () => {
  it('serves on HUB_BIND:HUB_PORT, says whether the client build was found, and exits 0 on SIGTERM', async () => {
    const env = await validEnv();
    const hub = launch(env);

    await hub.waitFor(new RegExp(`Hub listening on http://127\\.0\\.0\\.1:${env.HUB_PORT}`));
    const health = await fetch(`http://127.0.0.1:${env.HUB_PORT}/api/health`);
    expect(health.status).toBe(200);
    const notice = 'Client build not found; run pnpm -F @hub/client build';
    expect(hub.output().includes(notice)).toBe(!existsSync(CLIENT_INDEX));

    hub.child.kill('SIGTERM');

    expect(await hub.exited).toBe(0);
    await expect(fetch(`http://127.0.0.1:${env.HUB_PORT}/api/health`)).rejects.toThrow();
  });

  it('exits 0 on SIGINT too', async () => {
    const hub = launch(await validEnv());
    await hub.waitFor(/Hub listening on/);

    hub.child.kill('SIGINT');

    expect(await hub.exited).toBe(0);
  });

  it('prints a configuration error without a stack and exits 1', async () => {
    const hub = launch({ ...(await validEnv()), HUB_BIND: '0.0.0.0' });

    expect(await hub.exited).toBe(1);
    expect(hub.output()).toContain('HUB_BIND must be one specific address');
    expect(hub.output()).not.toMatch(/\n\s+at /);
  });

  it('names every missing setting', async () => {
    const hub = launch({});

    expect(await hub.exited).toBe(1);
    expect(hub.output()).toContain(
      'Missing required environment variables: HUB_BIND, HUB_DATA_DIR, HUB_APPS_DIR, HUB_PASSPHRASE_HASH',
    );
  });

  it('a startup failure such as a taken port is one line and exit 1', async () => {
    const env = await validEnv();
    const first = launch(env);
    await first.waitFor(/Hub listening on/);
    const second = launch({ ...env, HUB_DATA_DIR: join(root, 'data2') });

    expect(await second.exited).toBe(1);
    expect(second.output()).toContain('EADDRINUSE');
    expect(second.output()).not.toMatch(/\n\s+at /);
  });

  it('an uncaught exception is logged as one line, message only, and exits 1', async () => {
    const hub = launch(await validEnv(), [CRASH_HOOKS]);
    await hub.waitFor(/Hub listening on/);

    hub.child.kill('SIGUSR2');

    expect(await hub.exited).toBe(1);
    expect(hub.output()).toContain('Uncaught exception: "boom token=abc\\nsecond line"');
    expect(hub.output()).not.toMatch(/\n\s+at /);
  });

  it('an unhandled rejection is logged as one line and exits 1', async () => {
    const hub = launch(await validEnv(), [CRASH_HOOKS]);
    await hub.waitFor(/Hub listening on/);

    hub.child.kill('SIGHUP');

    expect(await hub.exited).toBe(1);
    expect(hub.output()).toContain('Unhandled rejection: "refused ghp_secret"');
    expect(hub.output()).not.toMatch(/\n\s+at /);
  });
});
