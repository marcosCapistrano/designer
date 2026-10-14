import { describe, expect, it } from 'vitest';
import { ApiError } from '../net/api.js';
import { logoutLocks } from './logout.js';

describe('logoutLocks', () => {
  it('locks on 401: the server already has no session for this browser', () => {
    expect(logoutLocks(new ApiError(401, 'Not logged in'))).toBe(true);
  });

  it('keeps the user logged in on any other server failure', () => {
    expect(logoutLocks(new ApiError(500, 'boom'))).toBe(false);
    expect(logoutLocks(new ApiError(429, 'slow down'))).toBe(false);
  });

  it('keeps the user logged in when the request never reached the Hub', () => {
    expect(logoutLocks(new TypeError('Failed to fetch'))).toBe(false);
  });
});
