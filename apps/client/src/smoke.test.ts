import { describe, expect, it } from 'vitest';
import { DEVICE_WIDTH } from '@hub/protocol';

describe('client smoke', () => {
  it('resolves the protocol package', () => {
    expect(DEVICE_WIDTH.mobile).toBe(390);
  });
});
