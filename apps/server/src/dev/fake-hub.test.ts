import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildState, BuildTask } from '@hub/protocol';
import { afterEach, describe, expect, it } from 'vitest';

const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url));
const FAKE_HUB = join(SERVER_DIR, 'src', 'dev', 'fake-hub.ts');
const WAIT_MS = 30_000;
const POLL_MS = 50;

let children: ChildProcess[] = [];
let temp: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
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

async function until<T>(read: () => Promise<T | null> | T | null, what: string): Promise<T> {
  for (let waited = 0; waited < WAIT_MS; waited += POLL_MS) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('fake hub', () => {
  it('runs a whole Build task with no SDK and no GitHub, and cleans up after itself', async () => {
    // The fake hub gets its own TMPDIR, so what it leaves behind cannot be confused with other tests' folders.
    const tempDir = mkdtempSync(join(tmpdir(), 'hub-fake-test-'));
    temp.push(tempDir);
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', FAKE_HUB], {
      cwd: SERVER_DIR,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? tempDir,
        TMPDIR: tempDir,
        HUB_FAKE_PORT: String(port),
        HUB_DEV_PASSPHRASE: 'e2e-passphrase',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
    const base = `http://127.0.0.1:${port}`;

    await until(() => {
      if (child.exitCode !== null) throw new Error(`fake hub exited ${child.exitCode}: ${output}`);
      return output.includes(`Fake hub on ${base} (passphrase: e2e-passphrase)`) ? true : null;
    }, 'the banner');
    expect((await (await fetch(`${base}/api/health`)).json()) as unknown).toEqual({ ok: true });

    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 'e2e-passphrase' }),
    });
    expect(login.status).toBe(204);
    const cookie = /hub_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')?.[0] ?? '';
    const headers = { cookie, 'content-type': 'application/json' };

    const apps = (await (await fetch(`${base}/api/apps`, { headers })).json()) as { name: string; adopted: boolean }[];
    expect(apps.map((a) => [a.name, a.adopted])).toEqual([['demo', true]]);

    const sent = await fetch(`${base}/api/apps/demo/build/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'Add a notes file' }),
    });
    expect(sent.status).toBe(202);

    const reviewed = await until(async () => {
      const state = (await (await fetch(`${base}/api/apps/demo/build`, { headers })).json()) as BuildState;
      return state.task?.status === 'review' && state.task.ci === 'success' ? state : null;
    }, 'a green review task');
    expect(reviewed.messages.map((m) => m.text)).toEqual(
      expect.arrayContaining(['Add a notes file', 'Working on it.', 'Done.']),
    );
    const task = reviewed.task as BuildTask;
    expect(task.prNumber).toBe(1);

    const merged = await fetch(`${base}/api/apps/demo/build/tasks/${task.id}/merge`, { method: 'POST', headers });
    expect(merged.status).toBe(200);
    expect(((await merged.json()) as { task: BuildTask }).task.status).toBe('merged');

    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    // tsx keeps its own tsx-<uid> folder in TMPDIR; everything else the fake hub made must be gone.
    expect(readdirSync(tempDir).filter((name) => !name.startsWith('tsx-'))).toEqual([]);
  });
});
