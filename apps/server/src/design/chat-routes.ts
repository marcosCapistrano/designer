import { Hono } from 'hono';
import { z } from 'zod';
import type { DesignChat } from './chat.js';
import { selectionSchema } from './routes.js';
const request = z.object({ text: z.string().min(1).max(20_000), selection: selectionSchema.optional() }).strict();
export function designChatRoutes(chat: DesignChat): Hono {
  const routes = new Hono();
  routes.get('/:app/design/chat', async (c) => c.json(await chat.state(c.req.param('app'))));
  routes.post('/:app/design/chat', async (c) => {
    const body = request.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Invalid design prompt' }, 400);
    return c.json(await chat.send(c.req.param('app'), body.data.text, body.data.selection));
  });
  routes.post('/:app/design/chat/stop', async (c) => { await chat.state(c.req.param('app')); return c.json({ stopped: chat.stop(c.req.param('app')) }); });
  return routes;
}
