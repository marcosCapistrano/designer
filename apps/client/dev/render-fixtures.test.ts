import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_OUT, parseArgs, renderFixtures } from './render-fixtures.js';

describe('parseArgs', () => {
  it('defaults', () => {
    expect(parseArgs([])).toEqual({ pages: 50, seed: 1, out: DEFAULT_OUT });
  });

  it('reads flags', () => {
    expect(parseArgs(['--pages', '3', '--seed', '7', '--out', '/tmp/x'])).toEqual({
      pages: 3,
      seed: 7,
      out: '/tmp/x',
    });
  });
});

describe('renderFixtures', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fixtures-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('renders then reuses', async () => {
    const opts = { pages: 2, seed: 1, out: dir, poolSize: 2 };

    expect(await renderFixtures(opts)).toEqual({ pages: 2, rendered: 6, reused: 0, failed: 0 });
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.pages).toHaveLength(2);

    expect(await renderFixtures(opts)).toEqual({ pages: 2, rendered: 0, reused: 6, failed: 0 });
  });
});
