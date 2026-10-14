import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerMsg } from '@hub/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
const attachments: Array<ReturnType<typeof attachWebSocket>> = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  for (const attached of attachments.splice(0)) attached.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

async function startServer(hub: SocketHub): Promise<string> {
  const server = createServer((_req, res) => res.end());
  servers.push(server);
  attachments.push(
    attachWebSocket(server, hub, { isAuthed: (h) => readCookie(h, 'hub_session') === 'good' }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}`;
}

function connect(base: string, path: string, cookie?: string): WebSocket {
  const client = new WebSocket(`${base}${path}`, { headers: cookie ? { cookie } : {} });
  clients.push(client);
  return client;
}

function opened(client: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
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
    const received = new Promise<string>((resolve, reject) => {
      client.once('message', (d) => resolve(d.toString()));
      client.once('error', reject);
    });
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
});
