import { parseServerMsg, type ClientMsg, type ServerMsg } from '@hub/protocol';

export type WsStatus = 'connecting' | 'open' | 'closed';

/** The part of WebSocket the client uses, so tests can substitute a fake. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface WsClientOptions {
  url: string;
  makeSocket?: (url: string) => SocketLike;
  now?: () => number;
  pingMs?: number;
  pongTimeoutMs?: number;
  maxBackoffMs?: number;
  /** Where an error thrown by a listener goes. It never stops the client. Defaults to console.error. */
  onListenerError?: (error: unknown) => void;
}

const BASE_BACKOFF_MS = 1000;

export function wsUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

/**
 * One WebSocket to the hub. Pings keep it alive and a missing pong forces a reconnect;
 * reconnects back off exponentially. Pongs are consumed here and never forwarded.
 */
export class WsClient {
  private readonly url: string;
  private readonly makeSocket: (url: string) => SocketLike;
  private readonly now: () => number;
  private readonly pingMs: number;
  private readonly pongTimeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly onListenerError: (error: unknown) => void;

  private readonly listeners = new Set<(msg: ServerMsg) => void>();
  private readonly statusListeners = new Set<(s: WsStatus) => void>();
  private currentStatus: WsStatus = 'closed';
  private socket: SocketLike | null = null;
  /** true from connect() until close(); gates reconnects and kick(). */
  private running = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WsClientOptions) {
    this.url = opts.url;
    this.makeSocket = opts.makeSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.now = opts.now ?? Date.now;
    this.pingMs = opts.pingMs ?? 25_000;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? 10_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.onListenerError = opts.onListenerError ?? ((e) => console.error('WebSocket listener failed', e));
  }

  get status(): WsStatus {
    return this.currentStatus;
  }

  connect(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.openSocket();
  }

  /** Stops the connection and any pending reconnect. */
  close(): void {
    this.running = false;
    this.clearReconnect();
    this.clearLiveness();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.setStatus('closed');
  }

  /** Open: ping now. Otherwise: reconnect now with the backoff reset. No effect after close(). */
  kick(): void {
    if (!this.running) return;
    if (this.currentStatus === 'open') {
      this.ping();
      return;
    }
    this.clearReconnect();
    this.attempt = 0;
    const stale = this.socket;
    this.socket = null;
    stale?.close();
    this.openSocket();
  }

  on(listener: (msg: ServerMsg) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onStatus(listener: (s: WsStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private openSocket(): void {
    this.setStatus('connecting');
    let socket: SocketLike;
    try {
      socket = this.makeSocket(this.url);
    } catch {
      // new WebSocket() throws for a URL it refuses. That is a failed attempt like any other: back off and retry.
      this.scheduleReconnect();
      this.setStatus('closed');
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      // Bookkeeping first: a listener that throws or closes the client must not leave the socket without pings.
      this.attempt = 0;
      this.clearLiveness();
      this.pingTimer = setInterval(() => this.ping(), this.pingMs);
      this.setStatus('open');
    };
    socket.onmessage = (ev) => {
      if (this.socket === socket) this.receive(ev.data);
    };
    socket.onclose = () => this.dropped(socket);
  }

  private receive(data: unknown): void {
    const msg = typeof data === 'string' ? parseServerMsg(data) : null;
    if (msg === null) return;
    if (msg.type === 'pong') {
      this.clearPongTimer();
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(msg);
      } catch (e) {
        this.onListenerError(e);
      }
    }
  }

  private ping(): void {
    const socket = this.socket;
    if (socket === null || this.currentStatus !== 'open') return;
    const msg: ClientMsg = { type: 'ping', t: this.now() };
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      // The socket is not open any more (closing, or closed without an event yet).
      this.abandon(socket);
      return;
    }
    this.clearPongTimer();
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      this.abandon(socket);
    }, this.pongTimeoutMs);
  }

  /** No pong in time: close the socket and treat it as dropped. */
  private abandon(socket: SocketLike): void {
    if (this.socket !== socket) return;
    socket.close();
    this.dropped(socket);
  }

  /** Idempotent: a socket that is already replaced or dropped is ignored. */
  private dropped(socket: SocketLike): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.clearLiveness();
    // The reconnect is scheduled before anyone is told, so no listener can get in its way.
    if (this.running) this.scheduleReconnect();
    this.setStatus('closed');
  }

  private scheduleReconnect(): void {
    // One timer at most: a second schedule replaces the first rather than adding a socket later.
    this.clearReconnect();
    const delay = Math.min(this.maxBackoffMs, BASE_BACKOFF_MS * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.openSocket();
    }, delay);
  }

  /** Updates the status, then tells every listener. A listener that throws does not stop the others. */
  private setStatus(next: WsStatus): void {
    if (next === this.currentStatus) return;
    this.currentStatus = next;
    for (const listener of [...this.statusListeners]) {
      try {
        listener(next);
      } catch (e) {
        this.onListenerError(e);
      }
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearPongTimer(): void {
    if (this.pongTimer !== null) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private clearLiveness(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.clearPongTimer();
  }
}
