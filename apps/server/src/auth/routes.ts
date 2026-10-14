import { Hono, type Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { LoginLimiter } from './limiter.js';
import { verifyPassphrase } from './passphrase.js';
import { SESSION_COOKIE, readCookie, type SessionStore } from './sessions.js';

export interface AuthDeps {
  sessions: SessionStore;
  limiter: LoginLimiter;
  passphraseHash: string;
  now?: () => number;
}

const SESSION_MAX_AGE_S = 2_592_000;
const LOCKED_ERROR = 'Too many attempts. Try again in 15 minutes.';

/** Reads `passphrase` from a JSON body. Anything else, including a non-JSON body, yields undefined. */
async function readPassphrase(c: Context): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return undefined;
  }
  if (typeof body === 'object' && body !== null && 'passphrase' in body && typeof body.passphrase === 'string') {
    return body.passphrase;
  }
  return undefined;
}

/** Mount with app.route('/api', authRoutes(deps)). */
export function authRoutes(deps: AuthDeps): Hono {
  const { sessions, limiter, passphraseHash } = deps;
  const now = deps.now ?? (() => Date.now());
  const app = new Hono();

  app.post('/login', async (c) => {
    if (limiter.blocked(now())) {
      return c.json({ error: LOCKED_ERROR }, 429);
    }
    const passphrase = await readPassphrase(c);
    // Other requests may have reached the limit while this one read its body, so the lock is checked
    // again here. From this check to fail() or reset() there is no await, so nothing interleaves.
    const at = now();
    if (limiter.blocked(at)) {
      return c.json({ error: LOCKED_ERROR }, 429);
    }
    if (passphrase === undefined) {
      return c.json({ error: 'passphrase is required' }, 400);
    }
    if (!verifyPassphrase(passphrase, passphraseHash)) {
      limiter.fail(at);
      return c.json({ error: 'Wrong passphrase' }, 401);
    }
    limiter.reset();
    setCookie(c, SESSION_COOKIE, sessions.create(), {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: SESSION_MAX_AGE_S,
    });
    return c.body(null, 204);
  });

  app.post('/logout', (c) => {
    const token = readCookie(c.req.header('cookie'), SESSION_COOKIE);
    if (token !== undefined) sessions.revoke(token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });

  app.get('/session', (c) => {
    if (!sessions.valid(readCookie(c.req.header('cookie'), SESSION_COOKIE))) {
      return c.json({ error: 'Not logged in' }, 401);
    }
    return c.json({ ok: true });
  });

  return app;
}
