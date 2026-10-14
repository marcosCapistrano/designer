import { relative, sep } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { AppRegistry } from './apps/registry.js';
import { appsRoutes } from './apps/routes.js';
import type { LoginLimiter } from './auth/limiter.js';
import { authRoutes } from './auth/routes.js';
import { requireAuth, type SessionStore } from './auth/sessions.js';
import { BuildError } from './build/ci.js';
import { buildRoutes } from './build/routes.js';
import type { BuildService } from './build/service.js';
import { renderRoutes } from './design/render-files.js';

export interface AppDeps {
  sessions: SessionStore;
  limiter: LoginLimiter;
  passphraseHash: string;
  registry: AppRegistry;
  build: BuildService;
  dataDir: string;
  /** The built client. When unset the hub serves only /api. */
  clientDir?: string | null;
  now?: () => number;
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Hashed files under `assets/` never change, so they cache for a year. Everything else, index.html
 * included, is revalidated. The path is judged inside `clientDir`, so where the client lives on disk
 * (say /srv/assets/client) cannot make index.html immutable.
 */
function cacheControl(clientDir: string, path: string): string {
  return relative(clientDir, path).split(sep)[0] === 'assets' ? IMMUTABLE : 'no-cache';
}

/** Largest request body any /api route reads. Chat messages are capped far below this by the Build service. */
const MAX_BODY_BYTES = 256 * 1024;
/** Longest error message written to the log. */
const MAX_LOGGED_MESSAGE_CHARS = 500;

export function createApp(deps: AppDeps): Hono {
  const { sessions, registry, build, dataDir, clientDir } = deps;
  const app = new Hono();

  app.use('*', secureHeaders());
  // Hono hands only Error instances to app.onError. A rejection with anything else (a string, say) would skip
  // it and skip the headers above, so it becomes an Error here. This sits inside secureHeaders on purpose:
  // an error that unwinds past secureHeaders would leave its response without the security headers.
  app.use('*', async (c, next) => {
    try {
      await next();
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
  });
  // SameSite=Strict is per site, and staging apps on the same tailnet domain share the hub's site, so a page
  // there could drive these routes with the session cookie. csrf() refuses form-typed or bodyless writes
  // unless the browser says Sec-Fetch-Site: same-origin (or sends our own Origin). It runs before the
  // body limit so a forged request is rejected before its body is read.
  app.use('/api/*', csrf());
  app.use(
    '/api/*',
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'Request too large' }, 413) }),
  );

  app.get('/api/health', (c) => c.json({ ok: true }));
  app.route(
    '/api',
    authRoutes({ sessions, limiter: deps.limiter, passphraseHash: deps.passphraseHash, now: deps.now }),
  );

  // Everything under /api from here on needs a session: apps, build and render routes alike.
  app.use('/api/*', requireAuth(sessions));
  app.route('/api/apps', appsRoutes({ registry, build }));
  app.route('/api/apps', buildRoutes(build));
  app.route('/api/apps', renderRoutes({ dataDir, hasApp: async (a) => (await registry.get(a)) !== null }));
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  if (clientDir) {
    // serveStatic builds its response before it calls onFound, so a header set through c.header() there
    // never reaches the client. onFound only records which file was served; the wrapper below sets
    // Cache-Control on the response serveStatic returns.
    const served = new WeakMap<object, string>();
    const files = serveStatic({
      root: clientDir,
      onFound: (path, c) => {
        served.set(c, path);
      },
    });
    app.use('/*', async (c, next) => {
      const res = await files(c, next);
      const path = served.get(c);
      if (path !== undefined && res instanceof Response) {
        res.headers.set('Cache-Control', cacheControl(clientDir, path));
      }
      return res;
    });
  }

  app.onError((err, c) => {
    // csrf() and friends throw HTTPException with the response they want sent; do not turn it into a 500.
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof BuildError) return c.json({ error: err.message }, err.status);
    // The message only, never the stack or the error object: they could carry request details or tokens.
    // JSON.stringify escapes newlines, so a message cannot forge a log line; the message is cut at 500 chars.
    const message = JSON.stringify(err.message.slice(0, MAX_LOGGED_MESSAGE_CHARS));
    console.error(`Unhandled error on ${c.req.method} ${JSON.stringify(c.req.path)}: ${message}`);
    return c.json({ error: 'Internal error' }, 500);
  });

  return app;
}
