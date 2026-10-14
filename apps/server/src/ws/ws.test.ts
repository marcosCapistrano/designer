import { createServer, type Server } from 'node:http';
import { createConnection, type AddressInfo, type Socket } from 'node:net';
import type { ServerMsg } from '@hub/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { readCookie } from '../auth/sessions.js';
import { attachWebSocket, WS_PATH } from './attach.js';
import { SocketHub } from './hub.js';

function fakeSocket(readyState = 1) {
  return {
    readyState,
    sent: [] as string[],
    send(d: string) {
      this.sent.push(d);
    },
    ping: vi.fn(),
    terminate: vi.fn(),
  };
}

const clients: WebSocket[] = [];
const rawSockets: Socket[] = [];
const attachments: Array<ReturnType<typeof attachWebSocket>> = [];
const servers: Server[] = [];
/** Exceptions that reached the process's uncaughtException event during the current test. */
const uncaught: unknown[] = [];
const recordUncaught = (err: unknown): void => {
  uncaught.push(err);
};

beforeEach(() => {
  uncaught.length = 0;
  process.on('uncaughtException', recordUncaught);
});

afterEach(async () => {
  process.off('uncaughtException', recordUncaught);
  vi.useRealTimers();
  for (const client of clients.splice(0)) client.terminate();
  for (const socket of rawSockets.splice(0)) socket.destroy();
  for (const attached of attachments.splice(0)) attached.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

const sessionCookieOk = (h: string | undefined): boolean => readCookie(h, 'hub_session') === 'good';

async function startAttached(
  hub: SocketHub,
  isAuthed = sessionCookieOk,
  heartbeatMs?: number,
): Promise<{ base: string; attached: ReturnType<typeof attachWebSocket> }> {
  const server = createServer((_req, res) => res.end());
  servers.push(server);
  const attached = attachWebSocket(server, hub, { isAuthed, ...(heartbeatMs === undefined ? {} : { heartbeatMs }) });
  attachments.push(attached);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `ws://127.0.0.1:${port}`, attached };
}

async function startServer(hub: SocketHub, isAuthed = sessionCookieOk): Promise<string> {
  return (await startAttached(hub, isAuthed)).base;
}

function portOf(base: string): number {
  return Number(new URL(base).port);
}

function connect(base: string, path: string, cookie?: string, origin?: string): WebSocket {
  const client = new WebSocket(`${base}${path}`, {
    headers: { ...(cookie ? { cookie } : {}), ...(origin === undefined ? {} : { origin }) },
  });
  clients.push(client);
  return client;
}

function opened(client: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
    client.once('error', reject);
  });
}

function nextMessage(client: WebSocket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    client.once('message', (d) => resolve(d.toString()));
    client.once('error', reject);
  });
}

function refusedStatus(client: WebSocket): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    client.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    client.on('open', () => reject(new Error('connection was accepted')));
    client.on('error', reject);
  });
}

/** Writes raw bytes on a plain TCP socket and resolves with the response head once it arrives. */
function rawRequest(port: number, request: string): Promise<{ socket: Socket; response: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    rawSockets.push(socket);
    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end !== -1) resolve({ socket, response: buf.slice(0, end + 4) });
    });
    socket.on('error', reject);
    socket.on('close', () => reject(new Error(`closed before the response head: ${JSON.stringify(buf)}`)));
    socket.write(request);
  });
}

function upgradeRequest(target: string, cookie?: string): string {
  return [
    `GET ${target} HTTP/1.1`,
    'Host: x',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    ...(cookie ? [`Cookie: ${cookie}`] : []),
    '',
    '',
  ].join('\r\n');
}

/** A client-to-server text frame (FIN, opcode 1, masked with a fixed key). Payloads under 126 bytes only. */
function maskedTextFrame(payload: Buffer): Buffer {
  if (payload.length >= 126) throw new Error('maskedTextFrame supports payloads under 126 bytes');
  const key = [0x01, 0x02, 0x03, 0x04];
  const masked = Buffer.from(payload.map((b, i) => b ^ (key[i % 4] ?? 0)));
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length, ...key]), masked]);
}

describe('SocketHub', () => {
  it('broadcast sends JSON to open sockets only', () => {
    const hub = new SocketHub();
    const open = fakeSocket(1);
    const closed = fakeSocket(3);
    hub.add(open);
    hub.add(closed);

    hub.broadcast({ type: 'pong', t: 1 });

    expect(open.sent).toEqual([JSON.stringify({ type: 'pong', t: 1 })]);
    expect(closed.sent).toEqual([]);
  });

  it('a throwing socket does not stop the broadcast', () => {
    const hub = new SocketHub();
    const thrower = {
      readyState: 1,
      send(): void {
        throw new Error('boom');
      },
      ping: vi.fn(),
      terminate: vi.fn(),
    };
    const good = fakeSocket(1);
    hub.add(thrower);
    hub.add(good);

    hub.broadcast({ type: 'pong', t: 2 });

    expect(good.sent).toEqual([JSON.stringify({ type: 'pong', t: 2 })]);
  });

  it('sweep terminates silent sockets and pings the rest', () => {
    const hub = new SocketHub();
    const a = fakeSocket();
    const b = fakeSocket();
    hub.add(a);
    hub.add(b);

    hub.sweep();
    expect(a.ping).toHaveBeenCalledTimes(1);
    expect(b.ping).toHaveBeenCalledTimes(1);

    hub.markAlive(a);
    hub.sweep();

    expect(b.terminate).toHaveBeenCalledTimes(1);
    expect(a.terminate).not.toHaveBeenCalled();
    expect(a.ping).toHaveBeenCalledTimes(2);
    expect(hub.size()).toBe(1);
  });

  it('a socket whose ping throws does not stop the sweep', () => {
    const hub = new SocketHub();
    const thrower = {
      ...fakeSocket(),
      ping(): void {
        throw new Error('boom');
      },
    };
    const good = fakeSocket();
    hub.add(thrower);
    hub.add(good);

    expect(() => hub.sweep()).not.toThrow();
    expect(good.ping).toHaveBeenCalledTimes(1);
  });

  it('a socket whose terminate throws does not stop the sweep', () => {
    const hub = new SocketHub();
    const silent = {
      ...fakeSocket(),
      terminate(): void {
        throw new Error('boom');
      },
    };
    const other = fakeSocket();
    hub.add(silent);
    hub.add(other);
    hub.sweep();
    hub.markAlive(other);

    expect(() => hub.sweep()).not.toThrow();
    expect(other.ping).toHaveBeenCalledTimes(2);
    expect(hub.size()).toBe(1);
  });

  it('ping gets a pong', () => {
    const hub = new SocketHub();
    const s = fakeSocket();

    hub.handleMessage(s, '{"type":"ping","t":7}');
    expect(s.sent).toEqual(['{"type":"pong","t":7}']);

    hub.handleMessage(s, 'garbage');
    expect(s.sent).toEqual(['{"type":"pong","t":7}']);
  });
});

describe('attachWebSocket', () => {
  it('rejects connections without a session', async () => {
    const hub = new SocketHub();
    const base = await startServer(hub);

    const status = await refusedStatus(connect(base, WS_PATH));

    expect(status).toBe(401);
    expect(hub.size()).toBe(0);
  });

  it('authed client receives broadcasts', async () => {
    const hub = new SocketHub();
    const base = await startServer(hub);
    const client = connect(base, WS_PATH, 'hub_session=good');
    const received = nextMessage(client);
    await opened(client);

    const msg: ServerMsg = { type: 'pong', t: 1 };
    hub.broadcast(msg);

    expect(await received).toBe(JSON.stringify({ type: 'pong', t: 1 }));
  });

  it('other paths are refused', async () => {
    const hub = new SocketHub();
    const base = await startServer(hub);

    const status = await refusedStatus(connect(base, '/nope', 'hub_session=good'));

    expect(status).toBe(404);
    expect(hub.size()).toBe(0);
  });

  it('closed sockets leave the hub', async () => {
    const hub = new SocketHub();
    const base = await startServer(hub);
    const client = connect(base, WS_PATH, 'hub_session=good');
    await opened(client);
    await expect.poll(() => hub.size()).toBe(1);

    client.close();

    await expect.poll(() => hub.size()).toBe(0);
  });

  it('refuses a request target that does not parse as a URL, then keeps accepting', async () => {
    const hub = new SocketHub();
    const base = await startServer(hub);

    const { response } = await rawRequest(portOf(base), upgradeRequest('//'));
    expect(response).toBe('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');

    const client = connect(base, WS_PATH, 'hub_session=good');
    await opened(client);
    expect(hub.size()).toBe(1);
  });

  it('refuses with 401 when the session check throws', async () => {
    const hub = new SocketHub();
    const base = await startServer(hub, () => {
      throw new Error('session store unavailable');
    });

    const status = await refusedStatus(connect(base, WS_PATH, 'hub_session=good'));

    expect(status).toBe(401);
    expect(hub.size()).toBe(0);
  });

  it('drops a client that sends invalid UTF-8 and keeps serving the others', async () => {
    const hub = new SocketHub();
    const base = await startServer(hub);
    const other = connect(base, WS_PATH, 'hub_session=good');
    await opened(other);
    const { socket } = await rawRequest(portOf(base), upgradeRequest(WS_PATH, 'hub_session=good'));
    await expect.poll(() => hub.size()).toBe(2);

    socket.write(maskedTextFrame(Buffer.from([0xff, 0xfe])));

    await expect.poll(() => hub.size()).toBe(1);
    const received = nextMessage(other);
    hub.broadcast({ type: 'pong', t: 9 });
    expect(await received).toBe(JSON.stringify({ type: 'pong', t: 9 }));
    expect(uncaught).toEqual([]);
  });

  it('closes a client that sends more than 64 KiB in one message, and accepts exactly 64 KiB', async () => {
    const hub = new SocketHub();
    const base = await startServer(hub);
    const client = connect(base, WS_PATH, 'hub_session=good');
    await opened(client);

    client.send('x'.repeat(64 * 1024));
    const pong = nextMessage(client);
    client.send(JSON.stringify({ type: 'ping', t: 5 }));
    expect(await pong).toBe(JSON.stringify({ type: 'pong', t: 5 }));

    let closeCode: number | undefined;
    client.once('close', (code) => {
      closeCode = code;
    });
    client.send('x'.repeat(64 * 1024 + 1));

    await expect.poll(() => closeCode).toBe(1009);
    await expect.poll(() => hub.size()).toBe(0);
    expect(uncaught).toEqual([]);
  });

  it('answers 401 on the wire, byte for byte, when the session check throws', async () => {
    const hub = new SocketHub();
    const base = await startServer(hub, () => {
      throw new Error('session store unavailable');
    });

    const { response } = await rawRequest(portOf(base), upgradeRequest(WS_PATH, 'hub_session=good'));

    expect(response).toBe('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    expect(hub.size()).toBe(0);
    expect(uncaught).toEqual([]);
  });
});

function closed(client: WebSocket): Promise<number> {
  return new Promise<number>((resolve) => {
    if (client.readyState === WebSocket.CLOSED) resolve(0);
    client.once('close', (code) => resolve(code));
  });
}

const LIVE_MS = 2000;
/** Heartbeat interval for tests that wait on a real sweep; short enough to be quick, long enough not to flake under load. */
const HEARTBEAT_TEST_MS = 250;

describe('attachWebSocket origin check', () => {
  it('connects when the Origin host matches the Host header, or when there is no Origin', async () => {
    const hub = new SocketHub();
    const base = await startServer(hub);
    const host = new URL(base).host;

    const same = connect(base, WS_PATH, 'hub_session=good', `http://${host}`);
    await opened(same);
    const secure = connect(base, WS_PATH, 'hub_session=good', `https://${host}`);
    await opened(secure);
    const none = connect(base, WS_PATH, 'hub_session=good');
    await opened(none);

    expect(hub.size()).toBe(3);
  });

  it('refuses a cross-site Origin with 403 even when the session is valid', async () => {
    const hub = new SocketHub();
    const base = await startServer(hub);

    const status = await refusedStatus(connect(base, WS_PATH, 'hub_session=good', 'https://other.tailnet.ts.net'));

    expect(status).toBe(403);
    expect(hub.size()).toBe(0);
  });

  it('refuses the same host on another port, and an Origin that is not a URL', async () => {
    const hub = new SocketHub();
    const base = await startServer(hub);
    const url = new URL(base);

    expect(await refusedStatus(connect(base, WS_PATH, 'hub_session=good', `http://${url.hostname}:1`))).toBe(403);
    expect(await refusedStatus(connect(base, WS_PATH, 'hub_session=good', 'null'))).toBe(403);
    expect(await refusedStatus(connect(base, WS_PATH, 'hub_session=good', ''))).toBe(403);
    expect(hub.size()).toBe(0);
  });

  it('answers a cross-site request without a session with a refusal too, and keeps accepting', async () => {
    const hub = new SocketHub();
    const base = await startServer(hub);

    const status = await refusedStatus(connect(base, WS_PATH, undefined, 'https://other.tailnet.ts.net'));
    expect([401, 403]).toContain(status);

    await opened(connect(base, WS_PATH, 'hub_session=good'));
    expect(hub.size()).toBe(1);
  });
});

describe('attachWebSocket session recheck', () => {
  function liveSessions(...tokens: string[]): { live: Set<string>; isAuthed: (h: string | undefined) => boolean } {
    const live = new Set(tokens);
    return { live, isAuthed: (h) => live.has(readCookie(h, 'hub_session') ?? '') };
  }

  it('recheck() closes a socket whose session ended and leaves the others open', async () => {
    const hub = new SocketHub();
    const { live, isAuthed } = liveSessions('a', 'b');
    const { base, attached } = await startAttached(hub, isAuthed);
    const a = connect(base, WS_PATH, 'hub_session=a');
    const b = connect(base, WS_PATH, 'hub_session=b');
    await opened(a);
    await opened(b);
    const aClosed = closed(a);

    live.delete('a');
    attached.recheck();

    await aClosed;
    await expect.poll(() => hub.size(), { timeout: LIVE_MS }).toBe(1);
    expect(b.readyState).toBe(WebSocket.OPEN);
    const received = nextMessage(b);
    hub.broadcast({ type: 'pong', t: 3 });
    expect(await received).toBe(JSON.stringify({ type: 'pong', t: 3 }));
  });

  it('recheck() with every session still valid closes nothing', async () => {
    const hub = new SocketHub();
    const { isAuthed } = liveSessions('a');
    const { base, attached } = await startAttached(hub, isAuthed);
    const a = connect(base, WS_PATH, 'hub_session=a');
    await opened(a);

    attached.recheck();
    attached.recheck();

    expect(a.readyState).toBe(WebSocket.OPEN);
    expect(hub.size()).toBe(1);
  });

  it('a heartbeat sweep rechecks every socket against the cookie it connected with', async () => {
    const hub = new SocketHub();
    const { live, isAuthed } = liveSessions('a', 'b');
    const { base } = await startAttached(hub, isAuthed, HEARTBEAT_TEST_MS);
    const a = connect(base, WS_PATH, 'hub_session=a');
    const b = connect(base, WS_PATH, 'hub_session=b');
    await opened(a);
    await opened(b);
    const aClosed = closed(a);

    live.delete('a');

    await aClosed;
    expect(b.readyState).toBe(WebSocket.OPEN);
    await expect.poll(() => hub.size(), { timeout: LIVE_MS }).toBe(1);
  });

  it('a check that throws during a recheck closes the socket instead of crashing', async () => {
    const hub = new SocketHub();
    let broken = false;
    const { base, attached } = await startAttached(hub, (h) => {
      if (broken) throw new Error('session store unavailable');
      return readCookie(h, 'hub_session') === 'good';
    });
    const client = connect(base, WS_PATH, 'hub_session=good');
    await opened(client);
    const done = closed(client);

    broken = true;

    expect(() => attached.recheck()).not.toThrow();
    await done;
  });

  it('a socket that closed on its own is forgotten by the next recheck', async () => {
    const hub = new SocketHub();
    const checks: Array<string | undefined> = [];
    const { base, attached } = await startAttached(hub, (h) => {
      checks.push(h);
      return true;
    });
    const client = connect(base, WS_PATH, 'hub_session=good');
    await opened(client);
    client.close();
    await expect.poll(() => hub.size(), { timeout: LIVE_MS }).toBe(0);
    checks.length = 0;

    attached.recheck();

    expect(checks).toEqual([]);
  });
});

describe('attachWebSocket close', () => {
  it('stops the heartbeat, terminates clients and detaches the upgrade listener', async () => {
    // Only the interval is faked, so the sockets run in real time while the test drives the heartbeat.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const hub = new SocketHub();
    const sweep = vi.spyOn(hub, 'sweep');
    const { base, attached } = await startAttached(hub, sessionCookieOk, 1000);
    const server = servers.at(-1);
    expect(server?.listenerCount('upgrade')).toBe(1);
    const client = connect(base, WS_PATH, 'hub_session=good');
    await opened(client);

    vi.advanceTimersByTime(1000);
    expect(sweep).toHaveBeenCalledTimes(1);

    const done = closed(client);
    attached.close();
    await done;

    vi.advanceTimersByTime(10_000);
    expect(sweep).toHaveBeenCalledTimes(1); // no heartbeat after close()
    expect(server?.listenerCount('upgrade')).toBe(0);

    const late = connect(base, WS_PATH, 'hub_session=good');
    await expect(opened(late)).rejects.toThrow(); // nobody accepts an upgrade any more
    expect(hub.size()).toBe(0);
  });
});
