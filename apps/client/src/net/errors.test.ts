import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import { errorText } from './errors.js';

describe('errorText', () => {
  it("shows the server's message for an API error", () => {
    expect(errorText(new ApiError(409, 'Claude is already working on this app.'))).toBe('Claude is already working on this app.');
  });

  it('says the hub could not be reached for anything else', () => {
    expect(errorText(new TypeError('Failed to fetch'))).toBe('Could not reach the hub. Try again.');
    expect(errorText('boom')).toBe('Could not reach the hub. Try again.');
    expect(errorText(null)).toBe('Could not reach the hub. Try again.');
  });
});
