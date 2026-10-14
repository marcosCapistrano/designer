### Task 7: App registry

**Files:**
- Create: `apps/server/src/apps/registry.ts`
- Test: `apps/server/src/apps/registry.test.ts`

**Interfaces:**
- Consumes: Task 1 (`parseAppManifest`, `AppManifest`, `APP_MANIFEST_FILE` from `@hub/protocol/manifest`), Task 3.
- Produces:

```ts
export interface AppEntry { name: string; dir: string; adopted: boolean; manifest: AppManifest | null; manifestError: string | null }
export class AppRegistry {
  constructor(appsDir: string);
  list(): Promise<AppEntry[]>;              // sorted by name; missing appsDir → []
  get(name: string): Promise<AppEntry | null>;
}
```

Rules:
- An app is a directory directly in `appsDir` whose name does not start with `.` and that contains a `.git` entry (directory or file). Each call rescans; there is no cache.
- `get(name)` returns `null` for names containing `/` or `\`, for `.` and `..`, and for unknown names. It stats only that one directory.
- Manifest at `<dir>/.hub/app.json`:
  - Absent → `{ adopted: false, manifest: null, manifestError: null }`.
  - Unparsable → `manifestError` = the `parseAppManifest` error.
  - Valid but `manifest.name !== name` → `` `manifest name "${manifest.name}" does not match the folder name "${name}"` `` and `adopted: false`.
  - Otherwise `adopted: true`.

- [ ] **Step 1: Write the failing tests.** Make directories in a temp dir with `mkdirSync`; a fake `.git` directory is enough. Use the Task 1 `SPEC_EXAMPLE` manifest, copied into this test with `name` set per test.
  - `lists git checkouts only, sorted`: `zeta/.git/`, `alpha/.git` (a file), `notgit/`, `.hidden/.git/` and a file `readme.txt` → names `['alpha', 'zeta']`.
  - `valid manifest means adopted`: `alpha/.hub/app.json` with name `alpha` → `adopted: true` and `manifest.name === 'alpha'`.
  - `invalid manifest reports the error`: `'{'` → `manifestError === '.hub/app.json is not valid JSON'` and `adopted: false`.
  - `manifest name must match the folder`: name `other` in `alpha` → `manifestError` contains `does not match the folder name "alpha"`.
  - `get returns null for unknown or unsafe names`: `'nope'`, `'..'` and `'a/b'` → `null`. `get('alpha')` → entry.
  - `missing apps dir lists nothing`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/apps/registry.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `registry.ts`.
- [ ] **Step 4: Run** the same command. Expected: 6 pass.
- [ ] **Step 5: Commit** `apps/server/src/apps` as `feat(server): app registry over git checkouts with manifest validation`, with the attribution trailer your harness provides.

---

