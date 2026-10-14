// The app shell: the session check, the passphrase gate, the hash router and the one WebSocket
// every screen shares. ApiClient and WsClient are created once here and passed down unchanged,
// so BuildArea's effects (keyed on app, api and ws) do not re-run on every render.

import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { ApiClient } from '../net/api.js';
import { WsClient, wsUrl } from '../net/ws.js';
import { AppList } from './AppList.js';
import { AppView } from './AppView.js';
import { Login } from './Login.js';
import { parseHash } from './route.js';
import type { Route } from './route.js';

type Auth = 'checking' | 'in' | 'out' | 'offline';

export function App(): JSX.Element {
  const [auth, setAuth] = useState<Auth>('checking');
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const api = useMemo(() => new ApiClient({ onUnauthorized: () => setAuth('out') }), []);
  const ws = useMemo(() => new WsClient({ url: wsUrl(location) }), []);

  const checkSession = useCallback((): void => {
    setAuth('checking');
    api.session().then(
      (ok) => setAuth(ok ? 'in' : 'out'),
      () => setAuth('offline'),
    );
  }, [api]);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  useEffect(() => {
    const onHash = (): void => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // The socket lives exactly as long as the session. Leaving 'in' (or unmounting) closes it.
  useEffect(() => {
    if (auth !== 'in') return;
    ws.connect();
    return () => ws.close();
  }, [auth, ws]);

  // A phone or tablet wakes with a socket that may be dead. Returning to the page reconnects it at once.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') ws.kick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [ws]);

  const logout = async (): Promise<void> => {
    try {
      await api.logout();
    } catch {
      // The screen locks either way. A failed request only leaves the server-side session to expire.
    }
    setAuth('out');
  };

  if (auth === 'checking') {
    return (
      <div class="shell shell-center">
        <p class="shell-note" data-testid="loading">
          Loading…
        </p>
      </div>
    );
  }

  if (auth === 'offline') {
    return (
      <div class="shell shell-center">
        <div class="shell-offline" data-testid="offline" role="alert">
          Can't reach the Hub. Check that Tailscale is connected.
          <button type="button" class="shell-button" onClick={() => checkSession()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (auth === 'out') {
    return (
      <div class="shell shell-center">
        <Login api={api} onDone={() => setAuth('in')} />
      </div>
    );
  }

  return (
    <div class="shell">
      <header class="shell-header">
        <span class="shell-title">Hub</span>
        <button type="button" class="shell-button shell-button-quiet" data-testid="logout" onClick={() => void logout()}>
          Log out
        </button>
      </header>
      <main class="shell-main">
        {route.name === 'app' ? (
          <AppView app={route.app} area={route.area} api={api} ws={ws} />
        ) : (
          <AppList api={api} ws={ws} />
        )}
      </main>
    </div>
  );
}
