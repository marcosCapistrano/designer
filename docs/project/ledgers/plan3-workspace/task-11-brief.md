### Task 11: Git wrapper and test repositories

**Files:**
- Create: `apps/server/src/git/git.ts`, `apps/server/src/git/test-repo.ts`
- Test: `apps/server/src/git/git.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces:

```ts
// git.ts (simple-git)
export interface GitIdentity { name: string; email: string }
export interface RepoOptions { token?: string | null; identity?: GitIdentity }
export interface GitRepo {
  readonly dir: string;
  currentBranch(): Promise<string>;                               // rev-parse --abbrev-ref HEAD
  defaultBranch(): Promise<string>;                               // symbolic-ref --short refs/remotes/origin/HEAD minus 'origin/'; else 'main' if origin/main exists; else 'master'
  fetch(): Promise<void>;                                         // fetch origin --prune (authed)
  createBranchFrom(branch: string, base: string): Promise<void>;  // checkout --no-track -B <branch> origin/<base>
  checkout(branch: string): Promise<void>;
  isDirty(): Promise<boolean>;                                    // staged, unstaged or untracked changes
  commitAll(message: string): Promise<string | null>;             // add -A; commit; full HEAD sha, or null when clean
  headSha(): Promise<string>;
  commitsAhead(base: string): Promise<number>;                    // rev-list --count origin/<base>..HEAD
  push(branch: string): Promise<void>;                            // push --set-upstream origin <branch> (authed)
  remoteUrl(): Promise<string | null>;                            // `git config --get remote.origin.url` (unexpanded)
}
export function gitEnv(identity?: GitIdentity): Record<string, string>;
// exactly: PATH, HOME (from process.env, defaults '/usr/bin:/bin' and '/tmp'), GIT_TERMINAL_PROMPT '0',
// plus GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_NAME/EMAIL when identity is given
export function authConfig(token: string | null | undefined): string[];
// token → [`http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]; else []
export function openRepo(dir: string, opts?: RepoOptions): GitRepo;
// test-repo.ts (test support, used by Tasks 15–18 and 21)
export const TEST_IDENTITY: GitIdentity;           // { name: 'Hub Test', email: 'hub-test@example.com' }
export const TEST_REMOTE = 'https://github.com/acme/demo.git';
export interface TestRepo { origin: string; work: string }
export function makeTestRepo(opts?: { workDir?: string; files?: Record<string, string> }): TestRepo;
export function git(cwd: string, ...args: string[]): string;   // execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv(TEST_IDENTITY) } }).trim()
```

Both simple-git instances use `.env(gitEnv(opts.identity))`. That minimal env is required, because simple-git refuses `EDITOR`, `PAGER` and `GIT_CONFIG_*` in the env. The token goes only through `simpleGit({ baseDir, config: authConfig(token) })`, a second instance used only for `fetch` and `push`. It is never written to `.git/config`.

`makeTestRepo` steps:
1. `tmp = mkdtempSync(join(tmpdir(), 'hub-git-'))`, `origin = join(tmp, 'origin.git')`, `git init --bare -b main <origin>`.
2. In `seed = join(tmp, 'seed')`, run `git init -b main`, write `README.md` (`'# demo\n'`) plus `opts.files` (creating parent folders), `add -A`, `commit -m init`, `remote add origin <origin>`, `push origin main`. Then `rmSync(seed)`.
3. `work = opts.workDir ?? join(tmp, 'demo')`. Run `git clone <origin> <work>`.
4. In `work`, run `remote set-url origin https://github.com/acme/demo.git` and `config url.<origin>.insteadOf https://github.com/acme/demo.git`. The remote reads like GitHub, but fetch and push go to the local bare repo.

- [ ] **Step 1: Write the failing tests** (each uses `makeTestRepo()` and `openRepo(work, { identity: TEST_IDENTITY })`):
  - `knows the default and current branch`: `defaultBranch() === 'main'` and `currentBranch() === 'main'`.
  - `creates a branch from origin`: `createBranchFrom('build/x-1', 'main')` → `currentBranch() === 'build/x-1'`.
  - `commitAll commits everything or returns null`: a clean tree → `null`. Writing `a.txt` → `isDirty()` is true, and `commitAll('add a')` returns a 40-hex SHA equal to `headSha()`. Then `isDirty()` is false and `commitsAhead('main') === 1`.
  - `push publishes the branch`: after the commit, `push('build/x-1')` → `git(origin, 'rev-parse', 'refs/heads/build/x-1')` equals `headSha()`.
  - `token never lands in git config`: `openRepo(work, { token: 'secret-token', identity: TEST_IDENTITY }).push('build/x-1')` succeeds, and `.git/config` contains neither `secret-token` nor its base64.
  - `authConfig`: `authConfig('t')` toEqual `['http.https://github.com/.extraheader=AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46dA==']`, and `authConfig(null)` is `[]`.
  - `remote url is the configured one`: `remoteUrl() === TEST_REMOTE`.
  - `gitEnv is minimal`: with `vi.stubEnv('PAGER', 'less')` and `vi.stubEnv('GITHUB_TOKEN', 'g')`, `Object.keys(gitEnv()).sort()` toEqual `['GIT_TERMINAL_PROMPT', 'HOME', 'PATH']`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/git`. Expected: FAIL.
- [ ] **Step 3: Implement** `git.ts` and `test-repo.ts`.
- [ ] **Step 4: Run** the same command. Expected: 8 pass.
- [ ] **Step 5: Commit** `apps/server/src/git` as `feat(server): git wrapper with header-only auth and test repos`, with the attribution trailer your harness provides.

---

