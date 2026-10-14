import { Hono } from 'hono';
import type { AppSummary, BuildTaskStatus } from '@hub/protocol';
import type { BuildService } from '../build/service.js';
import type { AppEntry, AppRegistry } from './registry.js';

export function toSummary(e: AppEntry, buildStatus: BuildTaskStatus | null, running: boolean): AppSummary {
  return { name: e.name, adopted: e.adopted, manifestError: e.manifestError, buildStatus, running };
}

export interface AppsRoutesDeps {
  registry: AppRegistry;
  build: Pick<BuildService, 'latestStatus' | 'isRunning'>;
}

/** Mount at /api/apps. `GET /` answers a bare AppSummary[], which is what the client's ApiClient.apps() reads. */
export function appsRoutes(deps: AppsRoutesDeps): Hono {
  const { registry, build } = deps;
  const summary = (e: AppEntry): AppSummary => toSummary(e, build.latestStatus(e.name), build.isRunning(e.name));
  const routes = new Hono();

  routes.get('/', async (c) => c.json((await registry.list()).map(summary)));

  routes.get('/:app', async (c) => {
    const entry = await registry.get(c.req.param('app'));
    if (entry === null) return c.json({ error: 'Unknown app' }, 404);
    return c.json(summary(entry));
  });

  return routes;
}
