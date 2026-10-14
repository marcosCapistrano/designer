// The decision behind the Log out button, kept out of App.tsx so it can be unit-tested in node.

import { ApiError } from '../net/api.js';

/** Shown under the Log out button when the server does not confirm the logout. */
export const LOGOUT_ERROR_TEXT = 'Could not log out. Try again.';

/**
 * Whether a failed logout request still locks the shell. A 401 means the server has no session
 * for this browser, so the user is logged out in effect. Any other failure leaves them logged in.
 */
export function logoutLocks(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}
