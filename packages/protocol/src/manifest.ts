import { z } from 'zod';

export const APP_MANIFEST_FILE = '.hub/app.json';
export const APP_NAME_RE = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;

const httpUrl = z.string().regex(/^https?:\/\/\S+$/, 'must be an http(s) URL');
const target = z.object({ server: z.string().min(1), url: httpUrl });

export const AppManifestSchema = z.object({
  name: z.string().regex(APP_NAME_RE, 'must be lowercase letters, digits and dashes'),
  template: z.string().regex(/^[a-z0-9-]+@\d+$/, 'must look like name@version'),
  design: z.object({
    dir: z.string().min(1),
    routes: z.string().min(1),
    devices: z.array(z.enum(['desktop', 'tablet', 'mobile'])).min(1),
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
