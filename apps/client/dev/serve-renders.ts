import sirv from 'sirv';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';

export const RENDERS_MOUNT = '/dev-renders';

/**
 * Serves the render output in `dir` under RENDERS_MOUNT on the dev and preview servers. The
 * directory may not exist yet (sirv in dev mode reads files per request). Unknown paths get a
 * plain 404 rather than Vite's index.html fallback.
 */
export function serveRenders(dir: string): Plugin {
  const handler = sirv(dir, { dev: true });
  const mount = (server: ViteDevServer | PreviewServer): void => {
    server.middlewares.use(RENDERS_MOUNT, (req, res) =>
      handler(req, res, () => {
        res.statusCode = 404;
        res.end('Not found');
      }),
    );
  };
  return {
    name: 'hub-serve-renders',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
