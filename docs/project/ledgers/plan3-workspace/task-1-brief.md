### Task 1: App manifest schema (`@hub/protocol/manifest`)

**Files:**
- Modify: `packages/protocol/package.json`
- Create: `packages/protocol/src/manifest.ts`
- Test: `packages/protocol/src/manifest.test.ts`

**Interfaces:**
- Consumes: plan 2 Task 1 (`packages/protocol` exists).
- Produces (import from `@hub/protocol/manifest`; `src/index.ts` must not re-export it):

```ts
export const APP_MANIFEST_FILE = '.hub/app.json';
export const APP_NAME_RE = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
export const AppManifestSchema: /* z.object below */;
export type AppManifest = z.infer<typeof AppManifestSchema>;
export type ManifestResult = { ok: true; manifest: AppManifest } | { ok: false; error: string };
export function parseAppManifest(text: string): ManifestResult;
```

Schema (exact; unknown keys are stripped, not rejected):

```ts
const httpUrl = z.string().regex(/^https?:\/\/\S+$/, 'must be an http(s) URL');
const target = z.object({ server: z.string().min(1), url: httpUrl });
export const AppManifestSchema = z.object({
  name: z.string().regex(APP_NAME_RE, 'must be lowercase letters, digits and dashes'),
  template: z.string().regex(/^[a-z0-9-]+@\d+$/, 'must look like name@version'),
  design: z.object({ dir: z.string().min(1), routes: z.string().min(1), devices: z.array(z.enum(['desktop', 'tablet', 'mobile'])).min(1) }),
  build: z.object({ install: z.string().min(1), test: z.string().min(1), typecheck: z.string().min(1) }),
  deploy: z.object({
    image: z.string().regex(/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/, 'must be ghcr.io/<owner>/<name> in lowercase'),
    staging: target,
    production: target.extend({ domain: z.string().min(1).nullable() }),
  }),
});
```

`parseAppManifest`: if `JSON.parse` throws, return `{ ok: false, error: '.hub/app.json is not valid JSON' }`. If `safeParse` fails, return `error = issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')`.

- [ ] **Step 1: Write the failing tests.** Fixture `SPEC_EXAMPLE` (spec §4 with the placeholders filled in):

```json
{ "name": "myapp", "template": "vite-hono-pg@1",
  "design": { "dir": "design", "routes": "web/src/routes.tsx", "devices": ["desktop", "tablet", "mobile"] },
  "build": { "install": "pnpm i", "test": "pnpm test", "typecheck": "pnpm typecheck" },
  "deploy": { "image": "ghcr.io/marco/myapp",
    "staging": { "server": "shared-staging", "url": "http://myapp.staging.tail1234.ts.net" },
    "production": { "server": "shared-production", "url": "https://myapp.203.0.113.7.sslip.io", "domain": null } } }
```

  - `accepts the spec example`: `ok === true` and `manifest.build.test === 'pnpm test'`.
  - `rejects invalid JSON`: `parseAppManifest('{')` → error `'.hub/app.json is not valid JSON'`.
  - `names the failing field`: with name `'My App'`, the error contains `'name: '`.
  - `rejects an uppercase image`: `'ghcr.io/Marco/myapp'` → the error contains `'deploy.image'`.
  - `rejects an unknown device`: `devices: ['watch']` → the error contains `'design.devices.0'`.
  - `domain may be a string`: `'myapp.com'` → ok.
  - `missing build section`: delete `build` → the error contains `'build'`.
  - `index does not export the schema`: `'AppManifestSchema' in (await import('./index.js'))` is `false`.
- [ ] **Step 2: Run** `pnpm -F @hub/protocol exec vitest run src/manifest.test.ts`. Expected: FAIL (`./manifest.js` missing).
- [ ] **Step 3: Implement.**
  - Run `pnpm add -F @hub/protocol zod@^4.6.7`.
  - In `package.json`, add `"sideEffects": false` and set `"exports": { ".": "./src/index.ts", "./manifest": "./src/manifest.ts" }`.
  - Write `src/manifest.ts`.
- [ ] **Step 4: Run** `pnpm -F @hub/protocol test && pnpm -F @hub/protocol typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `packages/protocol pnpm-lock.yaml` as `feat(protocol): app manifest zod schema behind a subpath export`, with the attribution trailer your harness provides.

---

