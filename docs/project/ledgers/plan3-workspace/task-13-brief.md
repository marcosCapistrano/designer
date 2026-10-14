### Task 13: Build store

**Files:**
- Create: `apps/server/src/build/store.ts`
- Test: `apps/server/src/build/store.test.ts`

**Interfaces:**
- Consumes: Task 2 (`BuildTask`, `BuildMessage`, `BuildMessageKind`, `BuildTaskStatus`, `OPEN_TASK_STATUSES`), Task 4 (`Db`, `openDb`).
- Produces:

```ts
export type TaskPatch = Partial<Pick<BuildTask, 'title' | 'branch' | 'status' | 'prNumber' | 'prUrl' | 'headSha' | 'ci' | 'mergeSha' | 'error' | 'retryAt'>> & { pendingPrompt?: string | null };
export class BuildStore {
  constructor(db: Db, now?: () => number);
  chatSession(app: string): string | null;
  setChatSession(app: string, sessionId: string | null): void;           // upsert into build_chats
  createTask(t: { app: string; title: string; branch: string; base: string }): BuildTask;   // status 'working', ci 'none', nulls elsewhere
  task(id: number): BuildTask | null;
  updateTask(id: number, patch: TaskPatch): BuildTask;                   // only the given keys; always bumps updatedAt
  openTask(app: string): BuildTask | null;                                // newest task of app with status in OPEN_TASK_STATUSES
  latestTask(app: string): BuildTask | null;
  tasksWithStatus(statuses: readonly BuildTaskStatus[]): BuildTask[];     // ascending id
  pendingPrompt(taskId: number): string | null;
  addMessage(m: { app: string; taskId: number | null; kind: BuildMessageKind; text: string }): BuildMessage;
  messages(app: string, afterId?: number, limit?: number /* 500 */): BuildMessage[];
  // ascending id; with afterId: id > afterId, first `limit`; without: the newest `limit`
  userPrompts(taskId: number): string[];                                  // 'user' messages of the task, ascending
}
```

Rows map from snake_case columns to the camelCase DTO fields.

- [ ] **Step 1: Write the failing tests** (`openDb(':memory:')`, with `now` returning a variable `t`):
  - `creates a task in working state`: `createTask({ app: 'demo', title: 'T', branch: 'build/t-1', base: 'main' })` toEqual a `BuildTask` with `id 1`, `status 'working'`, `ci 'none'`, every nullable field `null`, and `createdAt === updatedAt === t`.
  - `openTask returns the newest open task`: t1 merged, t2 working → t2. Then t2 closed → `null`.
  - `updateTask patches only the given fields`: `{ status: 'review', prNumber: 3 }` keeps `title`, and `updatedAt` advances with `t`.
  - `chat session round-trips`: `null` → `'abc'` → `null`.
  - `messages are ordered and paged by app`: 3 messages for `demo` and 1 for `other`. `messages('demo')` ids are ascending with length 3. `messages('demo', firstId)` has length 2.
  - `default page is the newest 500`: after 502 adds, `messages('demo')` has length 500 and the first id is 3.
  - `userPrompts lists the task's user messages`.
  - `pending prompt round-trips through updateTask`.
  - `tasksWithStatus and latestTask`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/build/store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `store.ts`.
- [ ] **Step 4: Run** the same command. Expected: 9 pass.
- [ ] **Step 5: Commit** `apps/server/src/build/store.ts apps/server/src/build/store.test.ts` as `feat(server): build store for tasks, chat session and messages`, with the attribution trailer your harness provides.

---

