### Task 16: Finish a task (commit, verify and fix, push, PR)

**Files:**
- Create: `apps/server/src/build/finish.ts`
- Test: `apps/server/src/build/finish.test.ts`

**Interfaces:**
- Consumes: Task 15 (`BuildDeps`, `addBuildMessage`, `publishTask`, `repoRefFor`, `runTurn`, `queueAfterLimit`), Task 14 (`resolveBuildCommands`, `prBody`, `fixPrompt`), Task 11 (`makeTestRepo`, `TEST_IDENTITY`, `git`, tests), Task 12 (`FakeGitHub`, tests).
- Produces:

```ts
export const MAX_FIX_ATTEMPTS = 2;
export interface FinishInput { task: BuildTask; dir: string; manifest: AppManifest | null; signal: AbortSignal }
export function finishTask(deps: BuildDeps, input: FinishInput): Promise<BuildTask>;   // returns the final task row
```

Algorithm. Every status change goes through `store.updateTask` and then `publishTask(task, true)`. `fail(msg)` = update `{ status: 'failed', error: msg }`, add an `error` message `msg`, and return the task.
1. `repo = deps.openRepo(dir)`. If `currentBranch() !== task.branch` → `fail(`Claude switched to branch ${current}; the work must stay on ${task.branch}.`)`.
2. If `isDirty()`: `commitAll(task.title)` and add a `status` message `'Committed changes Claude left uncommitted.'`.
3. If `commitsAhead(task.base) === 0` → update to `no_changes`, add a status message `'No code changes, so no pull request.'`, and return.
4. If `task.prNumber` is set and `headSha() === task.headSha` → update to `review`, add a status message `'No new changes.'`, and return.
5. Verify. `commands = resolveBuildCommands(dir, manifest)`, `attempt = 0`.
   - If `commands` is empty, add the status message `'No typecheck or test commands found; skipped checks.'`
   - Loop: update to `verifying`. For each command:
     - Add a status message `` `Running ${c.name}: ${c.cmd}` `` and run `r = runCommand(c.cmd, { cwd: dir, signal })`.
     - `r.aborted` → `fail('Stopped by you.')`.
     - `!r.ok` and `attempt === MAX_FIX_ATTEMPTS`:
       - Add an `error` message with `r.output.slice(-1500)`.
       - Then `fail(`${c.name} still fails after ${MAX_FIX_ATTEMPTS} fix attempts.`)`.
     - `!r.ok` otherwise:
       1. Increment `attempt` and add a status message `` `${c.name} failed; asking Claude to fix it (attempt ${attempt} of ${MAX_FIX_ATTEMPTS}).` ``.
       2. Update to `working` and run `turn = runTurn(deps, { app, taskId, cwd: dir, branch, prompt: fixPrompt(c, r), signal })`.
       3. If `turn.limited` → `return queueAfterLimit(deps, task, fixPrompt(c, r), turn)`.
       4. If `!turn.ok` → `fail(turn.error === 'aborted' ? 'Stopped by you.' : turn.error!)`.
       5. Commit any leftovers as in step 2, then restart the loop from the first command.
   - The loop ends when every command passes.
6. Push. Update to `pushing` and run `push(task.branch)`. A throw → `fail(`git push failed: ${msg}`)`. Then add a status message `` `Pushed ${task.branch}.` ``.
7. Pull request:
   - `!deps.github` → `fail('GITHUB_TOKEN is not set: the branch was pushed but no pull request was opened.')`.
   - `ref = repoRefFor(deps, dir)`; `null` → `fail('origin is not a GitHub repository.')`.
   - `existing = findOpenPr(ref, branch)`.
   - If there is none, `createPr(ref, { head: branch, base: task.base, title: task.title, body: prBody(store.userPrompts(task.id)) })`. A throw → `fail(`Could not open the pull request: ${msg}`)`.
   - Update `{ status: 'review', prNumber, prUrl, headSha: await repo.headSha(), ci: 'pending', error: null }`.
   - Add a status message: `` `Updated pull request #${n}.` `` when it existed, else `` `Opened pull request #${n}.` ``.
   - Return.

- [ ] **Step 1: Write the failing tests.**
  - Setup:
    - `{ work } = makeTestRepo()`, then in `work`: `git checkout -b build/notes-1`.
    - `task = store.createTask({ app: 'demo', title: 'Add notes', branch: 'build/notes-1', base: 'main' })` and `store.addMessage({ app: 'demo', taskId: task.id, kind: 'user', text: 'add notes' })`.
    - `openRepo: d => openRepo(d, { identity: TEST_IDENTITY })`, `github = new FakeGitHub()`, `manifest.build = { install: 'i', typecheck: 'tc', test: 'pnpm test' }`.
    - `runCommand` is a fake keyed by `cmd` that returns `{ ok: true, code: 0, output: '', timedOut: false, aborted: false }` unless a test overrides it.
  - Tests:
    - `pushes and opens a PR when checks pass`:
      - Write `notes.md` (uncommitted), then `finishTask` → `status 'review'`, `prNumber 1`, `ci 'pending'`.
      - `github.prs.get(1)` has `headRef 'build/notes-1'` and a body containing `'1. add notes'`.
      - `git(origin, 'rev-parse', 'refs/heads/build/notes-1')` equals `headSha`.
      - The messages include `'Committed changes Claude left uncommitted.'` and `'Opened pull request #1.'`.
    - `no commits means no PR`: → `'no_changes'` and `github.calls` is empty.
    - `failing test is fixed by Claude, then passes`:
      - `pnpm test` fails the first time with code 1. The runner script `[o => writeFileSync(join(o.cwd, 'fix.txt'), 'x'), done ok 's']`.
      - `runner.calls[0].prompt` contains `'exit code 1'` and `` '`pnpm test`' ``. The final status is `'review'`.
    - `gives up after two fix attempts`: `pnpm test` always fails → `runner.calls.length === 2`, `status 'failed'`, error `'test still fails after 2 fix attempts.'`.
    - `switching branches fails the task`: `git checkout main` before → `failed`, and the error contains `'switched to branch main'`.
    - `existing PR is updated, not duplicated`: finish, add a commit, finish again → message `'Updated pull request #1.'` and `github.prs.size === 1`.
    - `follow-up without changes keeps the PR as is`: finish twice with no new commit → the second ends `'review'` with `'No new changes.'` and runs no commands.
    - `missing GitHub client fails after pushing`: `github: null` → `failed`, and the error starts with `'GITHUB_TOKEN is not set'`.
    - `usage limit during a fix queues the task`: `pnpm test` fails, and the runner script is `[done ok:false error 'usage_limit:99']` → `status 'queued'`, `retryAt 99`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/build/finish.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `finish.ts`.
- [ ] **Step 4: Run** the same command. Expected: 9 pass.
- [ ] **Step 5: Commit** `apps/server/src/build/finish.*` as `feat(server): finish build tasks with verify/fix loop, push and PR`, with the attribution trailer your harness provides.

---

