### Task 23: Client routing and Build view state

**Files:**
- Create: `apps/client/src/shell/route.ts`, `apps/client/src/areas/build/state.ts`
- Test: `apps/client/src/shell/route.test.ts`, `apps/client/src/areas/build/state.test.ts`

**Interfaces:**
- Consumes: Task 2 (DTOs, `ServerMsg`).
- Produces:

```ts
// route.ts
export type Area = 'design' | 'build' | 'deploy';
export const AREAS: readonly Area[] = ['design', 'build', 'deploy'];
export const AREA_LABEL: Readonly<Record<Area, string>> = { design: 'Design', build: 'Build', deploy: 'Deploy' };
export type Route = { name: 'apps' } | { name: 'app'; app: string; area: Area };
export function parseHash(hash: string): Route;
// '' | '#' | '#/' → apps; '#/apps/<enc>' → area 'build'; '#/apps/<enc>/<area>' (unknown area → 'build'); a bad escape or anything else → apps
export function formatRoute(r: Route): string;   // '#/' or `#/apps/${encodeURIComponent(app)}/${area}`
// state.ts
export interface BuildView { loaded: boolean; running: boolean; task: BuildTask | null; messages: BuildMessage[] }
export const EMPTY_VIEW: BuildView;               // { loaded: false, running: false, task: null, messages: [] }
export const MAX_VIEW_MESSAGES = 1000;
export const STATUS_LABEL: Readonly<Record<BuildTaskStatus, string>>;
export function applyState(v: BuildView, s: BuildState): BuildView;
export function applyServerMsg(v: BuildView, app: string, m: ServerMsg): BuildView;   // returns v itself when m is irrelevant
export function lastMessageId(v: BuildView): number;   // 0 when empty
export interface TaskSummary { label: string; tone: 'busy' | 'ok' | 'warn' | 'error' | 'done'; canMerge: boolean; mergeHint: string | null }
export function summarizeTask(t: BuildTask, running: boolean): TaskSummary;
```

`STATUS_LABEL` (exact): `{ working: 'Claude is working', verifying: 'Running checks', pushing: 'Pushing', review: 'Pull request open', no_changes: 'No changes', failed: 'Failed', queued: 'Queued (usage limit)', merged: 'Merged', closed: 'Closed' }`.

Merging rules:
- Messages merge by id: dedupe, ascending order, and keep only the newest `MAX_VIEW_MESSAGES`.
- A task replaces the current one when there is none, when its id is greater, or when the id is the same and `updatedAt >=` the current one's.
- `applyState` sets `running` and `loaded: true`. `build.task` sets `running` from the message.

`summarizeTask` labels:
- For `review` the label depends on CI: success → `'Ready to merge'`, pending → `'Waiting for CI'`, failure → `'CI failed'`, none → `'No CI checks'`.
- Every other status uses `STATUS_LABEL`.

`summarizeTask` tones:
- `busy` for working, verifying and pushing.
- `ok` for review + success.
- `warn` for review + pending or none, and for queued.
- `error` for review + failure and for failed.
- `done` for no_changes, merged and closed.

`canMerge = status === 'review' && ci === 'success' && !running`. `mergeHint` (exact), checked in this order:
1. `canMerge` → `null`.
2. running → `'Wait for Claude to finish.'`.
3. review + pending → `'Merge unlocks when CI is green.'`.
4. review + failure → `'Fix CI before merging.'`.
5. review + none → `'This repo reports no CI checks, so the Hub cannot merge it.'`.
6. Anything else → `null`.

- [ ] **Step 1: Write the failing tests.**
  - `route.test.ts`:
    - Round trips: `formatRoute({ name: 'app', app: 'my app', area: 'design' })` === `'#/apps/my%20app/design'`, and it parses back.
    - `'#/apps/x'` → area `'build'`.
    - `'#/apps/x/bogus'` → area `'build'`.
    - `'#/apps/%E0%A4%A'` → apps.
    - `'#/whatever'` → apps.
  - `state.test.ts`:
    - `applyState dedupes messages already shown`: a view with ids [1, 2] plus a state with [2, 3] → ids [1, 2, 3].
    - `out-of-order messages are sorted`: a `build.message` with id 3, then id 2 → [2, 3].
    - `other apps are ignored`: the same reference is returned.
    - `an older task update is ignored, and a newer task id replaces it`.
    - `build.task sets running`.
    - `keeps the newest 1000 messages`.
    - `lastMessageId`: empty → 0.
    - `summarizeTask table`:
      - review/success/not running → `{ label: 'Ready to merge', tone: 'ok', canMerge: true, mergeHint: null }`.
      - review/pending → `canMerge false` with hint `'Merge unlocks when CI is green.'`.
      - review/success/running → hint `'Wait for Claude to finish.'`.
      - queued → label `'Queued (usage limit)'`, tone `'warn'`.
      - merged → tone `'done'`.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/shell src/areas`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command. Expected: 13 pass.
- [ ] **Step 5: Commit** `apps/client/src/shell/route.* apps/client/src/areas/build/state.*` as `feat(client): hash routes and Build view state`, with the attribution trailer your harness provides.

---

