import { describe, expect, it } from 'vitest';
import { designRoutes } from './routes.js';
import type { DesignEditing } from './editing.js';

function app() {
  const calls: unknown[][] = [];
  const service = {
    layers: async (...args: unknown[]) => { calls.push(['layers', ...args]); return { revision: 'r', root: { id: 'x', name: 'div', kind: 'element', children: [] }, components: {} }; },
    edit: async (...args: unknown[]) => { calls.push(['edit', ...args]); return { mode: 'applied', revision: 'r2', warnings: [] }; },
  } as unknown as DesignEditing;
  return { routes: designRoutes(service), calls };
}
const rev = 'a'.repeat(64);

describe('design routes', () => {
  it('serves a page outline and requires the page', async () => {
    const { routes, calls } = app();
    expect((await routes.request('/demo/design/layers?page=p1')).status).toBe(200);
    expect(calls).toEqual([['layers', 'demo', 'p1']]);
    expect((await routes.request('/demo/design/layers')).status).toBe(400);
  });
  it('passes a component scope through to the edit', async () => {
    const { routes, calls } = app();
    const body = { revision: rev, ops: [{ op: 'setStyle' }], scope: { component: 'C1' } };
    const res = await routes.request('/demo/design/edits', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(calls[0]).toEqual(['edit', 'demo', rev, [{ op: 'setStyle' }], undefined, false, { component: 'C1' }]);
    const bad = await routes.request('/demo/design/edits', { method: 'POST', body: JSON.stringify({ ...body, scope: { component: '' } }), headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);
  });
});
