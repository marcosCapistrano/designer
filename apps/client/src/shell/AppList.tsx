// The hub's app list: one row per app with its adoption state, its latest build status and
// whether Claude is working on it. It reloads on every build.task message, so the rows stay current without polling.

import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { AppSummary } from '@hub/protocol';
import type { ApiClient } from '../net/api.js';
import type { WsClient } from '../net/ws.js';
import { STATUS_LABEL } from '../areas/build/state.js';
import { errorText } from '../areas/build/TaskCard.js';
import { formatRoute } from './route.js';

export interface AppListProps {
  api: ApiClient;
  ws: WsClient;
}

const PAGE_STYLE =
  'box-sizing:border-box;height:100%;overflow:auto;padding:16px;background:#e9e9ec;color:#202124;font-family:system-ui,sans-serif';
const HEADING_STYLE = 'margin:0 0 12px;font-size:22px;font-weight:600';
const LIST_STYLE = 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px';
const ROW_STYLE =
  'display:flex;flex-direction:column;gap:6px;box-sizing:border-box;min-height:44px;padding:12px 16px;background:#fff;border-radius:10px;color:#202124;text-decoration:none;min-width:0';
const NAME_STYLE = 'font-size:17px;font-weight:600;overflow-wrap:anywhere';
const META_STYLE = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:13px;color:#5f6368';
const BADGE_BASE = 'padding:2px 10px;border-radius:999px;font-weight:600;flex:0 0 auto';
const BADGE_ADOPTED = `${BADGE_BASE};background:#e6f4ea;color:#137333`;
const BADGE_NOT_ADOPTED = `${BADGE_BASE};background:#f1f3f4;color:#5f6368`;
const NOTE_STYLE = 'margin:0;font-size:15px;color:#5f6368';
const ERROR_STYLE = 'margin:0 0 12px;padding:8px 12px;background:#fff;border-radius:8px;color:#d93025;font-size:14px';

/** The row's status text: 'Claude is working' while a run is active, else the latest build task's status. */
function statusText(app: AppSummary): string {
  if (app.running) return 'Claude is working';
  return app.buildStatus ? STATUS_LABEL[app.buildStatus] : '';
}

export function AppList({ api, ws }: AppListProps): JSX.Element {
  // null until the first successful load, so an empty list is never shown before the server answers.
  const [apps, setApps] = useState<AppSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // Only the newest request may update the view, so an older response never overwrites a newer one.
    let latest = 0;

    const load = (): void => {
      const request = ++latest;
      api.apps().then(
        (list) => {
          if (live && request === latest) {
            setApps(list);
            setError(null);
          }
        },
        (e: unknown) => {
          if (live && request === latest) setError(errorText(e));
        },
      );
    };

    load();
    const offMessage = ws.on((m) => {
      if (m.type === 'build.task') load();
    });

    return () => {
      live = false;
      offMessage();
    };
  }, [api, ws]);

  return (
    <section style={PAGE_STYLE}>
      <h1 style={HEADING_STYLE}>Apps</h1>
      {error !== null && (
        <p role="alert" data-testid="apps-error" style={ERROR_STYLE}>
          {error}
        </p>
      )}
      <ul data-testid="app-list" style={LIST_STYLE}>
        {(apps ?? []).map((app) => (
          <li key={app.name}>
            <a
              data-testid={`app-${app.name}`}
              href={formatRoute({ name: 'app', app: app.name, area: 'build' })}
              style={ROW_STYLE}
            >
              <span style={NAME_STYLE}>{app.name}</span>
              <span style={META_STYLE}>
                <span
                  data-testid={`badge-${app.name}`}
                  style={app.adopted ? BADGE_ADOPTED : BADGE_NOT_ADOPTED}
                  title={app.manifestError ?? ''}
                >
                  {app.adopted ? 'Adopted' : 'Not adopted'}
                </span>
                <span>{statusText(app)}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      {apps !== null && apps.length === 0 && (
        <p data-testid="no-apps" style={NOTE_STYLE}>
          No apps yet. Clone a repo into HUB_APPS_DIR on the hub server.
        </p>
      )}
    </section>
  );
}
