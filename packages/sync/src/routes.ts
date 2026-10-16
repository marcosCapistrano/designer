import { routeIncluded } from '@hub/protocol/manifest';
import type { RouteEntry, SourceProject } from './types.js';

/**
 * Next App Router pages, including groups and dynamic segments, with ancestor layouts. Only routes `include` matches
 * (R8, `design.include`) are returned or checked; parallel-route slots and groups do not appear in the matched route.
 */
export function discoverNextRoutes(project: SourceProject, appDir = 'app', include?: readonly string[]): RouteEntry[] {
  if (!/^(?:[\w.-]+\/)*[\w.-]+$/.test(appDir) || appDir.split('/').includes('..')) {
    throw new Error('App directory must be a relative source path');
  }
  const routes: RouteEntry[] = [];
  const seen = new Set<string>();
  for (const file of Object.keys(project.files).sort()) {
    if (!file.startsWith(`${appDir}/`) || !/\/page\.(tsx|jsx)$/.test(file)) continue;
    const segments = file.slice(appDir.length + 1).split('/').slice(0, -1);
    if (!routeIncluded(include, '/' + segments.filter((part) => !/^\([^/]+\)$/.test(part) && !part.startsWith('@')).join('/'))) continue;
    if (segments.some((segment) => segment.startsWith('@') || /^\(\.{1,3}\)/.test(segment))) {
      throw new Error(`Parallel and intercepted routes need a preview choice: ${file}`);
    }
    const route = '/' + segments.filter((part) => !/^\([^/]+\)$/.test(part)).join('/');
    if (seen.has(route)) throw new Error(`Duplicate route ${route}`);
    seen.add(route);
    const layouts: string[] = [];
    for (let depth = 0; depth <= segments.length; depth++) {
      const dir = [appDir, ...segments.slice(0, depth)].join('/');
      const candidates = ['tsx', 'jsx'].map((ext) => `${dir}/layout.${ext}`).filter((p) => Object.hasOwn(project.files, p));
      if (candidates.length > 1) throw new Error(`Ambiguous layout in ${dir}`);
      if (candidates[0]) layouts.push(candidates[0]);
    }
    routes.push({ route, file, layouts });
  }
  return routes;
}
