export type Area = 'design' | 'build' | 'deploy';

export const AREAS: readonly Area[] = ['design', 'build', 'deploy'];

export const AREA_LABEL: Readonly<Record<Area, string>> = { design: 'Design', build: 'Build', deploy: 'Deploy' };

export type Route = { name: 'apps' } | { name: 'app'; app: string; area: Area };

const APP_PREFIX = '#/apps/';

function isArea(value: string): value is Area {
  return (AREAS as readonly string[]).includes(value);
}

/**
 * '' | '#' | '#/' → apps; '#/apps/<enc>' → area 'build'; '#/apps/<enc>/<area>' (unknown area → 'build');
 * a bad escape or anything else → apps.
 */
export function parseHash(hash: string): Route {
  if (!hash.startsWith(APP_PREFIX)) return { name: 'apps' };
  const parts = hash.slice(APP_PREFIX.length).split('/');
  if (parts.length > 2) return { name: 'apps' };
  const [encoded = '', area = ''] = parts;
  let app: string;
  try {
    app = decodeURIComponent(encoded);
  } catch {
    return { name: 'apps' };
  }
  if (app === '') return { name: 'apps' };
  return { name: 'app', app, area: isArea(area) ? area : 'build' };
}

export function formatRoute(r: Route): string {
  return r.name === 'apps' ? '#/' : `#/apps/${encodeURIComponent(r.app)}/${r.area}`;
}
