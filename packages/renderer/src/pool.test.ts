import { afterEach, expect, test } from 'vitest';
import { BrowserPool } from './pool.js';

const pools: BrowserPool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

function track(pool: BrowserPool): BrowserPool {
  pools.push(pool);
  return pool;
}

test('runs at most size pages at once and launches once', async () => {
  const pool = track(new BrowserPool({ size: 2 }));
  let busyMax = 0;
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => pool.withPage(async (page) => {
    busyMax = Math.max(busyMax, pool.stats().busy);
    await new Promise((r) => setTimeout(r, 50));
    return page.evaluate('1 + 1');
  })));
  expect(results).toEqual([2, 2, 2, 2, 2]);
  expect(busyMax).toBe(2);
  expect(pool.stats().launches).toBe(1);
  await pool.close();
});

test('recovers after the browser disconnects', async () => {
  const pool = track(new BrowserPool());
  // Either outcome is fine: the job may resolve or reject once its own browser is gone.
  await pool.withPage(async (page) => {
    await page.context().browser()!.close();
  }).catch(() => undefined);
  expect(await pool.withPage((page) => page.evaluate('2 + 2'))).toBe(4);
  expect(pool.stats().launches).toBe(2);
  await pool.close();
});

test('a throwing job does not poison the pool', async () => {
  const pool = track(new BrowserPool({ size: 1 }));
  await expect(pool.withPage(async () => {
    throw new Error('boom');
  })).rejects.toThrow('boom');
  expect(await pool.withPage((page) => page.evaluate('3'))).toBe(3);
  expect(pool.stats().busy).toBe(0);
  await pool.close();
});

test('close rejects new work', async () => {
  const pool = track(new BrowserPool());
  await pool.close();
  await expect(pool.withPage(async () => 1)).rejects.toThrow('BrowserPool is closed');
});
