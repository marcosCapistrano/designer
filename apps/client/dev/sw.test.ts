import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://hub.test';

type Handler = (event: FakeEvent) => void;

interface FakeEvent {
  request?: { url: string; method: string; mode: string };
  respondWith?: (p: Promise<Response | undefined>) => void;
  waitUntil: (p: Promise<unknown>) => void;
}

/** A Cache API stand-in keyed by pathname, so a test can see exactly what the worker stored. */
class FakeCache {
  readonly entries = new Map<string, Response>();
  constructor(private readonly net: (url: string) => Promise<Response>) {}
  async put(key: string | { url: string }, res: Response): Promise<void> {
    this.entries.set(pathOf(key), res);
  }
  async add(key: string): Promise<void> {
    const res = await this.net(key);
    if (!res.ok) throw new TypeError(`bad status ${res.status}`);
    this.entries.set(pathOf(key), res);
  }
  async match(key: string | { url: string }): Promise<Response | undefined> {
    return this.entries.get(pathOf(key));
  }
}

function pathOf(key: string | { url: string }): string {
  return new URL(typeof key === 'string' ? key : key.url, ORIGIN).pathname;
}

function html(...assets: string[]): string {
  return `<!doctype html>${assets.map((a) => `<script type="module" src="${a}"></script>`).join('')}`;
}

/** Runs sw.js in a context with a fake worker scope, Cache API and network. */
function boot(network: Map<string, () => Response | Promise<Response>>) {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, FakeCache>();
  const fetchCalls: string[] = [];
  const net = async (input: string | { url: string }): Promise<Response> => {
    const path = pathOf(input);
    fetchCalls.push(path);
    const serve = network.get(path);
    if (serve === undefined) throw new TypeError('network down');
    return serve();
  };
  const caches = {
    async open(name: string): Promise<FakeCache> {
      let c = stores.get(name);
      if (c === undefined) {
        c = new FakeCache(net);
        stores.set(name, c);
      }
      return c;
    },
    async keys(): Promise<string[]> {
      return [...stores.keys()];
    },
    async delete(name: string): Promise<boolean> {
      return stores.delete(name);
    },
    async match(key: string | { url: string }): Promise<Response | undefined> {
      for (const c of stores.values()) {
        const hit = await c.match(key);
        if (hit !== undefined) return hit;
      }
      return undefined;
    },
  };
  const state = { skipped: false, claimed: false };
  const self = {
    location: { origin: ORIGIN },
    clients: { claim: async () => void (state.claimed = true) },
    skipWaiting: () => void (state.skipped = true),
    addEventListener: (type: string, h: Handler) => void handlers.set(type, h),
  };
  runInNewContext(SOURCE, { self, caches, fetch: net, URL });

  const run = async (type: string, event?: Partial<FakeEvent>): Promise<{ response?: Response | undefined }> => {
    const waits: Promise<unknown>[] = [];
    let response: Promise<Response | undefined> | undefined;
    const handler = handlers.get(type);
    if (handler === undefined) throw new Error(`no ${type} handler`);
    handler({
      ...event,
      waitUntil: (p) => void waits.push(p),
      respondWith: (p) => void (response = p),
    });
    await Promise.all(waits);
    return { response: response === undefined ? undefined : await response };
  };
  const navigate = (path = '/') =>
    run('fetch', { request: { url: ORIGIN + path, method: 'GET', mode: 'navigate' } });
  const asset = (path: string) => run('fetch', { request: { url: ORIGIN + path, method: 'GET', mode: 'no-cors' } });

  /** The one cache this build owns: the name is stamped at build time, so read it off the install. */
  const current = async (): Promise<FakeCache> => {
    const names = [...stores.keys()];
    if (names.length !== 1) throw new Error(`expected one cache, found ${names.join(', ')}`);
    return stores.get(names[0]!)!;
  };
  return { run, navigate, asset, stores, caches, fetchCalls, state, current };
}

const ok = (body = 'shell'): (() => Response) => () => new Response(body, { status: 200 });

describe('service worker', () => {
  it('install caches the shell and the assets it names', async () => {
    const sw = boot(
      new Map([
        ['/', ok(html('/assets/main-a.js', '/assets/main-a.css'))],
        ['/assets/main-a.js', ok('js')],
        ['/assets/main-a.css', ok('css')],
      ]),
    );
    await sw.run('install');
    const cache = await sw.current();
    expect([...cache.entries.keys()].sort()).toEqual(['/', '/assets/main-a.css', '/assets/main-a.js']);
    expect(sw.state.skipped).toBe(true);
  });

  it('install fails when the shell is not OK, so a 502 never becomes the offline shell', async () => {
    const sw = boot(new Map([['/', () => new Response('bad gateway', { status: 502 })]]));
    await expect(sw.run('install')).rejects.toThrow();
    expect((await sw.caches.match('/')) === undefined).toBe(true);
  });

  it('install still succeeds when an asset cannot be fetched', async () => {
    const sw = boot(
      new Map([
        ['/', ok(html('/assets/main-a.js'))],
        ['/assets/main-a.js', () => new Response('gone', { status: 404 })],
      ]),
    );
    await sw.run('install');
    expect([...(await sw.current()).entries.keys()]).toEqual(['/']);
  });

  it('a successful navigation refreshes the cached shell', async () => {
    const network = new Map([['/', ok(html('/assets/main-a.js'))]]);
    const sw = boot(network);
    await sw.run('install');
    network.set('/', ok('newer shell'));
    const { response } = await sw.navigate();
    expect(await response?.text()).toBe('newer shell');
    expect(await (await (await sw.current()).match('/'))?.text()).toBe('newer shell');
  });

  it('a 5xx navigation is passed through but never replaces the cached shell', async () => {
    const network = new Map<string, () => Response>([['/', ok('good shell')]]);
    const sw = boot(network);
    await sw.run('install');
    network.set('/', () => new Response('bad gateway', { status: 502 }));
    const { response } = await sw.navigate();
    expect(response?.status).toBe(502);
    expect(await (await (await sw.current()).match('/'))?.text()).toBe('good shell');
  });

  it('serves the cached shell when the network is down', async () => {
    const network = new Map<string, () => Response>([['/', ok('good shell')]]);
    const sw = boot(network);
    await sw.run('install');
    network.delete('/');
    const { response } = await sw.navigate();
    expect(await response?.text()).toBe('good shell');
  });

  it('caches an /assets/ file only when the response is OK', async () => {
    const network = new Map<string, () => Response>([['/', ok('shell')]]);
    const sw = boot(network);
    await sw.run('install');
    network.set('/assets/x.js', () => new Response('nope', { status: 503 }));
    network.set('/assets/y.js', ok('y'));
    await sw.asset('/assets/x.js');
    await sw.asset('/assets/y.js');
    const keys = [...(await sw.current()).entries.keys()];
    expect(keys).toContain('/assets/y.js');
    expect(keys).not.toContain('/assets/x.js');
  });

  it('an /assets/ hit is served from the cache without the network', async () => {
    const network = new Map<string, () => Response>([['/', ok('shell')]]);
    const sw = boot(network);
    await sw.run('install');
    (await sw.current()).entries.set('/assets/z.js', new Response('cached'));
    const before = sw.fetchCalls.length;
    const { response } = await sw.asset('/assets/z.js');
    expect(await response?.text()).toBe('cached');
    expect(sw.fetchCalls.length).toBe(before);
  });

  it('activate prunes caches from other builds, keeps this one and takes control', async () => {
    const sw = boot(new Map([['/', ok('shell')]]));
    await sw.run('install');
    const mine = [...sw.stores.keys()][0]!;
    await sw.caches.open('hub-shell-v1');
    await sw.caches.open('hub-shell-oldbuild');
    await sw.run('activate');
    expect([...sw.stores.keys()]).toEqual([mine]);
    expect(sw.state.claimed).toBe(true);
  });

  it('activate leaves caches that are not the hub shell alone', async () => {
    const sw = boot(new Map([['/', ok('shell')]]));
    await sw.run('install');
    await sw.caches.open('someone-elses');
    await sw.run('activate');
    expect([...sw.stores.keys()]).toContain('someone-elses');
  });

  it('ignores non-GET and cross-origin requests', async () => {
    const sw = boot(new Map());
    const post = await sw.run('fetch', { request: { url: `${ORIGIN}/api/x`, method: 'POST', mode: 'cors' } });
    const cross = await sw.run('fetch', { request: { url: 'https://other.test/assets/a.js', method: 'GET', mode: 'cors' } });
    expect(post.response).toBeUndefined();
    expect(cross.response).toBeUndefined();
  });
});
