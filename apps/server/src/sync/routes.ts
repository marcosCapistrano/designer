import { Hono } from 'hono';
import { z } from 'zod';
import type { SyncService } from './service.js';
const path = z.string().min(1).max(300).refine((value) => !value.includes('\\') && !value.includes('\0') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'));
const route = z.object({ route: z.string().startsWith('/').max(300), file: path, exportName: z.string().min(1).max(100).optional(), layouts: z.array(path).max(20).optional() }).strict();
const request = z.discriminatedUnion('mode', [z.object({ mode: z.literal('next'), appDir: path.optional() }).strict(), z.object({ mode: z.literal('react'), entries: z.array(route).min(1).max(100) }).strict()]);
export function syncRoutes(service: SyncService): Hono {
  const routes = new Hono();
  routes.get('/:app/design', async (c) => c.json(await service.summary(c.req.param('app'))));
  routes.post('/:app/design/import', async (c) => {
    const body = request.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Choose Next routes or valid explicit React route entries.' }, 400);
    return c.json(await service.import(c.req.param('app'), body.data));
  });
  routes.post('/:app/design/render', async (c) => c.json(await service.retryPreview(c.req.param('app'))));
  return routes;
}
