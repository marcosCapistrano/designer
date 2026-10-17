import { describe, expect, it } from 'vitest';
import { formatRoute, parseHash, shellClass } from './route.js';

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

  it('empty, bare hash and root hash open the apps list', () => {
    expect(parseHash('')).toEqual({ name: 'apps' });
    expect(parseHash('#')).toEqual({ name: 'apps' });
    expect(parseHash('#/')).toEqual({ name: 'apps' });
  });

  it('an empty app name opens the apps list', () => {
    expect(parseHash('#/apps/')).toEqual({ name: 'apps' });
    expect(parseHash('#/apps//design')).toEqual({ name: 'apps' });
  });

  it('more than two segments open the apps list', () => {
    expect(parseHash('#/apps/x/design/extra')).toEqual({ name: 'apps' });
  });

  it('a trailing slash opens Build', () => {
    expect(parseHash('#/apps/x/')).toEqual({ name: 'app', app: 'x', area: 'build' });
  });

  it('an app name with a slash survives the round trip', () => {
    const route = { name: 'app', app: 'a/b', area: 'deploy' } as const;
    expect(formatRoute(route)).toBe('#/apps/a%2Fb/deploy');
    expect(parseHash(formatRoute(route))).toEqual(route);
  });

  it('the apps route formats as the root hash', () => {
    expect(formatRoute({ name: 'apps' })).toBe('#/');
  });
});

describe('shellClass', () => {
  it('makes only the Design area immersive', () => {
    expect(shellClass({ name: 'app', app: 'a', area: 'design' })).toBe('shell shell-immersive');
    expect(shellClass({ name: 'app', app: 'a', area: 'build' })).toBe('shell');
    expect(shellClass({ name: 'apps' })).toBe('shell');
  });
});
