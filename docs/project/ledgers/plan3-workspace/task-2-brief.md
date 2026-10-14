### Task 2: Build DTOs and WebSocket messages in `@hub/protocol`

**Files:**
- Create: `packages/protocol/src/api.ts`
- Modify: `packages/protocol/src/ws.ts`, `packages/protocol/src/index.ts` (add `export * from './api.js';`)
- Test: `packages/protocol/src/ws.test.ts`

**Interfaces:**
- Consumes: Task 1 (package layout); plan 2's `RenderReadyMsg`.
- Produces (`api.ts`, exact):

```ts
export type BuildTaskStatus = 'working' | 'verifying' | 'pushing' | 'review' | 'no_changes' | 'failed' | 'queued' | 'merged' | 'closed';
export const OPEN_TASK_STATUSES: readonly BuildTaskStatus[] = ['working', 'verifying', 'pushing', 'review', 'no_changes', 'failed', 'queued'];
export function isOpenTask(status: BuildTaskStatus): boolean;
export type CiState = 'none' | 'pending' | 'success' | 'failure';
export type BuildMessageKind = 'user' | 'assistant' | 'tool' | 'status' | 'error';
export interface BuildMessage { id: number; app: string; taskId: number | null; kind: BuildMessageKind; text: string; at: number }
export interface BuildTask {
  id: number; app: string; title: string; branch: string; base: string; status: BuildTaskStatus;
  prNumber: number | null; prUrl: string | null; headSha: string | null; ci: CiState; mergeSha: string | null;
  error: string | null; retryAt: number | null; createdAt: number; updatedAt: number;
}
export interface BuildState { running: boolean; task: BuildTask | null; messages: BuildMessage[] }
export interface AppSummary { name: string; adopted: boolean; manifestError: string | null; buildStatus: BuildTaskStatus | null; running: boolean }
export interface LoginRequest { passphrase: string }
export interface SendBuildRequest { text: string }
export interface TaskResponse { task: BuildTask }
export interface StopResponse { stopped: boolean }
export interface ApiErrorBody { error: string }
```

- Produces (`ws.ts`, replacing `export type ServerMsg = RenderReadyMsg;`):

```ts
export interface BuildMessageMsg { type: 'build.message'; app: string; message: BuildMessage }
export interface BuildTaskMsg { type: 'build.task'; app: string; task: BuildTask; running: boolean }
export interface PongMsg { type: 'pong'; t: number }
/** Server → client. Plans 4 and 6 add variants here and to SERVER_MSG_TYPES. */
export type ServerMsg = RenderReadyMsg | BuildMessageMsg | BuildTaskMsg | PongMsg;
export const SERVER_MSG_TYPES: readonly ServerMsg['type'][] = ['render.ready', 'build.message', 'build.task', 'pong'];
export interface PingMsg { type: 'ping'; t: number }
export type ClientMsg = PingMsg;
export function parseServerMsg(data: string): ServerMsg | null;  // JSON object whose `type` is in SERVER_MSG_TYPES; never throws
export function parseClientMsg(data: string): ClientMsg | null;  // only { type: 'ping', t: number }; never throws
```

- [ ] **Step 1: Write the failing tests** (`ws.test.ts`):
  - `parses known server messages`: `parseServerMsg('{"type":"pong","t":5}')` toEqual `{ type: 'pong', t: 5 }`.
  - `rejects unknown or malformed data`: `'nope'`, `'{"type":"x"}'`, `'[]'` and `'null'` → `null`.
  - `parseClientMsg accepts ping only`: `'{"type":"ping","t":1}'` → ok. `'{"type":"ping"}'` and `'{"type":"pong","t":1}'` → `null`.
  - `lists every server message type`: `SERVER_MSG_TYPES` toEqual `['render.ready','build.message','build.task','pong']`.
  - `open task statuses`: `isOpenTask('review') === true`, and `isOpenTask('merged')` and `isOpenTask('closed')` are false.
- [ ] **Step 2: Run** `pnpm -F @hub/protocol exec vitest run src/ws.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `api.ts` and the `ws.ts` additions. Use `import type` for DTOs in `ws.ts`.
- [ ] **Step 4: Run** `pnpm -F @hub/protocol test && pnpm -F @hub/protocol typecheck`. Expected: pass.
- [ ] **Step 5: Commit** `packages/protocol/src` as `feat(protocol): build DTOs, server/client WebSocket messages`, with the attribution trailer your harness provides.

---

