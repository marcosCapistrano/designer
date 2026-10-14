import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../db.js';
import { LoginLimiter } from './limiter.js';
import { hashPassphrase, verifyPassphrase } from './passphrase.js';
import { authRoutes } from './routes.js';
import { SESSION_TTL_MS, SessionStore, readCookie, requireAuth } from './sessions.js';

// Wraps the real verifier in a spy, so a test can see whether a request reached it.
vi.mock('./passphrase.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./passphrase.js')>();
  return { ...actual, verifyPassphrase: vi.fn(actual.verifyPassphrase) };
});

const PASS = 'correct horse battery staple';
const HASH = hashPassphrase(PASS, Buffer.alloc(16, 1));

let db: Db;
let sessions: SessionStore;
let app: Hono;

beforeEach(() => {
  db = openDb(':memory:');
  sessions = new SessionStore(db);
  app = new Hono();
  app.route('/api', authRoutes({ sessions, limiter: new LoginLimiter(), passphraseHash: HASH }));
  app.use('/api/secret', requireAuth(sessions));
  app.get('/api/secret', (c) => c.json({ ok: true }));
});

afterEach(() => {
  db.close();
});

/** A separate app with its own limiter and clock, for the lock tests. */
function appWith(limiter: LoginLimiter, now?: () => number): Hono {
  const other = new Hono();
  other.route('/api', authRoutes({ sessions, limiter, passphraseHash: HASH, now }));
  return other;
}

async function loginVia(target: Hono, passphrase: string): Promise<Response> {
  return target.request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase }),
  });
}

function login(passphrase: string): Promise<Response> {
  return loginVia(app, passphrase);
}

function tokenFrom(res: Response): string {
  const header = res.headers.get('set-cookie') ?? '';
  const match = /hub_session=([^;]+)/.exec(header);
  if (!match?.[1]) throw new Error(`no session cookie in set-cookie: ${header}`);
  return match[1];
}

describe('auth routes', () => {
  it('login sets an httpOnly strict secure cookie', async () => {
    const res = await login(PASS);
    expect(res.status).toBe(204);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('hub_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=2592000');
  });

  it('cookie opens protected routes', async () => {
    const token = tokenFrom(await login(PASS));
    const ok = await app.request('/api/secret', { headers: { cookie: `hub_session=${token}` } });
    expect(ok.status).toBe(200);
    const denied = await app.request('/api/secret');
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: 'Not logged in' });
  });

  it('wrong passphrase is 401', async () => {
    const res = await login('wrong passphrase entirely');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Wrong passphrase' });
  });

  it('sixth attempt is rate limited', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await login('nope')).status).toBe(401);
    }
    const res = await login(PASS);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many attempts. Try again in 15 minutes.' });
  });

  it('concurrent wrong logins cannot exceed the limit', async () => {
    const local = appWith(new LoginLimiter(), () => 1_000);
    const statuses = await Promise.all(
      Array.from({ length: 8 }, () => loginVia(local, 'wrong').then((res) => res.status)),
    );
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
  });

  it('locked attempts do not extend the lock', async () => {
    let t = 0;
    const local = appWith(new LoginLimiter(), () => t);
    for (t = 0; t < 5; t += 1) {
      expect((await loginVia(local, 'wrong')).status).toBe(401);
    }
    t = 600_000;
    for (let i = 0; i < 6; i += 1) {
      expect((await loginVia(local, i % 2 === 0 ? 'wrong' : PASS)).status).toBe(429);
    }
    t = 900_004;
    expect((await loginVia(local, PASS)).status).toBe(204);
  });

  it('a blocked attempt never reaches the passphrase check', async () => {
    let t = 0;
    const local = appWith(new LoginLimiter(), () => t);
    for (t = 0; t < 5; t += 1) {
      expect((await loginVia(local, 'wrong')).status).toBe(401);
    }
    const verify = vi.mocked(verifyPassphrase);
    verify.mockClear();
    t = 10;
    expect((await loginVia(local, 'wrong')).status).toBe(429);
    expect((await loginVia(local, PASS)).status).toBe(429);
    expect(verify).not.toHaveBeenCalled();
    // After the lock, the check runs again.
    t = 900_004;
    expect((await loginVia(local, PASS)).status).toBe(204);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('a body without a string passphrase is 400', async () => {
    const notJson = await app.request('/api/login', { method: 'POST', body: 'not json' });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: 'passphrase is required' });
    const notString = await app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: 42 }),
    });
    expect(notString.status).toBe(400);
    expect(await notString.json()).toEqual({ error: 'passphrase is required' });
  });

  it('logout revokes the session', async () => {
    const token = tokenFrom(await login(PASS));
    const cookie = `hub_session=${token}`;
    expect((await app.request('/api/secret', { headers: { cookie } })).status).toBe(200);
    const out = await app.request('/api/logout', { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(204);
    const cleared = out.headers.get('set-cookie') ?? '';
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/');
    expect((await app.request('/api/secret', { headers: { cookie } })).status).toBe(401);
  });

  it('logout calls onLogout once the session is revoked, and a missing cookie still calls it', async () => {
    const token = tokenFrom(await login(PASS));
    const seen: boolean[] = [];
    const other = new Hono();
    other.route(
      '/api',
      authRoutes({
        sessions,
        limiter: new LoginLimiter(),
        passphraseHash: HASH,
        onLogout: () => seen.push(sessions.valid(token)),
      }),
    );

    const out = await other.request('/api/logout', { method: 'POST', headers: { cookie: `hub_session=${token}` } });
    expect(out.status).toBe(204);
    expect(seen).toEqual([false]);

    expect((await other.request('/api/logout', { method: 'POST' })).status).toBe(204);
    expect(seen).toEqual([false, false]);
  });

  it('expired sessions are rejected', () => {
    let now = 0;
    const store = new SessionStore(db, () => now);
    const token = store.create();
    now = SESSION_TTL_MS - 1;
    expect(store.valid(token)).toBe(true);
    now = SESSION_TTL_MS;
    expect(store.valid(token)).toBe(false);
    expect(store.purgeExpired()).toBe(1);
  });

  it('tokens are stored hashed', () => {
    const token = sessions.create();
    const rows = db.prepare('SELECT token_hash FROM auth_sessions').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(rows[0]?.token_hash).not.toBe(token);
  });

  it('readCookie parses a header', () => {
    expect(readCookie('a=1; hub_session=xyz; b=2', 'hub_session')).toBe('xyz');
    expect(readCookie('a=1; b=2', 'hub_session')).toBeUndefined();
    expect(readCookie(undefined, 'hub_session')).toBeUndefined();
  });

  it('readCookie accepts no space after the semicolon', () => {
    expect(readCookie('a=1;hub_session=xyz', 'hub_session')).toBe('xyz');
  });

  it('readCookie accepts spaces around the equals sign', () => {
    expect(readCookie('hub_session = xyz', 'hub_session')).toBe('xyz');
  });

  it('readCookie returns the first of duplicate cookies', () => {
    expect(readCookie('hub_session=first; hub_session=second', 'hub_session')).toBe('first');
  });

  it('readCookie does not match a longer name', () => {
    expect(readCookie('xhub_session=evil', 'hub_session')).toBeUndefined();
    expect(readCookie('xhub_session=evil; hub_session=real', 'hub_session')).toBe('real');
  });

  it('session reports login state', async () => {
    const before = await app.request('/api/session');
    expect(before.status).toBe(401);
    expect(await before.json()).toEqual({ error: 'Not logged in' });
    const token = tokenFrom(await login(PASS));
    const after = await app.request('/api/session', { headers: { cookie: `hub_session=${token}` } });
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ ok: true });
  });
});
