import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

/** Logs in and returns the headers a same-origin browser tab sends afterwards: the cookie and Sec-Fetch-Site. */
async function cookie(): Promise<Record<string, string>> {
  const res = await app.request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: PASS }),
  });
  expect(res.status).toBe(204);
  const match = /hub_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!match?.[1]) throw new Error('no session cookie');
  return { cookie: `hub_session=${match[1]}`, 'sec-fetch-site': 'same-origin' };
}

/** Like ApiClient: a JSON content type only when there is a body. `headers` may override it. */
function post(path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
  );
}

const BIG = 'x'.repeat(300 * 1024);

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
      expect(error.mock.calls[0]?.[0]).toBe(
        'Unhandled error on POST "/api/apps/demo/build/tasks/7/merge": "Validation Failed ghp_secret_token_value"',
      );
    } finally {
      error.mockRestore();
    }
  });

  it('a long or multi-line error message is truncated and escaped in the log', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      build.merge.mockRejectedValue(new Error(`first line\nforged log line ${'y'.repeat(2000)}`));
      const res = await post('/api/apps/demo/build/tasks/7/merge', await cookie());
      expect(res.status).toBe(500);
      const line = String(error.mock.calls[0]?.[0]);
      expect(line).not.toContain('\n');
      expect(line).toContain('first line\\nforged log line');
      expect(line.length).toBeLessThan(700);
    } finally {
      error.mockRestore();
    }
  });

  it('a non-Error rejection is a generic 500 with security headers', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      build.merge.mockRejectedValue('boom ghp_secret_token_value');
      const res = await post('/api/apps/demo/build/tasks/7/merge', await cookie());
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const text = await res.text();
      expect(text).toBe('{"error":"Internal error"}');
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it('stop on an unknown app is 404 and does not reach the service', async () => {
    const res = await post('/api/apps/nope/build/stop', await cookie());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Unknown app' });
    expect(build.stop).not.toHaveBeenCalled();
  });

  describe('request body limit', () => {
    it('login refuses a 300 KB body with 413, with or without a Content-Length', async () => {
      const body = JSON.stringify({ passphrase: BIG });
      const plain = await app.request('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(plain.status).toBe(413);
      expect(await plain.json()).toEqual({ error: 'Request too large' });
      const sized = await app.request('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
        body,
      });
      expect(sized.status).toBe(413);
    });

    it('messages refuses a 300 KB body and never calls send', async () => {
      const headers = await cookie();
      const body = JSON.stringify({ text: BIG });
      const res = await post('/api/apps/demo/build/messages', headers, body);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'Request too large' });
      const sizedHeaders = { ...headers, 'content-length': String(Buffer.byteLength(body)) };
      const sized = await post('/api/apps/demo/build/messages', sizedHeaders, body);
      expect(sized.status).toBe(413);
      expect(build.send).not.toHaveBeenCalled();
    });

    it('a chunked body with no Content-Length is counted too', async () => {
      const headers = await cookie();
      const chunk = new TextEncoder().encode('x'.repeat(100 * 1024));
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 3) controller.close();
          else {
            controller.enqueue(chunk);
            sent += 1;
          }
        },
      });
      const res = await app.request('/api/apps/demo/build/messages', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit);
      expect(res.status).toBe(413);
      expect(build.send).not.toHaveBeenCalled();
    });

    it('a body under the limit still passes', async () => {
      const res = await post('/api/apps/demo/build/messages', await cookie(), { text: 'x'.repeat(250_000) });
      expect(res.status).toBe(202);
      expect(build.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('csrf', () => {
    it('refuses a same-site form-typed post and never calls the service', async () => {
      const headers = { ...(await cookie()), 'sec-fetch-site': 'same-site', 'content-type': 'text/plain' };
      const res = await post('/api/apps/demo/build/messages', headers, '{"text":"do it"}');
      expect(res.status).toBe(403);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(build.send).not.toHaveBeenCalled();
    });

    it('refuses a bodyless same-site post', async () => {
      const headers = { ...(await cookie()), 'sec-fetch-site': 'same-site' };
      for (const action of ['merge', 'close'] as const) {
        const res = await post(`/api/apps/demo/build/tasks/7/${action}`, headers);
        expect(res.status).toBe(403);
        expect(build[action]).not.toHaveBeenCalled();
      }
      expect((await post('/api/apps/demo/build/stop', headers)).status).toBe(403);
      expect(build.stop).not.toHaveBeenCalled();
    });

    it('refuses a cross-site post and one with no origin information', async () => {
      const base = await cookie();
      const cross = await post('/api/apps/demo/build/stop', { ...base, 'sec-fetch-site': 'cross-site' });
      expect(cross.status).toBe(403);
      const { 'sec-fetch-site': _omitted, ...bare } = base;
      expect((await post('/api/apps/demo/build/stop', bare)).status).toBe(403);
      expect(build.stop).not.toHaveBeenCalled();
    });

    it('accepts a same-origin JSON post and a same-origin bodyless post', async () => {
      const headers = await cookie();
      expect(headers['sec-fetch-site']).toBe('same-origin');
      const json = await post('/api/apps/demo/build/messages', headers, { text: 'go' });
      expect(json.status).toBe(202);
      const bodyless = await post('/api/apps/demo/build/tasks/7/merge', headers);
      expect(bodyless.status).toBe(200);
      const viaOrigin = await post('/api/apps/demo/build/stop', {
        cookie: headers.cookie ?? '',
        origin: 'http://localhost',
      });
      expect(viaOrigin.status).toBe(200);
    });

    it('logout, a bodyless post, is allowed same-origin', async () => {
      const res = await post('/api/logout', await cookie());
      expect(res.status).toBe(204);
    });
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

  describe('static file safety', () => {
    let outside: string;

    beforeEach(() => {
      outside = join(root, 'outside');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'secret.txt'), 'top secret');
      writeFileSync(join(clientDir, '.env'), 'TOKEN=1');
      mkdirSync(join(clientDir, '.git'), { recursive: true });
      writeFileSync(join(clientDir, '.git', 'config'), '[core]');
      mkdirSync(join(clientDir, 'assets', '.hidden'), { recursive: true });
      writeFileSync(join(clientDir, 'assets', '.hidden', 'x.js'), 'x');
      symlinkSync(join(outside, 'secret.txt'), join(clientDir, 'link.txt'));
      symlinkSync(outside, join(clientDir, 'linkdir'));
      symlinkSync(join(clientDir, 'index.html'), join(clientDir, 'inside-link.html'));
    });

    it('404s dotfiles and dot directories, however the dot is spelled', async () => {
      for (const path of ['/.env', '/%2eenv', '/.git/config', '/%2egit/config', '/assets/.hidden/x.js']) {
        const res = await app.request(path);
        expect(res.status, path).toBe(404);
        expect(await res.text(), path).not.toContain('TOKEN');
      }
    });

    it('404s a symlink that leaves clientDir, file or directory', async () => {
      for (const path of ['/link.txt', '/linkdir/secret.txt', '/linkdir/']) {
        const res = await app.request(path);
        expect(res.status, path).toBe(404);
        expect(await res.text(), path).not.toContain('top secret');
      }
    });

    it('404s an index.html symlinked out of clientDir', async () => {
      mkdirSync(join(clientDir, 'sub'));
      writeFileSync(join(outside, 'index.html'), 'outside index');
      symlinkSync(join(outside, 'index.html'), join(clientDir, 'sub', 'index.html'));
      const res = await app.request('/sub/');
      expect(res.status).toBe(404);
    });

    it('still serves a symlink that stays inside clientDir', async () => {
      const res = await app.request('/inside-link.html');
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('hub');
    });

    it('404s traversal spelled with encoded dots or slashes', async () => {
      writeFileSync(join(root, 'x'), 'above clientDir');
      for (const path of ['/%2e%2e/x', '/..%2fx', '/../x', '/%2e%2e%2fx', '/assets/..%2f..%2fx']) {
        const res = await app.request(path);
        expect(res.status, path).toBe(404);
        expect(await res.text(), path).not.toContain('above clientDir');
      }
    });

    it('keeps the immutable Cache-Control on HEAD', async () => {
      const res = await app.request('/assets/app-1.js', { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(await res.text()).toBe('');
    });
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

  it('logout calls onLogout', async () => {
    const onLogout = vi.fn();
    const withHook = createApp({
      sessions: new SessionStore(db),
      limiter: new LoginLimiter(),
      passphraseHash: HASH,
      registry: new AppRegistry(appsDir),
      build: build as unknown as BuildService,
      dataDir,
      onLogout,
    });
    const login = await withHook.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: PASS }),
    });
    const token = /hub_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
    expect(onLogout).not.toHaveBeenCalled();

    const out = await withHook.request('/api/logout', {
      method: 'POST',
      headers: { cookie: `hub_session=${token}`, 'sec-fetch-site': 'same-origin' },
    });

    expect(out.status).toBe(204);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('sets security headers', async () => {
    const res = await app.request('/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
