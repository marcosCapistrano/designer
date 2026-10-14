import { describe, expect, it } from 'vitest';
import { LoginLimiter } from './limiter.js';

describe('LoginLimiter', () => {
  it('blocks after 5 failures within the window', () => {
    const limiter = new LoginLimiter();
    for (const now of [0, 1, 2, 3, 4]) limiter.fail(now);
    expect(limiter.blocked(5)).toBe(true);
    expect(limiter.blocked(900_003)).toBe(true);
    expect(limiter.blocked(900_004)).toBe(false);
  });

  it('old failures expire', () => {
    const limiter = new LoginLimiter();
    for (const now of [0, 1, 2, 3]) limiter.fail(now);
    limiter.fail(900_001);
    expect(limiter.blocked(900_001)).toBe(false);
  });

  it('reset clears failures', () => {
    const limiter = new LoginLimiter();
    for (const now of [0, 1, 2, 3]) limiter.fail(now);
    limiter.reset();
    limiter.fail(4);
    expect(limiter.blocked(5)).toBe(false);
  });

  it('reset forgets failures but keeps an active lock', () => {
    const limiter = new LoginLimiter();
    for (const now of [0, 1, 2, 3, 4]) limiter.fail(now);
    expect(limiter.blocked(5)).toBe(true);
    limiter.reset();
    expect(limiter.blocked(5)).toBe(true);
    expect(limiter.blocked(900_004)).toBe(false);
  });
});
