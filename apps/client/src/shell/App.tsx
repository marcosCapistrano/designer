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
import { INITIAL_AUTH, withAuth, withLogoutError } from './auth.js';
import type { Auth } from './auth.js';
import { LOGOUT_ERROR_TEXT, logoutLocks } from './logout.js';
import { parseHash, shellClass } from './route.js';
import type { Route } from './route.js';
import { SessionCheck } from './session-check.js';

export function App(): JSX.Element {
  const [{ auth, logoutError }, setShell] = useState(INITIAL_AUTH);
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const setAuth = useCallback((next: Auth): void => setShell((s) => withAuth(s, next)), []);
  const setLogoutError = useCallback((text: string | null): void => setShell((s) => withLogoutError(s, text)), []);
  const api = useMemo(() => new ApiClient({ onUnauthorized: () => setAuth('out') }), [setAuth]);
  const ws = useMemo(() => new WsClient({ url: wsUrl(location) }), []);
  // The start-up check, and the Retry button's. A newer one replaces an older one in flight.
  const startupCheck = useMemo(
    () => new SessionCheck(api, { onResult: (ok) => setAuth(ok ? 'in' : 'out'), onError: () => setAuth('offline') }),
    [api, setAuth],
  );

  const checkSession = useCallback((): void => {
    setAuth('checking');
    startupCheck.run();
  }, [setAuth, startupCheck]);

  useEffect(() => {
    checkSession();
    return () => startupCheck.stop();
  }, [checkSession, startupCheck]);

  useEffect(() => {
    const onHash = (): void => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // The socket lives exactly as long as the session. Leaving 'in' (or unmounting) closes it.
  // An expired session refuses the socket's upgrade with a 401, which the browser reports only as a
  // close. So each close asks the server whether the session still holds. A rejected check is ignored:
  // the network is down, and the socket's backoff keeps going. The listener comes off before close(),
  // so closing here never starts a check, and the check is stopped with the effect: an answer about a
  // session that has since been logged out must not log out the next one.
  useEffect(() => {
    if (auth !== 'in') return;
    const expiry = new SessionCheck(api, {
      onResult: (ok) => {
        if (!ok) setAuth('out');
      },
      onError: () => {},
    });
    const offStatus = ws.onStatus((s) => {
      if (s === 'closed') expiry.run();
    });
    ws.connect();
    return () => {
      offStatus();
      expiry.stop();
      ws.close();
    };
  }, [auth, api, ws, setAuth]);

  // A phone or tablet wakes with a socket that may be dead, and a network that returns may have
  // dropped one too. Returning to the page or coming back online reconnects it at once.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') ws.kick();
    };
    const onOnline = (): void => ws.kick();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [ws]);

  // The user stays logged in until the server confirms the logout (a 401 also means no session is left).
  const logout = async (): Promise<void> => {
    setLogoutError(null);
    try {
      await api.logout();
    } catch (e) {
      if (!logoutLocks(e)) {
        setLogoutError(LOGOUT_ERROR_TEXT);
        return;
      }
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
    <div class={shellClass(route)}>
      <header class="shell-header">
        <span class="shell-title">Hub</span>
        <div class="shell-header-actions">
          {logoutError !== null && (
            <span class="shell-header-error" role="alert" data-testid="logout-error">
              {logoutError}
            </span>
          )}
          <button type="button" class="shell-button shell-button-quiet" data-testid="logout" onClick={() => void logout()}>
            Log out
          </button>
        </div>
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
