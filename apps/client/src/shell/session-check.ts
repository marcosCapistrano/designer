import type { ApiClient } from '../net/api.js';

export interface SessionCheckHandlers {
  /** The hub answered: true when the cookie is valid. */
  onResult: (ok: boolean) => void;
  /** The hub could not be asked, or answered with an error. */
  onError: (error: unknown) => void;
}

/**
 * Asks the hub whether the session still holds, and reports the answer only while it is still wanted:
 * a newer run() replaces an older one, and stop() drops whatever is in flight. Without that, an answer
 * for a session that was logged out and logged in again would send the fresh session back to login.
 */
export class SessionCheck {
  private seq = 0;

  constructor(
    private readonly api: Pick<ApiClient, 'session'>,
    private readonly handlers: SessionCheckHandlers,
  ) {}

  run(): void {
    const seq = ++this.seq;
    this.api.session().then(
      (ok) => {
        if (seq === this.seq) this.handlers.onResult(ok);
      },
      (e: unknown) => {
        if (seq === this.seq) this.handlers.onError(e);
      },
    );
  }

  /** Drops any check in flight. run() works again afterwards. */
  stop(): void {
    this.seq += 1;
  }
}
