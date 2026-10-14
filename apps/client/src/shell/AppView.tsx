// One app's page: a header with a way back to the list, the Design / Build / Deploy tabs,
// and the body for the selected area. Each app gets its own tile cache, so one app's cache.gc never evicts another's tiles.

import { useMemo } from 'preact/hooks';
import type { JSX } from 'preact';
import type { ApiClient } from '../net/api.js';
import type { WsClient } from '../net/ws.js';
import { ServerTileSource } from '../net/tile-source.js';
import { CanvasView, createIdbCache } from '../canvas/index.js';
import { BuildArea } from '../areas/build/BuildArea.js';
import { AREAS, AREA_LABEL, formatRoute } from './route.js';
import type { Area } from './route.js';

export interface AppViewProps {
  app: string;
  area: Area;
  api: ApiClient;
  ws: WsClient;
}

const ROOT_STYLE =
  'display:flex;flex-direction:column;height:100%;min-width:0;box-sizing:border-box;background:#e9e9ec;color:#202124;font-family:system-ui,sans-serif';
const HEADER_STYLE =
  'display:flex;align-items:center;gap:12px;min-width:0;padding:4px 16px;background:#fff;border-bottom:1px solid #dadce0';
const BACK_STYLE =
  'display:inline-flex;align-items:center;flex:0 0 auto;min-height:44px;color:#1a73e8;text-decoration:none;font-size:15px';
const TITLE_STYLE =
  'margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:18px;font-weight:600';
const TABS_STYLE = 'display:flex;gap:4px;padding:0 8px;background:#fff;border-bottom:1px solid #dadce0';
const TAB_BASE =
  'flex:1 1 0;display:flex;align-items:center;justify-content:center;min-height:44px;min-width:0;box-sizing:border-box;border-bottom:3px solid transparent;color:#5f6368;font-weight:500;text-decoration:none';
const TAB_SELECTED = `${TAB_BASE};border-bottom-color:#1a73e8;color:#1a73e8;font-weight:600`;
const BODY_STYLE = 'position:relative;flex:1;min-height:0;overflow:hidden';
const DEPLOY_STYLE = 'margin:0;padding:16px;font-size:15px;color:#5f6368';

export function AppView({ app, area, api, ws }: AppViewProps): JSX.Element {
  // Hooks run here, at the top level, so switching areas never changes their order.
  const source = useMemo(() => new ServerTileSource(app, ws), [app]);
  const cache = useMemo(() => createIdbCache(`hub-tiles-${app}`), [app]);

  return (
    <div style={ROOT_STYLE}>
      <header style={HEADER_STYLE}>
        <a href="#/" data-testid="back" style={BACK_STYLE}>
          All apps
        </a>
        <h1 style={TITLE_STYLE}>{app}</h1>
      </header>
      <nav role="tablist" style={TABS_STYLE}>
        {AREAS.map((a) => (
          <a
            key={a}
            role="tab"
            data-testid={`tab-${a}`}
            aria-selected={a === area ? 'true' : 'false'}
            href={formatRoute({ name: 'app', app, area: a })}
            style={a === area ? TAB_SELECTED : TAB_BASE}
          >
            {AREA_LABEL[a]}
          </a>
        ))}
      </nav>
      <div style={BODY_STYLE}>
        {area === 'design' && <CanvasView key={app} source={source} cache={cache} />}
        {area === 'build' && <BuildArea key={app} app={app} api={api} ws={ws} />}
        {area === 'deploy' && <p data-testid="deploy-placeholder" style={DEPLOY_STYLE}>Deploy is not set up yet.</p>}
      </div>
    </div>
  );
}
