import { Hono, type Context } from 'hono';
import type { BuildService } from './service.js';

/** `after` counts only when it is a whole number of at least 0. Anything else reads the whole chat. */
function parseAfter(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const after = Number(raw);
  return Number.isSafeInteger(after) ? after : undefined;
}

/** The task id in the URL, or null when it is not an integer. */
function parseTaskId(c: Context): number | null {
  const raw = c.req.param('id') ?? '';
  if (!/^-?\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/** The `text` of a JSON body. A body that is not JSON, or has no string `text`, yields undefined. */
async function readText(c: Context): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return undefined;
  }
  if (typeof body === 'object' && body !== null && 'text' in body && typeof body.text === 'string') {
    return body.text;
  }
  return undefined;
}

export type BuildRoutesDeps = Pick<BuildService, 'state' | 'send' | 'stop' | 'merge' | 'close'>;

/** Mount at /api/apps. A BuildError thrown by the service reaches app.onError, which maps it to its status. */
export function buildRoutes(build: BuildRoutesDeps): Hono {
  const routes = new Hono();

  routes.get('/:app/build', async (c) => {
    return c.json(await build.state(c.req.param('app'), parseAfter(c.req.query('after'))));
  });

  routes.post('/:app/build/messages', async (c) => {
    const text = await readText(c);
    if (text === undefined) return c.json({ error: 'text is required' }, 400);
    return c.json({ task: await build.send(c.req.param('app'), text) }, 202);
  });

  routes.post('/:app/build/stop', (c) => c.json({ stopped: build.stop(c.req.param('app')) }));

  routes.post('/:app/build/tasks/:id/merge', async (c) => {
    const id = parseTaskId(c);
    if (id === null) return c.json({ error: 'Bad task id' }, 400);
    return c.json({ task: await build.merge(c.req.param('app'), id) });
  });

  routes.post('/:app/build/tasks/:id/close', async (c) => {
    const id = parseTaskId(c);
    if (id === null) return c.json({ error: 'Bad task id' }, 400);
    return c.json({ task: await build.close(c.req.param('app'), id) });
  });

  return routes;
}
