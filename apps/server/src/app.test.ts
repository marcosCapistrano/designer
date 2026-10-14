import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildTask } from '@hub/protocol';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRegistry } from './apps/registry.js';
import { LoginLimiter } from './auth/limiter.js';
import { hashPassphrase } from './auth/passphrase.js';
import { SessionStore } from './auth/sessions.js';
import { createApp } from './app.js';
import { BuildError } from './build/ci.js';
import type { BuildService } from './build/service.js';
import { openDb, type Db } from './db.js';

const PASS = 'correct horse battery staple';
const HASH = hashPassphrase(PASS, Buffer.alloc(16, 1));

const TASK: BuildTask = {
  id: 7,
  app: 'demo',
  title: 'Add a button',
  branch: 'build/add-a-button-7',
  base: 'main',
  status: 'review',
  prNumber: 3,
  prUrl: 'https://github.com/marco/demo/pull/3',
  headSha: 'abc123',
  ci: 'success',
  mergeSha: null,
  error: null,
  retryAt: null,
  createdAt: 1,
  updatedAt: 2,
};
const STATE = { running: false, task: TASK, messages: [] };

let db: Db;
let root: string;
let appsDir: string;
let dataDir: string;
let clientDir: string;
let app: Hono;
const build = {
  latestStatus: vi.fn(),
  isRunning: vi.fn(),
  state: vi.fn(),
  send: vi.fn(),
  stop: vi.fn(),
  merge: vi.fn(),
  close: vi.fn(),
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hub-app-'));
  appsDir = join(root, 'apps');
  dataDir = join(root, 'data');
  clientDir = join(root, 'client');
  mkdirSync(join(appsDir, 'demo', '.git'), { recursive: true });
  mkdirSync(join(clientDir, 'assets'), { recursive: true });
  writeFileSync(join(clientDir, 'index.html'), '<p>hub</p>');
  writeFileSync(join(clientDir, 'assets', 'app-1.js'), 'console.log(1)');

  build.latestStatus.mockReset().mockReturnValue('review');
  build.isRunning.mockReset().mockReturnValue(false);
  build.state.mockReset().mockResolvedValue(STATE);
  build.send.mockReset().mockResolvedValue(TASK);
  build.stop.mockReset().mockReturnValue(true);
  build.merge.mockReset().mockResolvedValue(TASK);
  build.close.mockReset().mockResolvedValue(TASK);

  db = openDb(':memory:');
  app = createApp({
    sessions: new SessionStore(db),
    limiter: new LoginLimiter(),
    passphraseHash: HASH,
    registry: new AppRegistry(appsDir),
    build: build as unknown as BuildService,
    dataDir,
    clientDir,
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** Logs in and returns the Cookie header for later requests. */
async function cookie(): Promise<Record<string, string>> {
  const res = await app.request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: PASS }),
  });
  expect(res.status).toBe(204);
  const match = /hub_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!match?.[1]) throw new Error('no session cookie');
  return { cookie: `hub_session=${match[1]}` };
}

function post(path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
  );
}

describe('hub app', () => {
  it('health is public', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('api requires login', async () => {
    const res = await app.request('/api/apps');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not logged in' });
  });

  it('lists apps with build status', async () => {
    const res = await app.request('/api/apps', { headers: await cookie() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { name: 'demo', adopted: false, manifestError: null, buildStatus: 'review', running: false },
    ]);
    expect(build.latestStatus).toHaveBeenCalledWith('demo');
    expect(build.isRunning).toHaveBeenCalledWith('demo');
  });

  it('shows one app and 404s an unknown one', async () => {
    const headers = await cookie();
    const found = await app.request('/api/apps/demo', { headers });
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({
      name: 'demo',
      adopted: false,
      manifestError: null,
      buildStatus: 'review',
      running: false,
    });
    const missing = await app.request('/api/apps/nope', { headers });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Unknown app' });
  });

  it('send returns 202 with the task', async () => {
    const headers = await cookie();
    const res = await post('/api/apps/demo/build/messages', headers, { text: 'add a button' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ task: TASK });
    expect(build.send).toHaveBeenCalledWith('demo', 'add a button');

    for (const body of [{}, { text: 5 }, 'not json']) {
      const bad = await post('/api/apps/demo/build/messages', headers, body);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: 'text is required' });
    }
    expect(build.send).toHaveBeenCalledTimes(1);
  });

  it('BuildError maps to its status', async () => {
    build.send.mockRejectedValue(new BuildError('busy', 409));
    const res = await post('/api/apps/demo/build/messages', await cookie(), { text: 'hi' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'busy' });
  });

  it('other errors are a generic 500 and never leak', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      build.merge.mockRejectedValue(new Error('Validation Failed ghp_secret_token_value'));
      const res = await post('/api/apps/demo/build/tasks/7/merge', await cookie());
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'Internal error' });
      expect(text).not.toContain('ghp_secret_token_value');
      expect(text).not.toContain('Validation Failed');
      expect(text).not.toContain('at ');
      // Logged by message only: no Error object, so no stack trace reaches the log.
      expect(error).toHaveBeenCalledTimes(1);
      for (const arg of error.mock.calls[0] ?? []) expect(typeof arg).toBe('string');
    } finally {
      error.mockRestore();
    }
  });

  it('after must be a number', async () => {
    const headers = await cookie();
    const bad = await app.request('/api/apps/demo/build?after=abc', { headers });
    expect(bad.status).toBe(200);
    expect(build.state).toHaveBeenLastCalledWith('demo', undefined);
    for (const odd of ['-1', '1.5', '', '1e3']) {
      await app.request(`/api/apps/demo/build?after=${odd}`, { headers });
      expect(build.state).toHaveBeenLastCalledWith('demo', undefined);
    }

    const ok = await app.request('/api/apps/demo/build?after=5', { headers });
    expect(await ok.json()).toEqual(STATE);
    expect(build.state).toHaveBeenLastCalledWith('demo', 5);
    await app.request('/api/apps/demo/build?after=0', { headers });
    expect(build.state).toHaveBeenLastCalledWith('demo', 0);
    await app.request('/api/apps/demo/build', { headers });
    expect(build.state).toHaveBeenLastCalledWith('demo', undefined);
  });

  it('stop reports whether a run was stopped', async () => {
    const headers = await cookie();
    const res = await post('/api/apps/demo/build/stop', headers);
    expect(await res.json()).toEqual({ stopped: true });
    expect(build.stop).toHaveBeenCalledWith('demo');
    build.stop.mockReturnValue(false);
    expect(await (await post('/api/apps/demo/build/stop', headers)).json()).toEqual({ stopped: false });
  });

  it('merge and close parse the id', async () => {
    const headers = await cookie();
    for (const action of ['merge', 'close'] as const) {
      const bad = await post(`/api/apps/demo/build/tasks/x/${action}`, headers);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: 'Bad task id' });
      for (const odd of ['1.5', '1e3', '0x10']) {
        expect((await post(`/api/apps/demo/build/tasks/${odd}/${action}`, headers)).status).toBe(400);
      }
      expect(build[action]).not.toHaveBeenCalled();

      const ok = await post(`/api/apps/demo/build/tasks/7/${action}`, headers);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ task: TASK });
      expect(build[action]).toHaveBeenCalledWith('demo', 7);
    }
  });

  it('build routes are behind login', async () => {
    const calls: [string, string][] = [
      ['GET', '/api/apps/demo/build'],
      ['POST', '/api/apps/demo/build/messages'],
      ['POST', '/api/apps/demo/build/stop'],
      ['POST', '/api/apps/demo/build/tasks/7/merge'],
      ['POST', '/api/apps/demo/build/tasks/7/close'],
      ['GET', '/api/apps/demo'],
      ['GET', '/api/nope'],
    ];
    for (const [method, path] of calls) {
      const res = await app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? '{"text":"x"}' : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    for (const fn of Object.values(build)) {
      if (fn !== build.latestStatus && fn !== build.isRunning) expect(fn).not.toHaveBeenCalled();
    }
  });

  it('unknown api paths are 404 once logged in', async () => {
    const res = await app.request('/api/nope', { headers: await cookie() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('render routes are behind login', async () => {
    const denied = await app.request('/api/apps/demo/render/manifest.json');
    expect(denied.status).toBe(401);
    const res = await app.request('/api/apps/demo/render/manifest.json', { headers: await cookie() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1, pages: [] });
    const unknown = await app.request('/api/apps/nope/render/manifest.json', { headers: await cookie() });
    expect(unknown.status).toBe(404);
  });

  it('serves the client without login', async () => {
    const index = await app.request('/');
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('hub');
    expect(index.headers.get('cache-control')).toBe('no-cache');

    const asset = await app.request('/assets/app-1.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('caches by position under clientDir, not by where clientDir lives', async () => {
    const nested = join(root, 'assets', 'client');
    mkdirSync(join(nested, 'assets'), { recursive: true });
    writeFileSync(join(nested, 'index.html'), '<p>nested</p>');
    writeFileSync(join(nested, 'assets', 'app-2.js'), 'console.log(2)');
    const other = createApp({
      sessions: new SessionStore(db),
      limiter: new LoginLimiter(),
      passphraseHash: HASH,
      registry: new AppRegistry(appsDir),
      build: build as unknown as BuildService,
      dataDir,
      clientDir: nested,
    });
    expect((await other.request('/')).headers.get('cache-control')).toBe('no-cache');
    expect((await other.request('/assets/app-2.js')).headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('serves no client when clientDir is unset', async () => {
    const bare = createApp({
      sessions: new SessionStore(db),
      limiter: new LoginLimiter(),
      passphraseHash: HASH,
      registry: new AppRegistry(appsDir),
      build: build as unknown as BuildService,
      dataDir,
    });
    expect((await bare.request('/')).status).toBe(404);
    expect((await bare.request('/api/health')).status).toBe(200);
  });

  it('sets security headers', async () => {
    const res = await app.request('/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
