// The hub's app list: one row per app with its adoption state, its latest build status and
// whether Claude is working on it. It reloads on every build.task message, so the rows stay current without polling.

import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { AppSummary } from '@hub/protocol';
import type { ApiClient } from '../net/api.js';
import type { WsClient } from '../net/ws.js';
import { STATUS_LABEL } from '../areas/build/state.js';
import { errorText } from '../net/errors.js';
import { formatRoute } from './route.js';

export interface AppListProps {
  api: ApiClient;
  ws: WsClient;
}

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
    // A reconnect may have missed build.task messages, so the list reloads each time the socket opens.
    const offStatus = ws.onStatus((s) => {
      if (s === 'open') load();
    });

    return () => {
      live = false;
      offMessage();
      offStatus();
    };
  }, [api, ws]);

  return (
    <section class="app-list-page">
      <h1 class="app-list-heading">Apps</h1>
      {error !== null && (
        <p role="alert" data-testid="apps-error" class="app-error">
          {error}
        </p>
      )}
      {apps === null && error === null && (
        <p data-testid="apps-loading" class="app-note">
          Loading apps…
        </p>
      )}
      <ul data-testid="app-list" class="app-list">
        {(apps ?? []).map((app) => (
          <li key={app.name}>
            <a
              data-testid={`app-${app.name}`}
              href={formatRoute({ name: 'app', app: app.name, area: 'build' })}
              class="app-row"
            >
              <span class="app-name">{app.name}</span>
              <span class="app-meta">
                <span
                  data-testid={`badge-${app.name}`}
                  class={`app-badge ${app.adopted ? 'app-badge-adopted' : 'app-badge-idle'}`}
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
        <p data-testid="no-apps" class="app-note">
          No apps yet. Clone a repo into HUB_APPS_DIR on the hub server.
        </p>
      )}
    </section>
  );
}
