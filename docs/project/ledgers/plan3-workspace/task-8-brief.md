### Task 8: WebSocket hub

**Files:**
- Create: `apps/server/src/ws/hub.ts`, `apps/server/src/ws/attach.ts`
- Test: `apps/server/src/ws/ws.test.ts`

**Interfaces:**
- Consumes: Task 2 (`ServerMsg`, `parseClientMsg`), Task 3, Task 6 (`readCookie`, tests only).
- Produces:

```ts
// hub.ts
export interface WsHub { broadcast(msg: ServerMsg): void }
export interface SocketLike { readonly readyState: number; send(data: string): void; ping(): void; terminate(): void }
export class SocketHub implements WsHub {
  add(s: SocketLike): void;            // new sockets start "alive"
  remove(s: SocketLike): void;
  size(): number;
  broadcast(msg: ServerMsg): void;     // JSON.stringify once; send to readyState === 1 only; a throwing send is ignored
  markAlive(s: SocketLike): void;      // called on 'pong'
  sweep(): void;                       // terminate+remove sockets not alive; ping the rest; mark all not alive
  handleMessage(s: SocketLike, data: string): void;   // parseClientMsg ping → s.send(JSON pong with same t); else ignore
}
// attach.ts
export const WS_PATH = '/ws';
export const HEARTBEAT_MS = 30_000;
export function attachWebSocket(server: import('node:http').Server, hub: SocketHub,
  opts: { isAuthed: (cookieHeader: string | undefined) => boolean; heartbeatMs?: number }): { wss: WebSocketServer; close(): void };
```

`attachWebSocket` creates `new WebSocketServer({ noServer: true })` and handles `server.on('upgrade', (req, socket, head) => …)`:
- If the path (`new URL(req.url ?? '/', 'http://hub').pathname`) is not `/ws`, write `'HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'` and destroy the socket.
- If `!opts.isAuthed(req.headers.cookie)`, write `'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'` and destroy it.
- Otherwise call `wss.handleUpgrade` and then:
  - `hub.add(ws)`
  - `ws.on('pong', () => hub.markAlive(ws))`
  - `ws.on('message', d => hub.handleMessage(ws, d.toString()))`
  - `ws.on('close', () => hub.remove(ws))`

A `setInterval(() => hub.sweep(), heartbeatMs).unref()` runs the heartbeat. `close()` clears the interval, terminates every client, and calls `wss.close()`.

- [ ] **Step 1: Write the failing tests.** Fake socket: `{ readyState: 1, sent: [] as string[], send(d) { this.sent.push(d) }, ping: vi.fn(), terminate: vi.fn() }`.
  - `broadcast sends JSON to open sockets only`: with an open and a closed (`readyState: 3`) socket, only the open one receives `JSON.stringify({ type: 'pong', t: 1 })`.
  - `a throwing socket does not stop the broadcast`.
  - `sweep terminates silent sockets and pings the rest`: `add(a)`, `add(b)`, `sweep()` → both pinged. Then `markAlive(a)` and `sweep()` → `b.terminate` called once, `a.ping` called twice, and `size() === 1`.
  - `ping gets a pong`: `handleMessage(s, '{"type":"ping","t":7}')` → `s.sent` toEqual `['{"type":"pong","t":7}']`. `handleMessage(s, 'garbage')` sends nothing.
  - Integration tests use `http.createServer((_q, r) => r.end())` and `attachWebSocket(server, hub, { isAuthed: h => readCookie(h, 'hub_session') === 'good' })`, listening on port 0 at `127.0.0.1`, with the `ws` client:
    - `rejects connections without a session`: `'unexpected-response'` with `res.statusCode === 401`.
    - `authed client receives broadcasts`: `new WebSocket(url, { headers: { cookie: 'hub_session=good' } })`; on open, `hub.broadcast({ type: 'pong', t: 1 })`. The client receives that JSON.
    - `other paths are refused`: `/nope` → `'unexpected-response'` with 404.
    - `closed sockets leave the hub`: `client.close()` → `expect.poll(() => hub.size()).toBe(0)`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/ws`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command. Expected: 8 pass.
- [ ] **Step 5: Commit** `apps/server/src/ws` as `feat(server): WebSocket hub with cookie auth and heartbeat`, with the attribution trailer your harness provides.

---

