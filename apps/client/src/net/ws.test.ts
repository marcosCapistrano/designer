import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildTask, ServerMsg } from '@hub/protocol';
import { WsClient, wsUrl, type SocketLike, type WsStatus } from './ws.js';

/** Errors that escaped an event handler. A browser reports these and carries on; it never rethrows to the caller. */
const escaped: unknown[] = [];

function dispatch<E>(handler: ((ev: E) => void) | null, ev: E): void {
  try {
    handler?.(ev);
  } catch (e) {
    escaped.push(e);
  }
}

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  sendThrows = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  send(data: string): void {
    if (this.sendThrows) throw new Error('InvalidStateError');
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    dispatch(this.onclose, {});
  }

  open(): void {
    this.readyState = 1;
    dispatch(this.onopen, {});
  }

  receive(obj: unknown): void {
    this.raw(JSON.stringify(obj));
  }

  raw(data: string): void {
    dispatch(this.onmessage, { data });
  }
}

const task: BuildTask = {
  id: 1,
  app: 'demo',
  title: 'Add a header',
  branch: 'build/add-a-header-1',
  base: 'main',
  status: 'working',
  prNumber: null,
  prUrl: null,
  headSha: null,
  ci: 'none',
  mergeSha: null,
  error: null,
  retryAt: null,
  createdAt: 1,
  updatedAt: 1,
};

describe('WsClient', () => {
  let sockets: FakeSocket[];
  const newSocket = (): SocketLike => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const reported: unknown[] = [];
  const makeClient = (makeSocket: (url: string) => SocketLike = newSocket): WsClient =>
    new WsClient({ url: 'ws://h/ws', makeSocket, onListenerError: (e) => void reported.push(e) });

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    reported.length = 0;
    escaped.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('wsUrl picks wss for https and ws otherwise', () => {
    expect(wsUrl({ protocol: 'https:', host: 'h' })).toBe('wss://h/ws');
    expect(wsUrl({ protocol: 'http:', host: 'h' })).toBe('ws://h/ws');
  });

  it('delivers parsed messages and drops garbage and pongs', () => {
    const client = makeClient();
    const got: ServerMsg[] = [];
    client.on((msg) => got.push(msg));
    client.connect();
    const socket = sockets[0]!;
    socket.open();
    const msg: ServerMsg = { type: 'build.task', app: 'demo', task, running: true };
    socket.receive(msg);
    socket.raw('garbage');
    socket.receive({ type: 'pong', t: 1 });
    expect(got).toEqual([msg]);
  });

  it('reconnects with backoff', () => {
    const client = makeClient();
    client.connect();
    sockets[0]!.close();
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.close();
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
  });

  it('backoff resets after open', () => {
    const client = makeClient();
    client.connect();
    sockets[0]!.close();
    vi.advanceTimersByTime(1000);
    sockets[1]!.close();
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(3);
    sockets[2]!.open();
    sockets[2]!.close();
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);
  });

  it('missing pong forces a reconnect', () => {
    const client = makeClient();
    client.connect();
    const socket = sockets[0]!;
    socket.open();
    vi.advanceTimersByTime(25_000);
    expect(socket.sent[0]).toMatch(/"type":"ping"/);
    vi.advanceTimersByTime(10_000);
    expect(socket.readyState).toBe(3);
    expect(client.status).toBe('closed');
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it('a pong keeps the connection', () => {
    const client = makeClient();
    client.connect();
    const socket = sockets[0]!;
    socket.open();
    vi.advanceTimersByTime(25_000);
    socket.receive({ type: 'pong', t: 25_000 });
    vi.advanceTimersByTime(10_000);
    expect(socket.readyState).toBe(1);
    expect(client.status).toBe('open');
  });

  it('kick pings an open socket without reconnecting', () => {
    const client = makeClient();
    client.connect();
    const socket = sockets[0]!;
    socket.open();
    client.kick();
    expect(socket.sent[0]).toMatch(/"type":"ping"/);
    expect(sockets).toHaveLength(1);
  });

  it('kick reconnects immediately when closed', () => {
    const client = makeClient();
    client.connect();
    sockets[0]!.close();
    client.kick();
    expect(sockets).toHaveLength(2);
    expect(client.status).toBe('connecting');
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it('connect after close starts the backoff fresh', () => {
    const client = makeClient();
    client.connect();
    sockets[0]!.close();
    vi.advanceTimersByTime(1000);
    sockets[1]!.close();
    client.close();
    client.connect();
    expect(sockets).toHaveLength(3);
    sockets[2]!.close();
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);
  });

  it('close stops reconnecting', () => {
    const client = makeClient();
    client.connect();
    sockets[0]!.open();
    client.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(client.status).toBe('closed');
  });

  it('status transitions', () => {
    const client = makeClient();
    const seen: WsStatus[] = [];
    client.onStatus((s) => seen.push(s));
    client.connect();
    sockets[0]!.open();
    sockets[0]!.close();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(['connecting', 'open', 'closed', 'connecting']);
  });

  it('close during the backoff cancels the pending reconnect', () => {
    const client = makeClient();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.close();
    vi.advanceTimersByTime(500);
    client.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(client.status).toBe('closed');
  });

  it('close from a closed-status listener leaves no reconnect behind', () => {
    const client = makeClient();
    client.onStatus((s) => {
      if (s === 'closed') client.close();
    });
    client.connect();
    sockets[0]!.open();
    sockets[0]!.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  describe('a throwing listener', () => {
    it('on the closed status does not stop the reconnect', () => {
      const client = makeClient();
      client.onStatus((s) => {
        if (s === 'closed') throw new Error('listener bug');
      });
      client.connect();
      sockets[0]!.open();
      sockets[0]!.close();
      expect(escaped).toEqual([]);
      vi.advanceTimersByTime(1000);
      expect(sockets).toHaveLength(2);
      expect(reported).toHaveLength(1);
    });

    it('on the open status does not stop the pings', () => {
      const client = makeClient();
      client.onStatus((s) => {
        if (s === 'open') throw new Error('listener bug');
      });
      client.connect();
      const socket = sockets[0]!;
      socket.open();
      expect(escaped).toEqual([]);
      vi.advanceTimersByTime(25_000);
      expect(socket.sent[0]).toMatch(/"type":"ping"/);
      vi.advanceTimersByTime(10_000);
      expect(socket.readyState).toBe(3);
    });

    it('on a message does not starve the listeners after it', () => {
      const client = makeClient();
      const got: ServerMsg[] = [];
      client.on(() => {
        throw new Error('listener bug');
      });
      client.on((msg) => got.push(msg));
      client.connect();
      sockets[0]!.open();
      const msg: ServerMsg = { type: 'build.task', app: 'demo', task, running: false };
      sockets[0]!.receive(msg);
      expect(got).toEqual([msg]);
      expect(escaped).toEqual([]);
      expect(reported).toHaveLength(1);
    });
  });

  describe('a socket that cannot be made', () => {
    it('is a drop: connect does not throw and the backoff retries', () => {
      let calls = 0;
      const client = makeClient(() => {
        calls += 1;
        if (calls === 1) throw new SyntaxError('bad url');
        return newSocket();
      });
      expect(() => client.connect()).not.toThrow();
      expect(client.status).toBe('closed');
      vi.advanceTimersByTime(999);
      expect(calls).toBe(1);
      vi.advanceTimersByTime(1);
      expect(calls).toBe(2);
      expect(client.status).toBe('connecting');
    });

    it('keeps backing off while it keeps failing', () => {
      let calls = 0;
      const client = makeClient(() => {
        calls += 1;
        throw new Error('no network stack');
      });
      client.connect();
      vi.advanceTimersByTime(1000);
      expect(calls).toBe(2);
      vi.advanceTimersByTime(1999);
      expect(calls).toBe(2);
      vi.advanceTimersByTime(1);
      expect(calls).toBe(3);
      client.close();
      vi.advanceTimersByTime(60_000);
      expect(calls).toBe(3);
    });
  });

  it('a ping that cannot be sent drops the socket and reconnects', () => {
    const client = makeClient();
    client.connect();
    const socket = sockets[0]!;
    socket.open();
    socket.sendThrows = true;
    vi.advanceTimersByTime(25_000);
    expect(escaped).toEqual([]);
    expect(client.status).toBe('closed');
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it('kick while a reconnect is pending leaves exactly one timer', () => {
    const client = makeClient();
    client.connect();
    sockets[0]!.close();
    client.kick();
    sockets[1]!.close();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(3);
    // The timer the kick replaced must not fire a second socket later.
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(3);
  });
});
