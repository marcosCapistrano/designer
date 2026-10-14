import { describe, expect, it } from 'vitest';
import { errorText } from './errors.js';

describe('errorText', () => {
  it('is the message of an Error', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText(new TypeError('bad type'))).toBe('bad type');
  });

  it('is the string of a thrown string, number or null', () => {
    expect(errorText('refused')).toBe('refused');
    expect(errorText(42)).toBe('42');
    expect(errorText(null)).toBe('null');
    expect(errorText(undefined)).toBe('undefined');
  });

  it('reads the message of a plain object that carries one', () => {
    expect(errorText({ message: 'from an object', code: 7 })).toBe('from an object');
    expect(errorText(Object.assign(Object.create(null), { message: 'no prototype' }))).toBe('no prototype');
  });

  it('does not throw for a value that cannot be turned into a string', () => {
    const noPrototype = Object.create(null) as object;
    expect(() => String(noPrototype)).toThrow();
    expect(errorText(noPrototype)).toBe('Unprintable error');

    const hostile = {
      get message(): string {
        throw new Error('getter');
      },
    };
    expect(errorText(hostile)).toBe('Unprintable error');
    expect(errorText({ toString: () => { throw new Error('toString'); } })).toBe('Unprintable error');
    expect(errorText(Symbol('s'))).toBe('Symbol(s)');
  });

  it('does not throw for an Error whose message getter throws', () => {
    const error = new Error('x');
    Object.defineProperty(error, 'message', {
      get() {
        throw new Error('getter');
      },
    });
    expect(errorText(error)).toBe('Unprintable error');
  });
});
