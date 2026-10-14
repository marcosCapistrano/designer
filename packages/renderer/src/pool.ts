import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type LaunchOptions,
  type Page,
} from 'playwright';

export const CHROMIUM_ARGS: readonly string[] = [
  '--font-render-hinting=none',
  '--force-color-profile=srgb',
  '--disable-lcd-text',
  '--hide-scrollbars',
];

export const CONTEXT_OPTIONS: BrowserContextOptions = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  javaScriptEnabled: false,
  colorScheme: 'light',
  reducedMotion: 'reduce',
  locale: 'en-US',
  timezoneId: 'UTC',
};

const PAGE_TIMEOUT_MS = 30_000;
const CLOSED_MESSAGE = 'BrowserPool is closed';

export interface PoolOptions {
  /** Maximum number of pages in use at once. Default 2. */
  size?: number;
  launch?: LaunchOptions;
}

export interface PoolStats {
  launches: number;
  busy: number;
  idle: number;
  waiting: number;
}

interface Slot {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

interface Waiter {
  /** Receives a healthy idle slot to reuse, or null when the caller must create one. */
  resolve: (slot: Slot | null) => void;
  reject: (err: Error) => void;
}

/**
 * One long-lived Chromium, a bounded set of isolated slots (context + page), and FIFO queueing
 * for callers beyond capacity. A job that throws retires its slot; a browser crash is recovered
 * on the next call.
 */
export class BrowserPool {
  readonly #size: number;
  readonly #launch: LaunchOptions;
  #browser: Promise<Browser> | null = null;
  #launches = 0;
  /** Capacity in use: checked-out slots plus slots being created. */
  #busy = 0;
  #idle: Slot[] = [];
  #waiting: Waiter[] = [];
  #closed = false;

  constructor(opts: PoolOptions = {}) {
    const size = opts.size ?? 2;
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError('BrowserPool size must be a positive integer');
    }
    this.#size = size;
    this.#launch = opts.launch ?? {};
  }

  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const slot = await this.#checkout();
    let result: T;
    try {
      result = await fn(slot.page);
    } catch (err) {
      await this.#discard(slot);
      throw err;
    }
    if (this.#closed || !slot.browser.isConnected()) {
      await this.#discard(slot);
    } else {
      this.#free(slot);
    }
    return result;
  }

  stats(): PoolStats {
    return {
      launches: this.#launches,
      busy: this.#busy,
      idle: this.#idle.length,
      waiting: this.#waiting.length,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiting.splice(0)) {
      waiter.reject(new Error(CLOSED_MESSAGE));
    }
    const launching = this.#browser;
    this.#browser = null;
    this.#idle = [];
    if (launching) {
      const browser = await launching.catch(() => null);
      await browser?.close().catch(() => undefined);
    }
  }

  async #checkout(): Promise<Slot> {
    this.#assertOpen();
    let handed: Slot | null;
    if (this.#busy < this.#size) {
      this.#busy++;
      handed = this.#idle.pop() ?? null;
    } else {
      handed = await new Promise<Slot | null>((resolve, reject) => {
        this.#waiting.push({ resolve, reject });
      });
    }
    try {
      if (handed?.browser.isConnected()) return handed;
      if (handed) await this.#closeQuietly(handed.context);
      return await this.#create();
    } catch (err) {
      this.#free();
      throw err;
    }
  }

  async #create(): Promise<Slot> {
    const browser = await this.#getBrowser();
    const context = await browser.newContext({ ...CONTEXT_OPTIONS });
    try {
      await context.route('**/*', (route) => route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(PAGE_TIMEOUT_MS);
      return { browser, context, page };
    } catch (err) {
      await this.#closeQuietly(context);
      throw err;
    }
  }

  #getBrowser(): Promise<Browser> {
    this.#assertOpen();
    if (this.#browser) return this.#browser;
    this.#launches++;
    const launching = chromium.launch({ args: [...CHROMIUM_ARGS], ...this.#launch });
    this.#browser = launching;
    launching.then(
      (browser) => {
        browser.on('disconnected', () => {
          if (this.#browser === launching) this.#browser = null;
          this.#idle = this.#idle.filter((slot) => slot.browser !== browser);
        });
      },
      () => {
        if (this.#browser === launching) this.#browser = null;
      },
    );
    return launching;
  }

  /** Hands capacity to the oldest waiter (with the slot, if any), or returns it to the pool. */
  #free(slot?: Slot): void {
    const next = this.#waiting.shift();
    if (next) {
      next.resolve(slot ?? null);
      return;
    }
    this.#busy--;
    if (slot) this.#idle.push(slot);
  }

  async #discard(slot: Slot): Promise<void> {
    await this.#closeQuietly(slot.context);
    this.#free();
  }

  async #closeQuietly(context: BrowserContext): Promise<void> {
    await context.close().catch(() => undefined);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(CLOSED_MESSAGE);
  }
}
