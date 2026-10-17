import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type MiddlewareHandler } from 'hono';
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
import { syncRoutes } from './sync/routes.js';
import type { SyncService } from './sync/service.js';
import type { DesignEditing } from './design/editing.js';
import { designRoutes } from './design/routes.js';
import { frameRoutes } from './design/frame-routes.js';
import type { CanvasFrames } from './design/frames.js';
import type { DesignChat } from './design/chat.js';
import { designChatRoutes } from './design/chat-routes.js';
import { previewRoutes } from './sync/preview-routes.js';
import type { SourcePreview } from './sync/preview.js';

export interface AppDeps {
  sessions: SessionStore;
  limiter: LoginLimiter;
  passphraseHash: string;
  registry: AppRegistry;
  build: BuildService;
  sync?: SyncService;
  editing?: DesignEditing;
  frames?: CanvasFrames;
  designChat?: DesignChat;
  sourcePreview?: SourcePreview;
  dataDir: string;
  /** The built client. When unset the hub serves only /api. */
  clientDir?: string | null;
  now?: () => number;
  /** Called after a logout has revoked its session. startHub uses it to close that session's sockets. */
  onLogout?: () => void;
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

/** Whether `path` is `root` or lies under it. Both must already be real paths. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Whether the client folder may answer this request path. Anything with a segment that starts with a dot
 * (.env, .git, a dot spelled %2e) is refused, and so is a file whose real path, after following symlinks,
 * is outside the client folder. A path that does not exist passes: serveStatic answers 404 for it. Any other
 * failure to resolve it (a symlink loop, no permission, a name too long) is not understood well enough to
 * serve, so it is refused too.
 */
async function mayServe(clientDir: string, requestPath: string): Promise<boolean> {
  if (requestPath.split('/').some((segment) => segment.startsWith('.'))) return false;
  try {
    const root = await realpath(clientDir);
    let real = await realpath(join(clientDir, requestPath));
    if (!isInside(root, real)) return false;
    // serveStatic answers a directory with its index.html, which may itself be a link.
    if ((await stat(real)).isDirectory()) real = await realpath(join(real, 'index.html'));
    return isInside(root, real);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

/**
 * The built client, served without login. serveStatic's own onFound only records which file it served: it
 * builds its response before awaiting onFound, so with a native Response (what app.request() returns in tests)
 * a header set there is lost, while under serve() the onFound form works. The wrapper sets Cache-Control on the
 * response serveStatic returns, which is right under both, so it is kept.
 */
function clientFiles(clientDir: string): MiddlewareHandler {
  const served = new WeakMap<object, string>();
  const files = serveStatic({
    root: clientDir,
    onFound: (path, c) => {
      served.set(c, path);
    },
  });
  return async (c, next) => {
    const read = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (read && !(await mayServe(clientDir, c.req.path))) return c.notFound();
    const res = await files(c, next);
    const path = served.get(c);
    if (path !== undefined && res instanceof Response) {
      res.headers.set('Cache-Control', cacheControl(clientDir, path));
    }
    return res;
  };
}

/** Largest request body any /api route reads. Chat messages are capped far below this by the Build service. */
const MAX_BODY_BYTES = 256 * 1024;
/** Longest error message written to the log. */
const MAX_LOGGED_MESSAGE_CHARS = 500;

/** Node reports a request body cut off by the client as Error('aborted') with code ECONNRESET. */
function isClientAbort(err: Error): boolean {
  return (err as NodeJS.ErrnoException).code === 'ECONNRESET' && err.message === 'aborted';
}

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
    authRoutes({
      sessions,
      limiter: deps.limiter,
      passphraseHash: deps.passphraseHash,
      now: deps.now,
      onLogout: deps.onLogout,
    }),
  );

  // Everything under /api from here on needs a session: apps, build and render routes alike.
  app.use('/api/*', requireAuth(sessions));
  app.route('/api/apps', appsRoutes({ registry, build }));
  const hasApp = async (name: string): Promise<boolean> => (await registry.get(name)) !== null;
  app.route('/api/apps', buildRoutes(build, hasApp));
  app.route('/api/apps', renderRoutes({ dataDir, hasApp }));
  if (deps.sync) app.route('/api/apps', syncRoutes(deps.sync));
  if (deps.editing) app.route('/api/apps', designRoutes(deps.editing));
  if (deps.frames && deps.sync) app.route('/api/apps', frameRoutes({ frames: deps.frames, sync: deps.sync, hasApp }));
  if (deps.designChat) app.route('/api/apps', designChatRoutes(deps.designChat));
  if (deps.sourcePreview) app.route('/api/apps', previewRoutes(deps.sourcePreview));
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  if (clientDir) app.use('/*', clientFiles(clientDir));

  app.onError((err, c) => {
    // csrf() and friends throw HTTPException with the response they want sent; do not turn it into a 500.
    if (err instanceof HTTPException) return err.getResponse();
    // The client dropped the connection while its body was still arriving (a chunked upload cut off). Nobody is
    // left to answer, and it is not a fault of the hub, so it is not logged as an unhandled error.
    if (isClientAbort(err)) return c.json({ error: 'Request aborted' }, 400);
    if (err instanceof BuildError) return c.json({ error: err.message }, err.status);
    // The message only, never the stack or the error object: they could carry request details or tokens.
    // JSON.stringify escapes newlines, so a message cannot forge a log line; the message is cut at 500 chars.
    const message = JSON.stringify(err.message.slice(0, MAX_LOGGED_MESSAGE_CHARS));
    console.error(`Unhandled error on ${c.req.method} ${JSON.stringify(c.req.path)}: ${message}`);
    return c.json({ error: 'Internal error' }, 500);
  });

  return app;
}
