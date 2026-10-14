export interface LimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  lockMs?: number;
}

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WINDOW_MS = 900_000;
const DEFAULT_LOCK_MS = 900_000;

/** Locks login attempts for a while after too many failures inside a sliding window. Time is passed in, never read. */
export class LoginLimiter {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private failures: number[] = [];
  private lockedUntil = 0;

  constructor(opts: LimiterOptions = {}) {
    this.maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.lockMs = opts.lockMs ?? DEFAULT_LOCK_MS;
  }

  blocked(now: number): boolean {
    return now < this.lockedUntil;
  }

  fail(now: number): void {
    this.failures = this.failures.filter((at) => now - at <= this.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.maxFailures) {
      this.lockedUntil = now + this.lockMs;
      this.failures = [];
    }
  }

  reset(): void {
    this.failures = [];
  }
}
