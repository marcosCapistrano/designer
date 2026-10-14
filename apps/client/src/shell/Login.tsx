// The passphrase gate, shown while the session is logged out. A correct passphrase makes the
// server set the session cookie, and onDone then moves the shell into the app.

import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { ApiError } from '../net/api.js';
import type { ApiClient } from '../net/api.js';

export interface LoginProps {
  api: ApiClient;
  onDone: () => void;
}

/** The text for a failed login: 401 is a wrong passphrase, 429 the server's lockout message, anything else unreachable. */
export function loginErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'Wrong passphrase.';
    if (e.status === 429) return e.message;
  }
  return 'Could not reach the Hub.';
}

export function Login({ api, onDone }: LoginProps): JSX.Element {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(passphrase);
    } catch (err) {
      setError(loginErrorText(err));
      setBusy(false);
      return;
    }
    // Success leaves busy set: this form is unmounted by onDone.
    onDone();
  };

  return (
    <form class="login" data-testid="login" onSubmit={(e) => void submit(e)}>
      <span class="login-title">Hub</span>
      <label class="login-label">
        Passphrase
        <input
          class="login-input"
          data-testid="passphrase"
          type="password"
          autocomplete="current-password"
          autofocus
          value={passphrase}
          onInput={(e) => setPassphrase(e.currentTarget.value)}
        />
      </label>
      {error !== null && (
        <p class="login-error" role="alert" data-testid="login-error">
          {error}
        </p>
      )}
      <button type="submit" class="shell-button login-submit" data-testid="login-submit" disabled={busy}>
        Unlock
      </button>
    </form>
  );
}
