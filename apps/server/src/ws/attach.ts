import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';
import type { SocketHub } from './hub.js';

export const WS_PATH = '/ws';
export const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Accepts WebSocket upgrades on WS_PATH only. An upgrade is refused (404 for another path, 403 for a cross-site
 * Origin, 401 without a valid session) before the socket is accepted. `isAuthed` gets the request's cookie header;
 * one that throws, or a request target that does not parse, is refused the same way instead of crashing the process.
 *
 * Sockets do not outlive their session: each one remembers the cookie header it connected with, and every heartbeat
 * sweep (and every `recheck()`) runs `isAuthed` on it again and terminates the sockets that fail. A check that
 * throws counts as failing. The returned close() stops the heartbeat, terminates every client and detaches the
 * upgrade listener.
 */
export function attachWebSocket(
  server: Server,
  hub: SocketHub,
  opts: { isAuthed: (cookieHeader: string | undefined) => boolean; heartbeatMs?: number },
): { wss: WebSocketServer; recheck(): void; close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  /** The cookie header each open socket connected with. */
  const cookies = new Map<WebSocket, string | undefined>();

  const recheck = (): void => {
    for (const [ws, cookie] of [...cookies]) {
      if (allowed(opts.isAuthed, cookie)) continue;
      cookies.delete(ws);
      try {
        ws.terminate();
      } catch {
        // Ignored: a socket that cannot be terminated is already closing.
      }
    }
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (pathOf(req.url) !== WS_PATH) {
      refuse(socket, 'HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!sameOrigin(req.headers.origin, req.headers.host)) {
      refuse(socket, 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const cookie = req.headers.cookie;
    if (!allowed(opts.isAuthed, cookie)) {
      refuse(socket, 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.add(ws);
      cookies.set(ws, cookie);
      ws.on('error', () => ws.terminate());
      ws.on('pong', () => hub.markAlive(ws));
      ws.on('message', (d) => hub.handleMessage(ws, d.toString()));
      ws.on('close', () => {
        cookies.delete(ws);
        hub.remove(ws);
      });
    });
  };
  server.on('upgrade', onUpgrade);

  const timer = setInterval(() => {
    recheck();
    hub.sweep();
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref();

  return {
    wss,
    recheck,
    close() {
      clearInterval(timer);
      server.off('upgrade', onUpgrade);
      for (const client of [...wss.clients]) client.terminate();
      wss.close();
    },
  };
}

/**
 * Whether the Origin header (when there is one) names the host the request was sent to. A browser always sends
 * Origin on a WebSocket handshake, and a page on another site cannot change it, so a mismatch is a cross-site
 * request riding the session cookie. No Origin means a client that is not a browser page, which cannot do that.
 * Only host[:port] is compared: the hub sees plain http behind `tailscale serve`, while the page's Origin is https.
 */
function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
}

/** The URL pathname, or null when the request target does not parse. */
function pathOf(url: string | undefined): string | null {
  try {
    return new URL(url ?? '/', 'http://hub').pathname;
  } catch {
    return null;
  }
}

/** A check that throws refuses the request. */
function allowed(check: (cookieHeader: string | undefined) => boolean, cookie: string | undefined): boolean {
  try {
    return check(cookie);
  } catch {
    return false;
  }
}

/** Writes the refusal and destroys the socket. The error listener stops a client reset from crashing the process, since http drops its own once the upgrade is emitted. */
function refuse(socket: Duplex, response: string): void {
  socket.on('error', () => socket.destroy());
  socket.write(response);
  socket.destroy();
}
