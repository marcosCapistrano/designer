import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BuildTask, ServerMsg } from '@hub/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { hashPassphrase } from './auth/passphrase.js';
import { SESSION_TTL_MS } from './auth/sessions.js';
import { FakeClaudeRunner } from './claude/fake.js';
import type { CommandResult, RunCommand } from './build/commands.js';
import { BuildStore } from './build/store.js';
import type { HubConfig } from './config.js';
import { openDb } from './db.js';
import { openRepo } from './git/git.js';
import { makeTestRepo, TEST_IDENTITY } from './git/test-repo.js';
import { FakeGitHub } from './github/fake.js';
import type { CiStatus, RepoRef } from './github/github.js';
import { type HubOptions, hubUrl, type RunningHub, startHub } from './server.js';

const PASS = 'correct horse battery staple';
const HASH = hashPassphrase(PASS, Buffer.alloc(16, 1));
const OK: CommandResult = { ok: true, code: 0, output: '', timedOut: false, aborted: false };
const alwaysOk: RunCommand = async () => OK;
const LIVE_MS = 5000;
/** Heartbeat interval for tests that wait on a real heartbeat: quick, but long enough not to flake under load. */
const HEARTBEAT_TEST_MS = 250;
const START_MS = 1_800_000_000_000;

let root: string;
let dataDir: string;
let appsDir: string;
let originDirs: string[];
let started: RunningHub[];
let clients: WebSocket[];
let lines: string[];
let clock: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hub-server-'));
  dataDir = join(root, 'data');
  appsDir = join(root, 'apps');
  mkdirSync(appsDir, { recursive: true });
  originDirs = [dirname(makeTestRepo({ workDir: join(appsDir, 'demo') }).origin)];
  started = [];
  clients = [];
  lines = [];
  clock = START_MS;
});

afterEach(async () => {
  for (const client of clients) client.terminate();
  for (const hub of started) await hub.close();
  rmSync(root, { recursive: true, force: true });
  for (const dir of originDirs) rmSync(dir, { recursive: true, force: true });
});

function configFor(over: Partial<HubConfig> = {}): HubConfig {
  return {
    bind: '127.0.0.1',
    port: 0,
    dataDir,
    appsDir,
    passphraseHash: HASH,
    githubToken: null,
    githubOwner: null,
    claudeOauthToken: null,
    ...over,
  };
}

async function start(over: Partial<HubOptions> = {}): Promise<RunningHub> {
  const hub = await startHub({
    config: configFor(),
    runner: new FakeClaudeRunner([[{ type: 'text', text: 'Hi' }, { type: 'done', sessionId: 's', ok: true }]]),
    github: new FakeGitHub(),
    clientDir: null,
    openRepo: (dir) => openRepo(dir, { identity: TEST_IDENTITY }),
    runCommand: alwaysOk,
    now: () => clock,
    log: (line) => lines.push(line),
    ...over,
  });
  started.push(hub);
  return hub;
}

/** Logs in and returns the `hub_session=...` cookie pair. */
async function login(url: string, passphrase = PASS): Promise<string> {
  const res = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase }),
  });
  expect(res.status).toBe(204);
  const pair = /hub_session=[^;]+/.exec(res.headers.get('set-cookie') ?? '')?.[0];
  if (pair === undefined) throw new Error('no session cookie');
  return pair;
}

function wsUrl(url: string): string {
  return `${url.replace('http', 'ws')}/ws`;
}

function connect(url: string, headers: Record<string, string> = {}): WebSocket {
  const client = new WebSocket(wsUrl(url), { headers });
  clients.push(client);
  return client;
}

function opened(client: WebSocket): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    client.once('open', () => resolve(client));
    client.once('error', reject);
  });
}

function refusedStatus(client: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    client.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    client.on('open', () => reject(new Error('connection was accepted')));
    client.on('error', reject);
  });
}

function closedWithin(client: WebSocket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (client.readyState === WebSocket.CLOSED) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    client.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Collects every server message a socket receives. */
function collect(client: WebSocket): ServerMsg[] {
  const seen: ServerMsg[] = [];
  client.on('message', (data) => seen.push(JSON.parse(data.toString()) as ServerMsg));
  return seen;
}

function sendMessage(url: string, cookie: string, text: string): Promise<Response> {
  return fetch(`${url}/api/apps/demo/build/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text }),
  });
}

function logout(url: string, cookie: string): Promise<Response> {
  return fetch(`${url}/api/logout`, { method: 'POST', headers: { cookie, 'sec-fetch-site': 'same-origin' } });
}

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

describe('startHub', () => {
  it('serves health and refuses anonymous websockets', async () => {
    const hub = await start();

    const health = await fetch(`${hub.url}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    expect(await refusedStatus(connect(hub.url))).toBe(401);
    expect(hub.hub.size()).toBe(0);
  });

  it('a logged-in socket receives build messages', async () => {
    const hub = await start();
    const cookie = await login(hub.url);
    const socket = await opened(connect(hub.url, { cookie }));
    const seen = collect(socket);

    const res = await sendMessage(hub.url, cookie, 'Say hi');

    expect(res.status).toBe(202);
    await expect
      .poll(() => seen.some((m) => m.type === 'build.message' && m.message.text === 'Hi'), { timeout: LIVE_MS })
      .toBe(true);
  });

  it('listens where it says it does, and logs the address', async () => {
    const hub = await start();

    expect(hub.port).toBeGreaterThan(0);
    expect(hub.url).toBe(`http://127.0.0.1:${hub.port}`);
    expect(lines).toContain(`Hub listening on http://127.0.0.1:${hub.port}`);
  });

  it('close stops listening', async () => {
    const hub = await start();
    expect((await fetch(`${hub.url}/api/health`)).status).toBe(200);

    await hub.close();

    await expect(fetch(`${hub.url}/api/health`)).rejects.toThrow();
  });

  it('close closes open sockets, is safe to call twice, and a new hub can start on the same data', async () => {
    const hub = await start();
    const cookie = await login(hub.url);
    const socket = await opened(connect(hub.url, { cookie }));

    await Promise.all([hub.close(), hub.close()]);

    expect(await closedWithin(socket, 1000)).toBe(true);
    const again = await start();
    expect((await fetch(`${again.url}/api/health`)).status).toBe(200);
  });

  it('close aborts a running build and waits for it to end', async () => {
    const hub = await start({
      runner: new FakeClaudeRunner([
        [
          async (o) => {
            await new Promise<void>((resolve) => {
              if (o.signal?.aborted) resolve();
              o.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
          },
        ],
      ]),
    });
    const cookie = await login(hub.url);
    expect((await sendMessage(hub.url, cookie, 'Take your time')).status).toBe(202);
    expect(hub.build.isRunning('demo')).toBe(true);

    await hub.close();

    expect(hub.build.isRunning('demo')).toBe(false);
  });

  it('a port that is taken fails startup, and the hub that holds it keeps serving', async () => {
    const first = await start();
    const second = start({ config: configFor({ port: first.port, dataDir: join(root, 'data2') }) });

    await expect(second).rejects.toMatchObject({ code: 'EADDRINUSE' });

    expect((await fetch(`${first.url}/api/health`)).status).toBe(200);
  });

  it('binds the port it is given', async () => {
    const port = await freePort();

    const hub = await start({ config: configFor({ port }) });

    expect(hub.port).toBe(port);
    expect(hub.url).toBe(`http://127.0.0.1:${port}`);
  });

  it('a bind address it cannot use fails startup', async () => {
    await expect(start({ config: configFor({ bind: '203.0.113.250' }) })).rejects.toBeInstanceOf(Error);
  });
});

describe('hubUrl', () => {
  it('brackets an IPv6 address and leaves a name or IPv4 address alone', () => {
    expect(hubUrl('127.0.0.1', 8080)).toBe('http://127.0.0.1:8080');
    expect(hubUrl('localhost', 8080)).toBe('http://localhost:8080');
    expect(hubUrl('::1', 8080)).toBe('http://[::1]:8080');
    expect(hubUrl('[::1]', 8080)).toBe('http://[::1]:8080');
  });
});

describe('startHub teardown', () => {
  it('a failure after listening takes the port down again', async () => {
    const port = await freePort();
    const log = (line: string): void => {
      if (line.startsWith('Hub listening')) throw new Error('log sink broke');
    };

    await expect(start({ config: configFor({ port }), log })).rejects.toThrow('log sink broke');

    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  });

  it('close waits for a CI poll that is mid-way, so its write lands before the database closes', async () => {
    let entered = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = false;
    class GatedGitHub extends FakeGitHub {
      override async checkStatus(r: RepoRef, sha: string): Promise<CiStatus> {
        if (armed) {
          entered = true;
          await gate;
          this.setChecks(sha, [{ name: 'ci', status: 'completed', conclusion: 'success' }]);
        }
        return super.checkStatus(r, sha);
      }
    }
    const hub = await start({
      github: new GatedGitHub({ autoGreenAfter: 1 }),
      ciPollMs: 30,
      runner: new FakeClaudeRunner([
        [
          (o) => {
            writeFileSync(join(o.cwd, 'NOTES.md'), 'notes\n');
          },
          { type: 'done', sessionId: 's', ok: true },
        ],
      ]),
    });
    const cookie = await login(hub.url);
    const seen = collect(await opened(connect(hub.url, { cookie })));
    expect((await sendMessage(hub.url, cookie, 'Write notes')).status).toBe(202);
    await expect
      .poll(() => seen.some((m) => m.type === 'build.task' && m.task.status === 'review'), { timeout: 20_000 })
      .toBe(true);
    armed = true;
    await expect.poll(() => entered, { timeout: 20_000 }).toBe(true);

    const closing = hub.close();
    setTimeout(release, 150);
    await closing;

    const db = openDb(join(dataDir, 'hub.sqlite'));
    try {
      expect(new BuildStore(db, () => START_MS).latestTask('demo')?.ci).toBe('success');
    } finally {
      db.close();
    }
  });
});

describe('startHub bookkeeping', () => {
  it('purges sessions that expired while the hub was down, using the injected clock', async () => {
    const seed = openDb(join(dataDir, 'hub.sqlite'));
    const insert = seed.prepare('INSERT INTO auth_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)');
    insert.run('expired', START_MS - 10, START_MS - 1);
    insert.run('live', START_MS - 10, START_MS + 1000);
    seed.close();

    await start();

    const check = openDb(join(dataDir, 'hub.sqlite'));
    try {
      const rows = check.prepare('SELECT token_hash FROM auth_sessions').all() as { token_hash: string }[];
      expect(rows.map((r) => r.token_hash)).toEqual(['live']);
    } finally {
      check.close();
    }
  });

  it('marks tasks a restart interrupted as failed and says so', async () => {
    const seed = openDb(join(dataDir, 'hub.sqlite'));
    const task = new BuildStore(seed, () => START_MS).createTask({
      app: 'demo',
      title: 'Half done',
      branch: 'build/half-done-1',
      base: 'main',
    });
    seed.close();

    const hub = await start();

    expect(lines).toContain('Marked 1 interrupted build task(s) as failed');
    const cookie = await login(hub.url);
    const state = (await (
      await fetch(`${hub.url}/api/apps/demo/build`, { headers: { cookie } })
    ).json()) as { task: BuildTask | null };
    expect(state.task?.id).toBe(task.id);
    expect(state.task?.status).toBe('failed');
  });

  it('says nothing about interrupted tasks when there are none', async () => {
    await start();

    expect(lines.filter((l) => l.startsWith('Marked'))).toEqual([]);
  });

  it('stamps tasks with the injected clock', async () => {
    const hub = await start();
    const cookie = await login(hub.url);

    const res = await sendMessage(hub.url, cookie, 'Say hi');

    const body = (await res.json()) as { task: BuildTask };
    expect(body.task.createdAt).toBe(START_MS);
  });

  it('locks logins out by the injected clock', async () => {
    const hub = await start();
    const wrong = (): Promise<Response> =>
      fetch(`${hub.url}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passphrase: 'not it' }),
      });
    for (let i = 0; i < 5; i += 1) expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(429);

    clock += 15 * 60_000;

    expect((await wrong()).status).toBe(401);
  });

  it('polls CI on its own timer until a green PR is announced', async () => {
    const github = new FakeGitHub({ autoGreenAfter: 1 });
    const hub = await start({
      github,
      ciPollMs: 40,
      runner: new FakeClaudeRunner([
        [
          (o) => {
            writeFileSync(join(o.cwd, 'NOTES.md'), 'notes\n');
          },
          { type: 'done', sessionId: 's', ok: true },
        ],
      ]),
    });
    const cookie = await login(hub.url);
    const socket = await opened(connect(hub.url, { cookie }));
    const seen = collect(socket);

    expect((await sendMessage(hub.url, cookie, 'Write notes')).status).toBe(202);

    await expect
      .poll(() => seen.some((m) => m.type === 'build.task' && m.task.ci === 'success'), { timeout: 20_000 })
      .toBe(true);
    expect(github.calls).toContain('createPr');
  });
});

describe('startHub sockets and sessions', () => {
  it('closes a socket within a second of its session logging out, and leaves other sessions open', async () => {
    const hub = await start();
    const mine = await login(hub.url);
    const other = await login(hub.url);
    const mineSocket = await opened(connect(hub.url, { cookie: mine }));
    const otherSocket = await opened(connect(hub.url, { cookie: other }));
    expect(hub.hub.size()).toBe(2);

    expect((await logout(hub.url, mine)).status).toBe(204);

    expect(await closedWithin(mineSocket, 1000)).toBe(true);
    expect(otherSocket.readyState).toBe(WebSocket.OPEN);
    await expect.poll(() => hub.hub.size(), { timeout: 1000 }).toBe(1);
  });

  it('closes a socket once its session expires, on the next heartbeat', async () => {
    const hub = await start({ heartbeatMs: HEARTBEAT_TEST_MS });
    const cookie = await login(hub.url);
    const socket = await opened(connect(hub.url, { cookie }));

    clock += SESSION_TTL_MS;

    expect(await closedWithin(socket, 4 * LIVE_MS)).toBe(true);
  });

  it('keeps a socket whose session is still valid across heartbeats', async () => {
    const hub = await start({ heartbeatMs: HEARTBEAT_TEST_MS });
    const cookie = await login(hub.url);
    const socket = await opened(connect(hub.url, { cookie }));
    const seen = collect(socket);

    clock += SESSION_TTL_MS - 1;
    expect(await closedWithin(socket, 3 * HEARTBEAT_TEST_MS)).toBe(false);

    hub.hub.broadcast({ type: 'pong', t: 4 });
    await expect.poll(() => seen.length, { timeout: LIVE_MS }).toBe(1);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('connects with a matching Origin and with none, and refuses a cross-site Origin', async () => {
    const hub = await start();
    const cookie = await login(hub.url);

    await opened(connect(hub.url, { cookie, origin: hub.url }));
    await opened(connect(hub.url, { cookie }));
    expect(await refusedStatus(connect(hub.url, { cookie, origin: 'https://other.tailnet.ts.net' }))).toBe(403);

    expect(hub.hub.size()).toBe(2);
  });

  it('a malformed cookie header is refused, not fatal', async () => {
    const hub = await start();

    expect(await refusedStatus(connect(hub.url, { cookie: 'hub_session=%%%not-a-session' }))).toBe(401);

    expect((await fetch(`${hub.url}/api/health`)).status).toBe(200);
  });
});
