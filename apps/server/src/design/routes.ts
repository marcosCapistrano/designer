import { Hono } from 'hono';
import { z } from 'zod';
import type { DesignEditing } from './editing.js';
export const selectionSchema = z.object({ pageId: z.string().min(1).max(100), device: z.enum(['base', 'tablet', 'mobile']), nodeIds: z.array(z.string().min(1).max(300)).min(1).max(100) }).strict();
const editSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/), ops: z.array(z.unknown()).min(1).max(100), selection: selectionSchema.optional(), scope: z.object({ component: z.string().min(1).max(100) }).strict().optional() }).strict();
const historySchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(['undo', 'redo']) }).strict();
const idSchema = z.object({ id: z.string().uuid() }).strict();
export function designRoutes(service: DesignEditing): Hono {
  const routes = new Hono();
  routes.post('/:app/design/selection', async (c) => {
    const body = selectionSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid selection' }, 400);
    return c.json(await service.selection(c.req.param('app'), body.data));
  });
  routes.post('/:app/design/edits', async (c) => {
    const body = editSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid edit request' }, 400);
    return c.json(await service.edit(c.req.param('app'), body.data.revision, body.data.ops, body.data.selection, false, body.data.scope));
  });
  routes.get('/:app/design/layers', async (c) => {
    const page = c.req.query('page');
    if (!page || page.length > 100) return c.json({ error: 'Invalid page' }, 400);
    return c.json(await service.layers(c.req.param('app'), page));
  });
  routes.post('/:app/design/history', async (c) => {
    const body = historySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid undo/redo request' }, 400);
    return c.json(await service.history(c.req.param('app'), body.data.revision, body.data.action));
  });
  for (const action of ['apply', 'cancel'] as const) routes.post(`/:app/design/${action}`, async (c) => {
    const body = idSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid preview' }, 400);
    if (action === 'apply') return c.json(await service.apply(c.req.param('app'), body.data.id));
    service.cancel(c.req.param('app'), body.data.id); return c.json({ cancelled: true });
  });
  return routes;
}
