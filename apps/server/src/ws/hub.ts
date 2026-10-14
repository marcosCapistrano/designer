import { parseClientMsg, type PongMsg, type ServerMsg } from '@hub/protocol';

/** WebSocket readyState for an open connection. */
const OPEN = 1;

export interface WsHub {
  broadcast(msg: ServerMsg): void;
}

/** The part of a WebSocket the hub uses, so tests can substitute a fake. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  ping(): void;
  terminate(): void;
}

/** Open sockets with a liveness flag for the heartbeat. New sockets start alive. */
export class SocketHub implements WsHub {
  /** Socket to "alive since the last sweep". */
  private readonly sockets = new Map<SocketLike, boolean>();

  add(s: SocketLike): void {
    this.sockets.set(s, true);
  }

  remove(s: SocketLike): void {
    this.sockets.delete(s);
  }

  size(): number {
    return this.sockets.size;
  }

  /** Serializes once and sends to open sockets. A send that throws is skipped so the rest still get the message. */
  broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const s of this.sockets.keys()) {
      if (s.readyState !== OPEN) continue;
      try {
        s.send(data);
      } catch {
        // Ignored: the socket's close event removes it from the hub.
      }
    }
  }

  /** Called on a protocol-level pong. Unknown sockets are ignored. */
  markAlive(s: SocketLike): void {
    if (this.sockets.has(s)) this.sockets.set(s, true);
  }

  /**
   * Terminates and removes sockets that stayed silent since the last sweep, pings the rest, and marks every survivor not alive.
   * A socket whose ping or terminate throws is skipped so the rest still get swept.
   */
  sweep(): void {
    for (const [s, alive] of this.sockets) {
      try {
        if (alive) {
          this.sockets.set(s, false);
          s.ping();
        } else {
          this.sockets.delete(s);
          s.terminate();
        }
      } catch {
        // Ignored. A socket whose ping threw stays not alive, so the next sweep terminates it unless it pongs.
      }
    }
  }

  /** Answers `{type:'ping', t}` with `{type:'pong', t}` on the same socket. Anything else is ignored. */
  handleMessage(s: SocketLike, data: string): void {
    const msg = parseClientMsg(data);
    if (msg === null) return;
    const pong: PongMsg = { type: 'pong', t: msg.t };
    s.send(JSON.stringify(pong));
  }
}
