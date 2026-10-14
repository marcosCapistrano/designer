import { describe, expect, it } from 'vitest';
import { INITIAL_AUTH, withAuth, withLogoutError } from './auth.js';

describe('auth state', () => {
  it('starts by checking the session', () => {
    expect(INITIAL_AUTH).toEqual({ auth: 'checking', logoutError: null });
  });

  it('keeps a logout error while the session stays valid', () => {
    const failed = withLogoutError({ auth: 'in', logoutError: null }, 'Could not log out. Try again.');
    expect(withAuth(failed, 'in')).toBe(failed);
    expect(withAuth(failed, 'offline').logoutError).toBe('Could not log out. Try again.');
  });

  it("clears the logout error whenever auth goes 'out'", () => {
    const failed = { auth: 'in', logoutError: 'Could not log out. Try again.' } as const;
    expect(withAuth(failed, 'out')).toEqual({ auth: 'out', logoutError: null });
    // Also when the session was already 'out' (a second path to the same place).
    expect(withAuth({ auth: 'out', logoutError: 'stale' }, 'out')).toEqual({ auth: 'out', logoutError: null });
  });

  it("stays clear through the next login", () => {
    let s = withLogoutError({ auth: 'in', logoutError: null }, 'Could not log out. Try again.');
    s = withAuth(s, 'out');
    s = withAuth(s, 'in');
    expect(s).toEqual({ auth: 'in', logoutError: null });
  });

  it('returns the same state when nothing changes', () => {
    const s = { auth: 'in', logoutError: null } as const;
    expect(withAuth(s, 'in')).toBe(s);
    expect(withLogoutError(s, null)).toBe(s);
  });
});
