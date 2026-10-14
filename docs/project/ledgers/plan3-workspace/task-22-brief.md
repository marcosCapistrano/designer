### Task 22: Client network layer (API, WebSocket, server tile source)

**Files:**
- Create: `apps/client/src/net/api.ts`, `apps/client/src/net/ws.ts`, `apps/client/src/net/tile-source.ts`
- Test: `apps/client/src/net/api.test.ts`, `apps/client/src/net/ws.test.ts`, `apps/client/src/net/tile-source.test.ts`

**Interfaces:**
- Consumes: Task 2 (DTOs, `ServerMsg`, `parseServerMsg`); plan 2 Task 16 (`TileSource`, `StaticTileSource` from `../canvas/source.js`).
- Produces:

```ts
// api.ts
export class ApiError extends Error { constructor(readonly status: number, message: string) }
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export class ApiClient {
  constructor(opts?: { fetchFn?: FetchFn; onUnauthorized?: () => void });
  login(passphrase: string): Promise<void>;
  logout(): Promise<void>;
  session(): Promise<boolean>;                 // 200 → true, 401 → false, other → ApiError; network errors propagate
  apps(): Promise<AppSummary[]>;
  buildState(app: string, after?: number): Promise<BuildState>;
  sendBuild(app: string, text: string): Promise<BuildTask>;
  stopBuild(app: string): Promise<boolean>;
  merge(app: string, taskId: number): Promise<BuildTask>;
  closeTask(app: string, taskId: number): Promise<BuildTask>;
}
// ws.ts
export type WsStatus = 'connecting' | 'open' | 'closed';
export interface SocketLike {
  readyState: number; send(data: string): void; close(): void;
  onopen: ((ev: unknown) => void) | null; onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null; onerror: ((ev: unknown) => void) | null;
}
export interface WsClientOptions { url: string; makeSocket?: (url: string) => SocketLike; now?: () => number; pingMs?: number /* 25_000 */; pongTimeoutMs?: number /* 10_000 */; maxBackoffMs?: number /* 30_000 */ }
export function wsUrl(loc: { protocol: string; host: string }): string;   // 'wss://host/ws' for https:, else 'ws://host/ws'
export class WsClient {
  constructor(opts: WsClientOptions);
  connect(): void;
  close(): void;                                                      // stops reconnecting
  kick(): void;                                                       // open → ping now; otherwise reconnect now with backoff reset
  on(listener: (msg: ServerMsg) => void): () => void;                 // pong is not forwarded
  onStatus(listener: (s: WsStatus) => void): () => void;
  get status(): WsStatus;
}
// tile-source.ts
export function renderBase(app: string): string;   // `/api/apps/${encodeURIComponent(app)}/render`
export class ServerTileSource implements TileSource {
  constructor(app: string, ws: Pick<WsClient, 'on'>, fetchFn?: (url: string) => Promise<Response>);
  // manifest/tile/hitMap delegate to new StaticTileSource(renderBase(app), fetchFn); subscribe → render.ready for this app only
}
```

`ApiClient` behavior:
- Same-origin paths under `/api` with `credentials: 'same-origin'`. Bodies are JSON with `content-type: application/json`. App names go through `encodeURIComponent`.
- A non-OK response throws `ApiError(status, body.error ?? `HTTP ${status}`)`.
- A 401 from any call except `login` and `session` first calls `onUnauthorized`.

`WsClient` behavior:
- The default `makeSocket` is `u => new WebSocket(u) as unknown as SocketLike`. Timers use the global `setTimeout`/`setInterval`.
- On open: status `open`, reset `attempt = 0`, and start the ping interval.
- Each ping sends `JSON.stringify({ type: 'ping', t: now() })` and arms a pong timer. If no `pong` arrives within `pongTimeoutMs`, call `socket.close()`.
- On close: clear the timers and set status `closed`. Unless `close()` was called, reconnect after `min(maxBackoffMs, 1000 * 2 ** attempt)`, then `attempt++`.
- Messages go through `parseServerMsg`, and invalid ones are dropped.

- [ ] **Step 1: Write the failing tests.**
  - `api.test.ts` uses a fake fetch that records `[url, init]`:
    - `login posts the passphrase`: `'/api/login'`, `POST`, body `'{"passphrase":"p"}'`, `content-type application/json`.
    - `wrong passphrase throws the server message`: 401 `{ error: 'Wrong passphrase' }` → `ApiError` with status 401 and message `'Wrong passphrase'`, and `onUnauthorized` is not called.
    - `401 elsewhere calls onUnauthorized`: `apps()` → called once, and the call rejects.
    - `session is false on 401`.
    - `buildState encodes the app and passes after`: `buildState('my app', 5)` → `'/api/apps/my%20app/build?after=5'`. Without `after` → `'/api/apps/my%20app/build'`.
    - `sendBuild returns the task`: 202 `{ task }` → `task`.
  - `ws.test.ts` uses `vi.useFakeTimers()` and a `FakeSocket` with:
    - `readyState 0`, `sent: string[]`, `open()` (sets `readyState 1` and calls `onopen`), `receive(obj)` (calls `onmessage({ data: JSON.stringify(obj) })`).
    - `close()`, which when not already 3 sets `readyState 3` and calls `onclose`.

    Tests:
    - `wsUrl`: `{ protocol: 'https:', host: 'h' }` → `'wss://h/ws'`. `http:` → `'ws://h/ws'`.
    - `delivers parsed messages`: a `build.task` message reaches the listener. `'garbage'` and a pong do not.
    - `reconnects with backoff`:
      - Close the first socket → at +999 ms there is still 1 socket; at +1 ms there are 2.
      - Close the second → +1999 ms still 2; +1 ms gives 3.
    - `backoff resets after open`.
    - `missing pong forces a reconnect`:
      - After `open()`, advance 25 000 ms → `sent[0]` matches `/"type":"ping"/`.
      - Advance 10 000 ms → that socket has `readyState 3` and the status is `'closed'`.
      - Advance 1000 ms → there are 2 sockets.
    - `a pong keeps the connection`.
    - `kick reconnects immediately when closed`.
    - `close stops reconnecting`: after `close()`, advancing 60 000 ms leaves 1 socket.
    - `status transitions`: `['connecting', 'open', 'closed', 'connecting']`.
  - `tile-source.test.ts`:
    - `fetches under the app's render path`: `manifest()` → `'/api/apps/demo/render/manifest.json'`. `tile('k', 1, 2)` → `'/api/apps/demo/render/tiles/k/1_2.webp'`.
    - `subscribe gets render.ready for this app only`: a fake `ws.on` captures the listener. A `render.ready` for `other` is ignored, the one for `demo` calls back with its manifest, and unsubscribe stops further calls.
- [ ] **Step 2: Run** `pnpm -F @hub/client exec vitest run src/net`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** the same command. Expected: 17 pass. `pnpm -F @hub/client typecheck` is clean.
- [ ] **Step 5: Commit** `apps/client/src/net` as `feat(client): typed API client, reconnecting WebSocket, server tile source`, with the attribution trailer your harness provides.

---

