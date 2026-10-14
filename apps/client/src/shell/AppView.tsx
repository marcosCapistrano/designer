// One app's page: a header with a way back to the list, the Design / Build / Deploy tabs,
// and the body for the selected area. Each app gets its own tile cache, so one app's cache.gc never evicts another's tiles.

import { useMemo } from 'preact/hooks';
import type { JSX } from 'preact';
import type { ApiClient } from '../net/api.js';
import type { WsClient } from '../net/ws.js';
import { ServerTileSource } from '../net/tile-source.js';
import { createIdbCache } from '../canvas/index.js';
import { DesignArea } from '../areas/design/DesignArea.js';
import { BuildArea } from '../areas/build/BuildArea.js';
import { AREAS, AREA_LABEL, formatRoute } from './route.js';
import type { Area } from './route.js';

export interface AppViewProps {
  app: string;
  area: Area;
  api: ApiClient;
  ws: WsClient;
}

export function AppView({ app, area, api, ws }: AppViewProps): JSX.Element {
  // Hooks run here, at the top level, so switching areas never changes their order.
  // `api` and `ws` are created once in App and never change, so the memos below depend on the app alone.
  const source = useMemo(() => new ServerTileSource(app, ws, { onUnauthorized: () => api.reportUnauthorized() }), [app]);
  const cache = useMemo(() => createIdbCache(`hub-tiles-${app}`), [app]);

  return (
    <div class="app-view">
      <header class="app-view-header">
        <a href="#/" data-testid="back" class="app-view-back">
          All apps
        </a>
        <h1 class="app-view-title">{app}</h1>
      </header>
      <nav role="tablist" class="app-view-tabs">
        {AREAS.map((a) => (
          <a
            key={a}
            role="tab"
            data-testid={`tab-${a}`}
            aria-selected={a === area ? 'true' : 'false'}
            href={formatRoute({ name: 'app', app, area: a })}
            class={a === area ? 'app-view-tab app-view-tab-selected' : 'app-view-tab'}
          >
            {AREA_LABEL[a]}
          </a>
        ))}
      </nav>
      <div class="app-view-body">
        {area === 'design' && <DesignArea key={app} app={app} api={api} ws={ws} source={source} cache={cache} />}
        {area === 'build' && <BuildArea key={app} app={app} api={api} ws={ws} />}
        {area === 'deploy' && (
          <p data-testid="deploy-placeholder" class="app-view-deploy">
            Deploy is not set up yet.
          </p>
        )}
      </div>
    </div>
  );
}
