import { z } from 'zod';

export const APP_MANIFEST_FILE = '.hub/app.json';
export const APP_NAME_RE = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;

// `/`, or segments that are `*`, `**` or literal text without `*`.
const ROUTE_GLOB = /^(?:\/|(?:\/(?:\*\*?|[^/*]+))+)$/;
const httpUrl = z.string().regex(/^https?:\/\/\S+$/, 'must be an http(s) URL');
const target = z.object({ server: z.string().min(1), url: httpUrl });

export const AppManifestSchema = z.object({
  name: z.string().regex(APP_NAME_RE, 'must be lowercase letters, digits and dashes'),
  template: z.string().regex(/^[a-z0-9-]+@\d+$/, 'must look like name@version'),
  design: z.object({
    dir: z.string().min(1),
    routes: z.string().min(1),
    devices: z.array(z.enum(['desktop', 'tablet', 'mobile'])).min(1),
    /** R8: route globs to import; absent imports every route. See `routeIncluded`. */
    include: z.array(z.string().max(300).regex(ROUTE_GLOB, 'must be a route glob: /-separated segments, each literal, * or **')).min(1).max(200).optional(),
  }),
  build: z.object({
    install: z.string().min(1),
    test: z.string().min(1),
    typecheck: z.string().min(1),
  }),
  deploy: z.object({
    image: z.string().regex(/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/, 'must be ghcr.io/<owner>/<name> in lowercase'),
    staging: target,
    production: target.extend({ domain: z.string().min(1).nullable() }),
  }),
});

export type AppManifest = z.infer<typeof AppManifestSchema>;
export type ManifestResult = { ok: true; manifest: AppManifest } | { ok: false; error: string };

export function parseAppManifest(text: string): ManifestResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: `${APP_MANIFEST_FILE} is not valid JSON` };
  }
  const parsed = AppManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error };
  }
  return { ok: true, manifest: parsed.data };
}

/**
 * R8: whether a route is in scope. In a glob, `*` matches one path segment, `**` any number of segments (including
 * none), and any other segment matches literally, so `/ads/[id]` matches only the route `/ads/[id]`.
 */
export function routeIncluded(include: readonly string[] | undefined, route: string): boolean {
  if (!include) return true;
  const split = (path: string) => path.split('/').filter(Boolean);
  const target = split(route);
  return include.some((text) => {
    const glob = split(text), failed = new Set<number>(); // memo of (at, from) pairs that cannot match, so `**` stays linear
    const match = (at: number, from: number): boolean => {
      if (at === glob.length) return from === target.length;
      const key = at * (target.length + 1) + from;
      if (failed.has(key)) return false;
      const ok = glob[at] === '**'
        ? match(at + 1, from) || (from < target.length && match(at, from + 1))
        : from < target.length && (glob[at] === '*' || glob[at] === target[from]) && match(at + 1, from + 1);
      if (!ok) failed.add(key);
      return ok;
    };
    return match(0, 0);
  });
}
