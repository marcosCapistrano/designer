### Task 3: Server scaffold and config

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`, `apps/server/src/config.ts`
- Modify: `pnpm-workspace.yaml`
- Test: `apps/server/src/config.test.ts`

**Interfaces:**
- Consumes: Task 1 (it must land first because both change `pnpm-lock.yaml`).
- Produces:

```ts
export interface HubConfig {
  bind: string; port: number; dataDir: string; appsDir: string; passphraseHash: string;
  githubToken: string | null; githubOwner: string | null; claudeOauthToken: string | null;
}
export class ConfigError extends Error {}
export const DEFAULT_PORT = 8787;
export const CREDENTIAL_KEYS: readonly string[] = ['HUB_PASSPHRASE_HASH', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
export const SECRET_ENV_KEYS: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'HCLOUD_TOKEN', 'HUB_PASSPHRASE_HASH', 'HUB_SSH_KEY_PATH', 'CREDENTIALS_DIRECTORY'];
export function loadConfig(env: Record<string, string | undefined>): HubConfig;
export function scrubEnv(env: Record<string, string | undefined>): Record<string, string>;
```

Rules for `loadConfig`:
- A credential key's value is `env[K]` if non-blank. Otherwise it is the trimmed contents of `${env.CREDENTIALS_DIRECTORY}/${K}` when that file exists (systemd `LoadCredentialEncrypted`). Otherwise it is absent.
- Required: `HUB_BIND`, `HUB_DATA_DIR`, `HUB_APPS_DIR`, `HUB_PASSPHRASE_HASH`. All missing names go into one error: `` `Missing required environment variables: ${names.join(', ')}` `` (in that order).
- `HUB_BIND` in `['0.0.0.0', '::', '[::]', '*']` → `'HUB_BIND must be one specific address (127.0.0.1 behind tailscale serve), not a wildcard'`.
- `HUB_PORT` defaults to 8787. It must be an integer 1–65535, else `'HUB_PORT must be a port number'`.
- `HUB_PASSPHRASE_HASH` must start with `scrypt:`, else `'HUB_PASSPHRASE_HASH must come from: pnpm --silent -F @hub/server hash-passphrase'`.
- Directories go through `path.resolve`. `GITHUB_TOKEN`, `GITHUB_OWNER` and `CLAUDE_CODE_OAUTH_TOKEN` are `null` when absent.

`scrubEnv` copies every defined entry whose key is not in `SECRET_ENV_KEYS`.

- [ ] **Step 1: Scaffold.**
  - `package.json`: name `@hub/server`, `"private": true`, `"type": "module"`. Scripts: `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`, `"start": "tsx src/main.ts"`, `"dev:fake": "tsx src/dev/fake-hub.ts"`, `"hash-passphrase": "tsx src/auth/hash-cli.ts"`.
  - Install all server dependencies now; no later task touches the lockfile:
    - `pnpm add -F @hub/server @hub/protocol@workspace:* hono@^4.13.13 @hono/node-server@^2.1.5 ws@^8.22.0 better-sqlite3@^13.0.3 simple-git@^3.36.0 @octokit/rest@^22.0.1 @anthropic-ai/claude-agent-sdk@^0.3.290 zod@^4.6.7 tsx@^4.23.15`
    - `pnpm add -D -F @hub/server @types/node@^22 @types/ws@^8.18.2 @types/better-sqlite3@^9.6.0 vitest@^5.0.4 typescript@^7.0.2`
    - pnpm auto-installs the SDK's other peers.
  - `tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "types": ["node"], "esModuleInterop": true }, "include": ["src"] }`.
  - `vitest.config.ts`: `test: { include: ['src/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 }`.
  - Append this to `pnpm-workspace.yaml`, merging with any existing `allowBuilds` map:

    ```yaml
    allowBuilds:
      better-sqlite3: true
    ```

  - Run `pnpm install`.
- [ ] **Step 2: Write the failing tests** (`config.test.ts`). `FULL = { HUB_BIND: '127.0.0.1', HUB_PORT: '9000', HUB_DATA_DIR: 'data', HUB_APPS_DIR: '/srv/apps', HUB_PASSPHRASE_HASH: 'scrypt:x' }`.
  - `loads a full environment`: `loadConfig(FULL)` toEqual `{ bind: '127.0.0.1', port: 9000, dataDir: resolve('data'), appsDir: '/srv/apps', passphraseHash: 'scrypt:x', githubToken: null, githubOwner: null, claudeOauthToken: null }`.
  - `defaults the port to 8787`.
  - `lists every missing variable`: `loadConfig({})` throws `ConfigError` with exactly `'Missing required environment variables: HUB_BIND, HUB_DATA_DIR, HUB_APPS_DIR, HUB_PASSPHRASE_HASH'`.
  - `rejects wildcard binds`: `'0.0.0.0'` and `'::'` throw `/wildcard/`.
  - `rejects a bad port`: `'abc'` and `'70000'` throw `/HUB_PORT/`.
  - `rejects a hash that is not scrypt`.
  - `reads secrets from CREDENTIALS_DIRECTORY`:
    - In a temp dir, write `HUB_PASSPHRASE_HASH` (`'scrypt:file\n'`) and `GITHUB_TOKEN` (`'ghp_file\n'`).
    - Then `loadConfig({ ...FULL, HUB_PASSPHRASE_HASH: undefined, CREDENTIALS_DIRECTORY: dir })` has `passphraseHash 'scrypt:file'` and `githubToken 'ghp_file'`.
    - An env value wins over the file.
  - `scrubEnv removes secrets and keeps the rest`: `scrubEnv({ PATH: '/bin', GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'k', CREDENTIALS_DIRECTORY: '/run/c', CLAUDE_CODE_OAUTH_TOKEN: 'o', U: undefined })` toEqual `{ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'o' }`.
- [ ] **Step 3: Run** `pnpm -F @hub/server test`. Expected: FAIL (`./config.js` missing).
- [ ] **Step 4: Implement** `src/config.ts`.
- [ ] **Step 5: Verify.**
  - `pnpm -F @hub/server test && pnpm -F @hub/server typecheck` passes.
  - `pnpm -F @hub/server exec node -e "const D=require('better-sqlite3'); new D(':memory:').close(); console.log('sqlite ok')"` prints `sqlite ok`, which proves the native build ran.
- [ ] **Step 6: Commit** `apps/server pnpm-workspace.yaml pnpm-lock.yaml` as `feat(server): scaffold, config with credentials and env scrubbing`, with the attribution trailer your harness provides.

---

