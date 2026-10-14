import { describe, expect, it } from 'vitest';
import { formatRoute, parseHash } from './route.js';

describe('hash routes', () => {
  it('round trips an app route with an encoded name', () => {
    const route = { name: 'app', app: 'my app', area: 'design' } as const;
    expect(formatRoute(route)).toBe('#/apps/my%20app/design');
    expect(parseHash(formatRoute(route))).toEqual(route);
  });

  it('an app route without an area opens Build', () => {
    expect(parseHash('#/apps/x')).toEqual({ name: 'app', app: 'x', area: 'build' });
  });

  it('an unknown area opens Build', () => {
    expect(parseHash('#/apps/x/bogus')).toEqual({ name: 'app', app: 'x', area: 'build' });
  });

  it('a bad escape falls back to the apps list', () => {
    expect(parseHash('#/apps/%E0%A4%A')).toEqual({ name: 'apps' });
  });

  it('anything else falls back to the apps list', () => {
    expect(parseHash('#/whatever')).toEqual({ name: 'apps' });
  });
});
