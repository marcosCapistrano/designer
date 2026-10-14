### Task 18: BuildService

**Files:**
- Create: `apps/server/src/build/service.ts`
- Test: `apps/server/src/build/service.test.ts`

**Interfaces:**
- Consumes: Tasks 15, 16, 17 (`runTurn`, `queueAfterLimit`, `finishTask`, `refreshCi`, `pollCi`, `mergeTask`, `BuildError`), Task 14 (`branchSlug`, `prTitle`), Task 2 (`isOpenTask`, `BuildState`), Task 11 (tests), Task 12 (tests).
- Produces:

```ts
export const MAX_MESSAGE_CHARS = 20_000;
export class BuildService {
  constructor(deps: BuildDeps);
  isRunning(app: string): boolean;
  latestStatus(app: string): BuildTaskStatus | null;
  state(app: string, after?: number): Promise<BuildState>;   // { running, task: latestTask, messages: store.messages(app, after) }; 404 for unknown app
  send(app: string, text: string): Promise<BuildTask>;        // resolves after git prep, while Claude runs in the background
  stop(app: string): boolean;
  close(app: string, taskId: number): Promise<BuildTask>;
  merge(app: string, taskId: number): Promise<BuildTask>;     // mergeTask(deps, app, id, isRunning(app))
  idle(app: string): Promise<void>;                            // resolves when the app's background work ends (tests, shutdown)
  stopAll(): Promise<void>;                                    // abort every run and await idle
  recover(): number;
  retryQueued(): Promise<number>;
  pollCi(): Promise<void>;                                     // pollCi(deps, a => this.isRunning(a))
}
```

`send(app, text)`:
1. `t = text.trim()`. Empty → `BuildError('Message is empty.', 400)`. Longer than `MAX_MESSAGE_CHARS` → 400 `'Message is longer than 20000 characters.'`.
2. `entry = registry.get(app)`. Missing → 404 `'Unknown app'`.
3. `isRunning(app)` → 409 `'Claude is already working on this app. Wait or tap Stop.'`.
4. Reserve `running.set(app, new AbortController())` before the first `await`, so two sends can't race. Release it on any error in steps 5–6.
5. Find the task: `task = store.openTask(app)`. If it is `review`, `task = await refreshCi(...)`. If it is no longer open, `task = null`.
6. Prepare git with `repo = openRepo(entry.dir)`:
   - **Task exists:** if `currentBranch() !== task.branch`, `checkout(task.branch)`.
   - **No task:** if `isDirty()` → 409 `` `The checkout has uncommitted changes on ${branch}. Commit or discard them first.` ``. Otherwise:
     1. `fetch()` and `base = defaultBranch()`.
     2. `task = store.createTask({ app, title: prTitle(t), branch: '', base })` and `branch = `build/${branchSlug(t, task.id)}``.
     3. `updateTask(task.id, { branch })` and `createBranchFrom(branch, base)`.
   - A git error → if a task was created, mark it `failed` with the message. Throw 409 `` `Git: ${msg}` ``.
7. Add a `user` message `t` and `publishTask(task, true)`.
8. Start `work(...)` without awaiting it, store the promise for `idle`, and return `store.task(id)`.

`work(app, entry, task, prompt, controller)`:
1. Update `{ status: 'working', error: null, retryAt: null, pendingPrompt: null }` and publish.
2. `r = runTurn(...)`:
   - `r.limited` → `queueAfterLimit`.
   - `!r.ok` → `failed`, with error `r.error === 'aborted' ? 'Stopped by you.' : r.error`, plus an `error` message.
   - Otherwise → `finishTask(deps, { task: store.task(id)!, dir: entry.dir, manifest: entry.manifest, signal })`.
3. An unexpected throw → `failed` with `` `Unexpected error: ${msg}` ``.
4. `finally`: delete the running and inflight entries, and `publishTask(store.task(id)!, false)`.

Other methods:
- `stop(app)` aborts the app's controller and returns whether one existed.
- `close(app, id)`:
  1. A missing task or wrong app → 404 `'Task not found'`. A running app → 409 `'Claude is still working on this app.'`.
  2. `merged` or `closed` → return it as is.
  3. Otherwise set `closed` with `error: null`, add a status message `'Task closed. The next message starts a new branch.'` and publish.
- `recover()`: every task in `working`, `verifying` or `pushing` becomes `failed` with error `'Interrupted because the Hub restarted. Send a message to continue.'`, plus an `error` message. Returns the count.
- `retryQueued()`:
  1. For each `queued` task with `retryAt <= now()` whose app is not running and still exists:
     - Reserve the app.
     - Add a status message `'Retrying after the usage limit.'`.
     - Check out the task's branch.
     - Start `work` with `store.pendingPrompt(id) ?? 'Continue where you left off.'`.
  2. Return the number started.

- [ ] **Step 1: Write the failing tests.**
  - Setup:
    - `{ origin, work } = makeTestRepo({ files: { '.hub/app.json': JSON.stringify(manifestFor('demo')) } })`, where `manifestFor(name)` is Task 1's `SPEC_EXAMPLE` with `name`. `entry = { name: 'demo', dir: work, adopted: true, manifest, manifestError: null }`.
    - `registry = { get: async n => n === 'demo' ? entry : null }`, `openRepo = d => openRepo(d, { identity: TEST_IDENTITY })`, `github = new FakeGitHub()`.
    - `runCommand` is a fake that is always ok. `now` returns a variable `t`. `write = (name: string) => (o: RunOptions) => { writeFileSync(join(o.cwd, name), 'x') }`.
  - Tests:
    - `a prompt runs Claude on a new build branch and opens a PR`:
      - Script `[write('notes.md'), text 'Done.', done ok 's1']`.
      - `send('demo', 'Add a notes file')` resolves to `{ status: 'working', branch: 'build/add-a-notes-file-1' }`.
      - After `idle('demo')`: the task is `review` with `prNumber 1`, and the message kinds include `user`, `assistant` and `status`.
      - `runner.calls[0].cwd === work`, `git(work, 'branch', '--show-current') === 'build/add-a-notes-file-1'`, and origin's `main` SHA is unchanged.
    - `a second prompt continues the open task`: the same task id, `runner.calls[1].resume === 's1'`, and `github.prs.size === 1`.
    - `a concurrent prompt is refused`: the first script waits on a deferred promise. The second `send` rejects with `BuildError` status 409.
    - `a dirty checkout blocks a new task`: write `stray.txt` first → 409 with a message containing `'uncommitted changes'`.
    - `stop aborts the run`: the script step `o => new Promise<void>(r => o.signal!.addEventListener('abort', () => r()))` → `stop('demo') === true`. After `idle`, the task is `failed` with error `'Stopped by you.'`.
    - `usage limit queues the task and retryQueued resumes it`:
      - Scripts `[[done ok:false error 'usage_limit:5000' sessionId '']]` then `[[write('a.txt'), done ok 's2']]`, with `t = 1000`.
      - After `idle`, the task is `queued` with `retryAt 5000`.
      - `retryQueued()` at `t = 4000` → 0. At `t = 6000` → 1. After `idle`, the task is `review` and `runner.calls[1].prompt === 'Add a notes file'`.
    - `recover marks interrupted tasks failed`: a task set to `verifying` through the store → a new service's `recover() === 1`, and the error contains `'Hub restarted'`.
    - `a merged PR starts a new task on the next prompt`: after the first task reaches `review`, `github.markMerged(1)`. The next `send` creates task 2 on `build/…-2`, and the runner's `resume` is still `'s1'`.
    - `close ends the task so the next prompt starts a new branch`.
    - `rejects empty messages and unknown apps`: 400 and 404.
    - `state returns messages after an id`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/build/service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `service.ts`.
- [ ] **Step 4: Run** `pnpm -F @hub/server test`. Expected: all server tests pass.
- [ ] **Step 5: Commit** `apps/server/src/build/service.*` as `feat(server): BuildService with one chat per app, stop, queue and recovery`, with the attribution trailer your harness provides.

---

