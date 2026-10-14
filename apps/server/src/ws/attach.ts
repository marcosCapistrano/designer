import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { SocketHub } from './hub.js';

export const WS_PATH = '/ws';
export const HEARTBEAT_MS = 30_000;

/**
 * Accepts WebSocket upgrades on WS_PATH only, and only when `isAuthed` accepts the request's cookie header.
 * Every other upgrade is refused before the socket is accepted. The returned close() stops the heartbeat,
 * terminates every client and detaches the upgrade listener.
 */
export function attachWebSocket(
  server: Server,
  hub: SocketHub,
  opts: { isAuthed: (cookieHeader: string | undefined) => boolean; heartbeatMs?: number },
): { wss: WebSocketServer; close(): void } {
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (new URL(req.url ?? '/', 'http://hub').pathname !== WS_PATH) {
      refuse(socket, 'HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!opts.isAuthed(req.headers.cookie)) {
      refuse(socket, 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.add(ws);
      ws.on('pong', () => hub.markAlive(ws));
      ws.on('message', (d) => hub.handleMessage(ws, d.toString()));
      ws.on('close', () => hub.remove(ws));
    });
  };
  server.on('upgrade', onUpgrade);

  const timer = setInterval(() => hub.sweep(), opts.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref();

  return {
    wss,
    close() {
      clearInterval(timer);
      server.off('upgrade', onUpgrade);
      for (const client of [...wss.clients]) client.terminate();
      wss.close();
    },
  };
}

/** Writes the refusal and destroys the socket. The error listener stops a client reset from crashing the process, since http drops its own once the upgrade is emitted. */
function refuse(socket: Duplex, response: string): void {
  socket.on('error', () => socket.destroy());
  socket.write(response);
  socket.destroy();
}
