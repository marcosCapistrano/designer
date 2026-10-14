import { Hono } from 'hono';
import { z } from 'zod';
import { importSchema } from './routes.js';
import type { SourcePreview } from './preview.js';
const id = z.object({id:z.string().uuid()}).strict();
const request=z.object({source:importSchema,text:z.string().max(4000).optional()}).strict();
export function previewRoutes(service: SourcePreview): Hono {
  const routes = new Hono();
  routes.get('/:app/design/source-preview',async (c) => c.json(await service.state(c.req.param('app'))));
  routes.post('/:app/design/source-preview',async (c) => {
    const body = request.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({error:'Invalid source preview request'},400);
    return c.json(await service.propose(c.req.param('app'),body.data.source,body.data.text));
  });
  routes.post('/:app/design/source-preview/stop',async (c) => { await service.state(c.req.param('app')); return c.json({stopped:service.stop(c.req.param('app'))}); });
  for (const action of ['apply','cancel'] as const) routes.post(`/:app/design/source-preview/${action}`,async (c) => {
    const body = id.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({error:'Invalid source preview'},400);
    if (action==='apply') return c.json(await service.apply(c.req.param('app'),body.data.id));
    service.cancel(c.req.param('app'),body.data.id); return c.json({cancelled:true});
  });
  return routes;
}
