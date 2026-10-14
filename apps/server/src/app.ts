import { relative, sep } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createApp(deps: AppDeps): Hono {
  const { sessions, registry, build, dataDir, clientDir } = deps;
  const app = new Hono();

  app.use('*', secureHeaders());

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
    if (err instanceof BuildError) return c.json({ error: err.message }, err.status);
    // The message only: a stack trace or an upstream error object could carry request details or tokens.
    console.error(`Unhandled error on ${c.req.method} ${c.req.path}: ${errorText(err)}`);
    return c.json({ error: 'Internal error' }, 500);
  });

  return app;
}
