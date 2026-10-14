### Task 17: CI refresh and merge

**Files:**
- Create: `apps/server/src/build/ci.ts`
- Test: `apps/server/src/build/ci.test.ts`

**Interfaces:**
- Consumes: Task 15 (`BuildDeps`, `addBuildMessage`, `publishTask`, `repoRefFor`), Task 12 (`FakeGitHub`, `FAILED_CONCLUSIONS`), Task 13.
- Produces:

```ts
export class BuildError extends Error { constructor(message: string, readonly status: 400 | 404 | 409) }
export function refreshCi(deps: BuildDeps, taskId: number): Promise<BuildTask | null>;
export function pollCi(deps: BuildDeps, isRunning: (app: string) => boolean): Promise<void>;
export function mergeTask(deps: BuildDeps, app: string, taskId: number, running: boolean): Promise<BuildTask>;
```

`refreshCi`:
- Return the stored task unchanged when it is missing, not `review`, has no `prNumber`, `deps.github` is null, or the app or `RepoRef` can't be found. The `RepoRef` comes from `registry.get(task.app)` → `repoRefFor(deps, entry.dir)`.
- Call `pr = getPr`:
  - `pr.merged` → `{ status: 'merged', mergeSha: pr.mergeSha }`, a status message `` `Pull request #${n} was merged on GitHub.` ``, and `onMerged` when `mergeSha` is set.
  - `pr.state === 'closed'` → `closed` with a status message `` `Pull request #${n} was closed.` ``.
  - Otherwise call `ci = checkStatus(ref, pr.headSha)`. If `ci.state` or the head changed, update `{ ci: ci.state, headSha: pr.headSha }` and `publishTask(task, false)`.
- When the CI state changed:
  - to `success` → status message `'CI passed. Ready to merge.'`
  - to `failure` → `error` message `` `CI failed: ${failedNames.join(', ')}` ``, where the names are the checks with a `FAILED_CONCLUSIONS` conclusion.
- GitHub errors are caught (`console.warn`), and the task is returned unchanged.

`pollCi`: runs `refreshCi` in sequence for every `review` task whose app `!isRunning`.

`mergeTask` checks, in order:
1. Missing task or `task.app !== app` → `BuildError('Task not found', 404)`.
2. `running` → 409 `'Claude is still working on this app.'`.
3. Status `merged` → return it (idempotent).
4. Not `review`, or no `prNumber` → 409 `'This task has no open pull request.'`.
5. No github → 409 `'GITHUB_TOKEN is not set.'`.
6. `pr = getPr`:
   - `merged` → mark it merged and return.
   - Not `open` → mark it `closed` and throw 409 `'The pull request is closed.'`.
7. `ci = checkStatus(ref, pr.headSha)`. Update `{ ci, headSha }`. If `ci.state !== 'success'` → 409 `` `CI is ${ci.state === 'none' ? 'not reporting any checks' : ci.state}; merge needs green CI.` ``.
8. `out = github.merge(ref, pr.number, pr.headSha)`. If `!out.merged` → 409 `` `GitHub refused the merge: ${out.message}` ``.
9. Update `{ status: 'merged', mergeSha: out.sha, error: null }`, add a status message `` `Merged pull request #${n}.` ``, call `publishTask(task, false)` and `onMerged?.({ app, taskId, prNumber: n, sha: out.sha! })`, and return.

- [ ] **Step 1: Write the failing tests.**
  - Setup:
    - `registry = { get: async n => n === 'demo' ? { name: 'demo', dir: '/w', adopted: true, manifest: null, manifestError: null } : null }`.
    - `openRepo = () => ({ remoteUrl: async () => 'https://github.com/acme/demo.git' }) as unknown as GitRepo` and `github = new FakeGitHub()`.
    - Create PR 1 via `github.createPr` and `github.movePrHead(1, 'h1')`. The task is `review` with `prNumber 1`, `headSha 'h1'` and `ci 'pending'`.
  - Tests:
    - `refresh records green CI and announces it`: `setChecks('h1', [success])` → `ci 'success'` and the message `'CI passed. Ready to merge.'`.
    - `refresh names failed checks`: `[{ name: 'test', status: 'completed', conclusion: 'failure' }]` → an error message `'CI failed: test'`.
    - `refresh detects a PR merged on GitHub`: `markMerged(1)` → `status 'merged'`, `mergeSha 'merged-1'`, and `onMerged` is called.
    - `refresh detects a closed PR`.
    - `merge refuses while CI is pending`: `BuildError` 409 with a message containing `'pending'`, and `github.merges` is empty.
    - `merge refuses with no checks`: the message contains `'not reporting any checks'`.
    - `merge pins the PR head sha`:
      - With `h1` green → `merges[0]` toEqual `{ number: 1, sha: 'h1' }`.
      - The task is `merged` with `mergeSha 'merged-1'`.
      - `onMerged` is called with `{ app: 'demo', taskId, prNumber: 1, sha: 'merged-1' }`.
    - `merge rechecks CI on the current head`: `h1` is green, but `movePrHead(1, 'h2')` with `h2` pending → 409, no merge, and the task's `headSha` is `'h2'`.
    - `merge refuses while Claude is running`: 409.
    - `unknown task or wrong app is 404`.
    - `pollCi skips running apps`: `isRunning = () => true` → `github.calls` is empty.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/build/ci.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `ci.ts`.
- [ ] **Step 4: Run** the same command. Expected: 11 pass.
- [ ] **Step 5: Commit** `apps/server/src/build/ci.*` as `feat(server): CI tracking and green-only merge pinned to the PR head`, with the attribution trailer your harness provides.

---

