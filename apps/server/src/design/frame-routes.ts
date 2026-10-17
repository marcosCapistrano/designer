import { Hono } from 'hono';
import { z } from 'zod';
import { MAX_FRAMES_PER_APP } from '@hub/protocol';
import type { SyncService } from '../sync/service.js';
import type { CanvasFrames } from './frames.js';

const putSchema = z.object({ frames: z.array(z.unknown()).max(MAX_FRAMES_PER_APP) }).strict();

export interface FrameRouteDeps {
  frames: Pick<CanvasFrames, 'list' | 'replace'>;
  sync: Pick<SyncService, 'ensureRendered'>;
  hasApp: (app: string) => Promise<boolean>;
}

export function frameRoutes({ frames, sync, hasApp }: FrameRouteDeps): Hono {
  const routes = new Hono();
  routes.get('/:app/design/frames', async (c) => {
    const app = c.req.param('app');
    if (!(await hasApp(app))) return c.json({ error: 'Unknown app' }, 404);
    const list = await frames.list(app);
    sync.ensureRendered(app);
    return c.json({ frames: list });
  });
  routes.put('/:app/design/frames', async (c) => {
    const app = c.req.param('app');
    if (!(await hasApp(app))) return c.json({ error: 'Unknown app' }, 404);
    const body = putSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid frames request' }, 400);
    const result = await frames.replace(app, body.data.frames);
    if (!result.ok) return c.json({ error: result.error }, 400);
    sync.ensureRendered(app);
    return c.json({ frames: result.frames });
  });
  return routes;
}
