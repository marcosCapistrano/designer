// The shell's login state, kept out of App.tsx so its rules can be unit-tested in node.

export type Auth = 'checking' | 'in' | 'out' | 'offline';

export interface AuthState {
  auth: Auth;
  /** Why the last Log out did not take effect; shown next to the button only while logged in. */
  logoutError: string | null;
}

export const INITIAL_AUTH: AuthState = { auth: 'checking', logoutError: null };

/**
 * Moves to `auth`. Going 'out' drops the logout error however the session ended (logout, expiry, a 401):
 * it described a session that is gone, and must not greet the next login.
 */
export function withAuth(s: AuthState, auth: Auth): AuthState {
  if (auth === s.auth && (auth !== 'out' || s.logoutError === null)) return s;
  return { auth, logoutError: auth === 'out' ? null : s.logoutError };
}

export function withLogoutError(s: AuthState, logoutError: string | null): AuthState {
  return logoutError === s.logoutError ? s : { ...s, logoutError };
}
