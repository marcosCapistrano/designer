import { describe, expect, it } from 'vitest';
import { ApiError } from '../net/api.js';
import { loginErrorText } from './Login.js';

describe('loginErrorText', () => {
  it('says the passphrase is wrong on 401', () => {
    expect(loginErrorText(new ApiError(401, 'Wrong passphrase'))).toBe('Wrong passphrase.');
  });

  it('shows the server text on 429', () => {
    const msg = 'Too many attempts. Try again in 15 minutes.';
    expect(loginErrorText(new ApiError(429, msg))).toBe(msg);
  });

  it('says the Hub could not be reached for any other failure', () => {
    expect(loginErrorText(new ApiError(500, 'boom'))).toBe('Could not reach the Hub.');
    expect(loginErrorText(new ApiError(400, 'passphrase is required'))).toBe('Could not reach the Hub.');
    expect(loginErrorText(new TypeError('Failed to fetch'))).toBe('Could not reach the Hub.');
  });
});
