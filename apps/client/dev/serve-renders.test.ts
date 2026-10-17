import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { serveRenders } from './serve-renders.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'serve-renders-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('serves files under /dev-renders and 404s the rest', async () => {
  await writeFile(join(dir, 'manifest.json'), '{"version":2,"pages":[]}');
  const server = await createServer({
    configFile: false,
    root: dir,
    logLevel: 'silent',
    plugins: [serveRenders(dir)],
    server: { port: 0, host: '127.0.0.1' },
  });
  try {
    await server.listen();
    const port = (server.httpServer!.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const hit = await fetch(`${base}/dev-renders/manifest.json`);
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual({ version: 2, pages: [] });

    const miss = await fetch(`${base}/dev-renders/nope.json`);
    expect(miss.status).toBe(404);
    await miss.text();
  } finally {
    await server.close();
  }
});
