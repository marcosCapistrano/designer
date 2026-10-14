import type { Device } from '@hub/protocol';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { capturePage } from './capture.js';
import { BrowserPool } from './pool.js';

let pool: BrowserPool;

beforeAll(() => {
  pool = new BrowserPool({ size: 1 });
});

afterAll(async () => {
  await pool.close();
});

const cap = (html: string, css: string, device: Device = 'base') =>
  pool.withPage((p) => capturePage(p, { html, css, device }));

test('full height at device width', async () => {
  const result = await cap('<main data-d-id="a"></main>', '[data-d-id="a"]{height:2000px}');
  expect(result.width).toBe(1440);
  expect(result.height).toBe(2000);
  const meta = await sharp(result.png).metadata();
  expect(meta.width).toBe(1440);
  expect(meta.height).toBe(2000);
});

test('short page uses the device viewport height', async () => {
  const result = await cap('<main data-d-id="a"></main>', '[data-d-id="a"]{height:100px}', 'mobile');
  expect({ width: result.width, height: result.height }).toEqual({ width: 390, height: 844 });
});

test('caps very tall pages', async () => {
  const result = await cap(
    '<main data-d-id="a"></main><div data-d-id="b">end</div>',
    '[data-d-id="a"]{height:20000px}',
  );
  expect(result.height).toBe(16000);
  const meta = await sharp(result.png).metadata();
  expect(meta.height).toBe(16000);
  expect(result.hitMap.map((b) => b.nodeId)).not.toContain('b');
});

test('boxes in page px', async () => {
  const result = await cap(
    '<main data-d-id="a"><div data-d-id="b"></div></main>',
    '[data-d-id="a"]{padding:10px}[data-d-id="b"]{width:100px;height:50px;margin-left:5px}',
  );
  expect(result.hitMap).toContainEqual({ nodeId: 'b', x: 15, y: 10, w: 100, h: 50 });
  expect(result.hitMap).toContainEqual({ nodeId: 'a', x: 0, y: 0, w: 1440, h: 70 });
});

test('z-indexed elements come last', async () => {
  const result = await cap(
    '<main data-d-id="a"><div data-d-id="b"></div><div data-d-id="c"></div></main>',
    '[data-d-id="a"]{position:relative}[data-d-id="b"]{position:absolute;z-index:5;top:0;left:0;width:50px;height:50px}[data-d-id="c"]{height:100px}',
  );
  expect(result.hitMap.map((b) => b.nodeId)).toEqual(['a', 'c', 'b']);
});

test('skips hidden and empty elements', async () => {
  const result = await cap(
    '<main data-d-id="a"><div data-d-id="h1"></div><div data-d-id="h2">x</div><div data-d-id="h3">y</div></main>',
    '[data-d-id="h2"]{display:none}[data-d-id="h3"]{visibility:hidden}',
  );
  expect(result.hitMap.map((b) => b.nodeId)).toEqual(['a']);
});

test('tablet media query applies at 834px', async () => {
  const css = '[data-d-id="b"]{width:100px;height:10px}\n@media (max-width: 1023px){[data-d-id="b"]{width:200px;}}';
  const html = '<div data-d-id="b"></div>';
  const tablet = await cap(html, css, 'tablet');
  const base = await cap(html, css, 'base');
  expect(tablet.hitMap.find((b) => b.nodeId === 'b')?.w).toBe(200);
  expect(base.hitMap.find((b) => b.nodeId === 'b')?.w).toBe(100);
});

test('blocks network and scripts', async () => {
  await pool.withPage(async (p) => {
    await capturePage(p, {
      html: '<img data-d-id="i" src="https://example.invalid/x.png" width="10" height="10"><script>document.body.setAttribute("data-ran","1")</script>',
      css: '',
      device: 'base',
    });
    expect(await p.evaluate('document.body.getAttribute("data-ran")')).toBeNull();
  });
});
