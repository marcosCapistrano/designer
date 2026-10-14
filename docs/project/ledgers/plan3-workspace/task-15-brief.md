### Task 15: Build dependencies and one Claude turn

**Files:**
- Create: `apps/server/src/build/deps.ts`, `apps/server/src/build/turn.ts`
- Test: `apps/server/src/build/turn.test.ts`

**Interfaces:**
- Consumes: Task 7 (`AppRegistry`), Task 8 (`WsHub`), Task 9 (`ClaudeRunner`, `FakeClaudeRunner`, `parseUsageLimit`), Task 11 (`GitRepo`, `openRepo`), Task 12 (`GitHub`, `RepoRef`, `parseGitHubRemote`), Task 13 (`BuildStore`), Task 14 (`RunCommand`, `summarizeTool`, `buildSystemPrompt`).
- Produces:

```ts
// deps.ts
export interface BuildDeps {
  store: BuildStore;
  runner: ClaudeRunner;
  hub: WsHub;
  registry: Pick<AppRegistry, 'get'>;
  openRepo: (dir: string) => GitRepo;
  github: GitHub | null;
  runCommand: RunCommand;
  now: () => number;
  onMerged?: (e: { app: string; taskId: number; prNumber: number; sha: string }) => void;   // plan 4: staging deploy
}
export function addBuildMessage(deps: BuildDeps, app: string, taskId: number | null, kind: BuildMessageKind, text: string): BuildMessage;
// store.addMessage, then hub.broadcast({ type: 'build.message', app, message })
export function publishTask(deps: BuildDeps, task: BuildTask, running: boolean): void;
// hub.broadcast({ type: 'build.task', app: task.app, task, running })
export function repoRefFor(deps: BuildDeps, dir: string): Promise<RepoRef | null>;
// parseGitHubRemote((await deps.openRepo(dir).remoteUrl()) ?? '')
// turn.ts
export interface TurnInput { app: string; taskId: number; cwd: string; branch: string; prompt: string; signal: AbortSignal }
export interface TurnResult { ok: boolean; error: string | null; limited: boolean; resetsAtMs: number | null }
export const USAGE_RETRY_FALLBACK_MS = 900_000;
export function runTurn(deps: BuildDeps, input: TurnInput): Promise<TurnResult>;
export function queueAfterLimit(deps: BuildDeps, task: BuildTask, prompt: string, result: TurnResult): BuildTask;
```

`runTurn`:
1. Set `resume = store.chatSession(app) ?? undefined`. Play `runner.run({ cwd, prompt, resume, systemPrompt: buildSystemPrompt(branch), signal })`:
   - `text` → `addBuildMessage(…, 'assistant', e.text)`.
   - `tool` → `addBuildMessage(…, 'tool', summarizeTool(e.name, e.input, cwd))`.
   - Count those events and keep the `done`. A missing `done` counts as `{ ok: false, sessionId: '', error: 'Claude Code ended without a result' }`.
2. Retry once without resume when all of these hold: `!done.ok`, `resume` was set, 0 events, `parseUsageLimit(done.error) === null`, and `done.error !== 'aborted'`. Before the retry, `setChatSession(app, null)` and add a `status` message `'Could not resume the previous Claude session; starting a new one.'`. Then play once more with no resume.
3. If `done.sessionId` is non-empty, `setChatSession(app, done.sessionId)`.
4. Return:
   - limited: `{ ok: false, error: done.error, limited: true, resetsAtMs }`
   - ok: `{ ok: true, error: null, limited: false, resetsAtMs: null }`
   - otherwise: `{ ok: false, error: done.error ?? 'Claude Code failed', limited: false, resetsAtMs: null }`

`queueAfterLimit` updates the task to `{ status: 'queued', retryAt, pendingPrompt: prompt, error: null }`, where `retryAt = result.resetsAtMs ?? deps.now() + USAGE_RETRY_FALLBACK_MS`. It adds a `status` message `` `Claude usage limit reached. The Hub will retry at ${new Date(retryAt).toISOString().slice(11, 16)} UTC.` ``, calls `publishTask(task, false)`, and returns the task.

- [ ] **Step 1: Write the failing tests.**
  - Deps: a real `BuildStore(openDb(':memory:'), () => t)`, `hub = { sent: [] as ServerMsg[], broadcast(m) { this.sent.push(m) } }`, `FakeClaudeRunner`, and stubs for the rest (`registry: { get: async () => null }`, `github: null`, `runCommand: async () => …`, `openRepo: () => { throw new Error('unused') }`).
  - A task created with `store.createTask(...)` gives `taskId`. `input = { app: 'demo', taskId, cwd: '/r', branch: 'build/x-1', prompt: 'p', signal: new AbortController().signal }`.

  Tests:
  - `streams text and tools as messages`: script `[text 'Looking', tool Edit { file_path: '/r/a.ts' }, done ok 's1']` → `store.messages('demo').map(m => [m.kind, m.text])` toEqual `[['assistant', 'Looking'], ['tool', 'Edit a.ts']]`. `hub.sent` has 2 `build.message` entries, the result is `{ ok: true, error: null, limited: false, resetsAtMs: null }`, and `chatSession('demo') === 's1'`.
  - `resumes the chat session`: with `setChatSession('demo', 's0')` → `runner.calls[0].resume === 's0'`, and `systemPrompt` contains `build/x-1`.
  - `stale session falls back to a fresh one`:
    - Scripts `[[done ok:false error 'No conversation found' sessionId '']]` then `[[text 'Hi', done ok 's2']]`, with chat `'old'`.
    - Then `calls[0].resume === 'old'`, `calls[1].resume === undefined`, and a status message contains `'starting a new one'`.
    - Finally `chatSession === 's2'` and `ok === true`.
  - `does not retry after real work`: `[text 'x', done ok:false error 'boom']` with resume → `calls.length === 1` and the result is `{ ok: false, error: 'boom', … }`.
  - `usage limit is reported, not retried`: `[done ok:false error 'usage_limit:1760000000000' sessionId '']` with resume → `{ ok: false, limited: true, resetsAtMs: 1760000000000 }` and `calls.length === 1`.
  - `queueAfterLimit queues with the reset time`: status `'queued'`, `retryAt 1760000000000`, `store.pendingPrompt(id) === 'p'`, and the last message contains `'retry at'`. With `resetsAtMs: null` and `t = 1000`, `retryAt === 901000`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/build/turn.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `deps.ts` and `turn.ts`.
- [ ] **Step 4: Run** the same command. Expected: 6 pass.
- [ ] **Step 5: Commit** `apps/server/src/build/deps.ts apps/server/src/build/turn.*` as `feat(server): one Claude turn with streaming, resume fallback and usage-limit queueing`, with the attribution trailer your harness provides.

---

