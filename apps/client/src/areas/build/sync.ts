// Keeps one app's Build view in step with the hub: a snapshot on load, a catch-up each time the socket
// opens, and the live messages in between. It lives outside the component so its ordering rules can be
// unit-tested in node, without a DOM.

import type { BuildTask, ServerMsg } from '@hub/protocol';
import type { ApiClient } from '../../net/api.js';
import { errorText } from '../../net/errors.js';
import type { WsClient } from '../../net/ws.js';
import { EMPTY_VIEW, applyServerMsg, applyState, isRunStatus } from './state.js';
import type { BuildView } from './state.js';

/** The server's default page of messages. A full page after a cursor may be followed by more. */
export const PAGE_SIZE = 500;

export interface BuildSyncSnapshot {
  view: BuildView;
  /** Why the last fetch failed; null once one succeeds. Not for errors of the user's own actions. */
  loadError: string | null;
}

export interface BuildSyncOptions {
  app: string;
  api: Pick<ApiClient, 'buildState'>;
  ws: Pick<WsClient, 'on' | 'onStatus'>;
  /** Called after every change to the view or the load error, and never after stop(). */
  onChange: (snapshot: BuildSyncSnapshot) => void;
}

/**
 * Rules that keep the view right when things overlap:
 *
 * - One fetch runs at a time. A request made while one is in flight runs after it, so two snapshots never
 *   race and answer in the wrong order.
 * - The catch-up cursor is `synced`: the newest message a successful fetch returned. A live message can sit
 *   above a gap, so the newest message on screen is never used as the cursor.
 * - After a failed fetch, the next live message for this app fetches again, so the gap closes without
 *   waiting for a reconnect.
 * - A snapshot may set `running` only if no live build.task (or reply to an action) arrived while it was in
 *   flight; otherwise the live value is newer. The task's updatedAt cannot tell, because the run ending does
 *   not always change it.
 */
export class BuildSync {
  private readonly app: string;
  private readonly api: BuildSyncOptions['api'];
  private readonly ws: BuildSyncOptions['ws'];
  private readonly onChange: BuildSyncOptions['onChange'];

  private view: BuildView = EMPTY_VIEW;
  private loadError: string | null = null;
  private alive = false;
  private offs: Array<() => void> = [];

  /** Newest message id covered by a successful fetch; undefined until the first one. */
  private synced: number | undefined = undefined;
  private inFlight = false;
  private rerun = false;
  /** true after a fetch failed and until one succeeds. */
  private failed = false;
  /** Counts sources of `running` other than snapshots: live build.task messages and replies to actions. */
  private liveRunning = 0;

  constructor(opts: BuildSyncOptions) {
    this.app = opts.app;
    this.api = opts.api;
    this.ws = opts.ws;
    this.onChange = opts.onChange;
  }

  get snapshot(): BuildSyncSnapshot {
    return { view: this.view, loadError: this.loadError };
  }

  start(): void {
    if (this.alive) return;
    this.alive = true;
    this.offs = [
      this.ws.on((m) => this.onLive(m)),
      this.ws.onStatus((s) => {
        if (s === 'open') this.refresh();
      }),
    ];
    this.refresh();
  }

  stop(): void {
    this.alive = false;
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** Fetches what the view is missing. Safe to call at any time. */
  refresh(): void {
    if (!this.alive) return;
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    this.inFlight = true;
    void this.drain();
  }

  /**
   * Applies the task an action (send, merge, close) returned. The usual newer-task rule decides whether it
   * replaces the current one. `running` follows the task's status rather than the old value, so a new task
   * that is working turns Send off at once.
   */
  applyTask(task: BuildTask): void {
    if (!this.alive) return;
    this.liveRunning += 1;
    this.set(applyServerMsg(this.view, this.app, { type: 'build.task', app: this.app, task, running: isRunStatus(task.status) }));
  }

  private onLive(m: ServerMsg): void {
    if (m.type === 'build.task' && m.app === this.app) this.liveRunning += 1;
    this.set(applyServerMsg(this.view, this.app, m));
    const forThisApp = (m.type === 'build.message' || m.type === 'build.task') && m.app === this.app;
    if (forThisApp && this.failed && !this.inFlight) this.refresh();
  }

  private async drain(): Promise<void> {
    try {
      do {
        this.rerun = false;
        await this.pull();
      } while (this.rerun && this.alive);
    } finally {
      this.inFlight = false;
    }
  }

  /** One fetch from `synced`, paging while the pages come back full. */
  private async pull(): Promise<void> {
    let cursor = this.synced;
    for (;;) {
      const liveAtRequest = this.liveRunning;
      let state;
      try {
        state = await this.api.buildState(this.app, cursor);
      } catch (e) {
        if (!this.alive) return;
        this.failed = true;
        this.loadError = errorText(e);
        this.emit();
        return;
      }
      if (!this.alive) return;
      this.view = applyState(this.view, state, { running: this.liveRunning === liveAtRequest });
      const last = state.messages.at(-1)?.id;
      if (last !== undefined) this.synced = Math.max(this.synced ?? 0, last);
      this.failed = false;
      this.loadError = null;
      this.emit();
      if (cursor === undefined || state.messages.length < PAGE_SIZE || last === undefined || last <= cursor) return;
      cursor = last;
    }
  }

  private set(next: BuildView): void {
    if (next === this.view) return;
    this.view = next;
    this.emit();
  }

  private emit(): void {
    if (this.alive) this.onChange(this.snapshot);
  }
}
