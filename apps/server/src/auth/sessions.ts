import { createHash, randomBytes } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Db } from '../db.js';

export const SESSION_COOKIE = 'hub_session';
export const SESSION_TTL_MS = 2_592_000_000;

const TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Stores only sha256(token) in auth_sessions. Time is injected through `now`; the default reads the wall clock. */
export class SessionStore {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = () => Date.now()) {
    this.db = db;
    this.now = now;
  }

  create(): string {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const createdAt = this.now();
    this.db
      .prepare('INSERT INTO auth_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), createdAt, createdAt + SESSION_TTL_MS);
    return token;
  }

  valid(token: string | undefined): boolean {
    if (token === undefined) return false;
    const row = this.db
      .prepare('SELECT 1 AS found FROM auth_sessions WHERE token_hash = ? AND expires_at > ?')
      .get(hashToken(token), this.now());
    return row !== undefined;
  }

  revoke(token: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token));
  }

  purgeExpired(): number {
    return this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(this.now()).changes;
  }
}

/** Returns the value of `name` in a Cookie header, or undefined when the header or the cookie is absent. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

/** Answers 401 `{ error: 'Not logged in' }` unless the request carries a valid session cookie. */
export function requireAuth(sessions: SessionStore): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const token = readCookie(c.req.header('cookie'), SESSION_COOKIE);
    if (!sessions.valid(token)) {
      return c.json({ error: 'Not logged in' }, 401);
    }
    await next();
  });
}
