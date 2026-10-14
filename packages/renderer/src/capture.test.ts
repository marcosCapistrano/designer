import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device } from '@hub/protocol';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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

describe('hostile document tags', () => {
  const NAVIGATED = 'Page navigated during capture';

  const failsNavigated = async (html: string): Promise<void> => {
    const err: unknown = await cap(html, '').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.startsWith(NAVIGATED)).toBe(true);
  };

  // Each case runs three times: the old behaviour raced between "Execution context was destroyed"
  // and a successful capture, so one lucky pass proves nothing.
  test.each([
    ['immediate meta refresh to about:blank', '<meta http-equiv="refresh" content="0;url=about:blank"><p data-d-id="a">x</p>'],
    ['delayed meta refresh', '<meta data-d-id="m" http-equiv="refresh" content="1"><p data-d-id="a">x</p>'],
    ['upper-case meta refresh', '<meta HTTP-EQUIV="REFRESH" content="5;url=about:blank"><p data-d-id="a">x</p>'],
  ])('%s fails with a navigation error every time', async (_name, html) => {
    for (let i = 0; i < 3; i++) await failsNavigated(html);
  });

  test('a navigation error does not poison the pool', async () => {
    await failsNavigated('<meta http-equiv="refresh" content="0;url=about:blank">');
    const result = await cap('<main data-d-id="a">ok</main>', '');
    expect(result.hitMap.map((b) => b.nodeId)).toEqual(['a']);
  });

  const regionPixels = async (png: Buffer, box: { x: number; y: number; w: number; h: number }) => {
    const { data, info } = await sharp(png)
      .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const out: Array<[number, number, number]> = [];
    for (let i = 0; i < data.length; i += info.channels) out.push([data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0]);
    return out;
  };

  test('an http iframe renders blank, not an error page', async () => {
    const result = await cap(
      '<iframe data-d-id="f" src="https://example.com/" style="display:block;border:0;width:300px;height:200px"></iframe>',
      '',
    );
    const box = result.hitMap.find((b) => b.nodeId === 'f');
    expect(box).toEqual({ nodeId: 'f', x: 0, y: 0, w: 300, h: 200 });
    const pixels = await regionPixels(result.png, box as NonNullable<typeof box>);
    expect(pixels.every(([r, g, b]) => r === 255 && g === 255 && b === 255)).toBe(true);
  });

  test('a data: stylesheet link is blocked by the document policy', async () => {
    const css = encodeURIComponent('[data-d-id="a"]{background:#ff0000}');
    const result = await cap(
      `<link rel="stylesheet" href="data:text/css,${css}"><div data-d-id="a" style="width:40px;height:40px"></div>`,
      '',
    );
    const box = result.hitMap.find((b) => b.nodeId === 'a') as NonNullable<(typeof result.hitMap)[number]>;
    const pixels = await regionPixels(result.png, box);
    expect(pixels.every(([r, g, b]) => r === 255 && g === 255 && b === 255)).toBe(true);
  });

  test('data: images, inline style attributes and style elements still apply', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00ff00' } }).png().toBuffer();
    const result = await cap(
      `<img data-d-id="i" src="data:image/png;base64,${png.toString('base64')}" width="8" height="8" style="display:block"><div data-d-id="s" style="width:10px;height:10px;background:#0000ff"></div><div data-d-id="c"></div>`,
      '[data-d-id="c"]{width:10px;height:10px;background:#ff0000}',
    );
    const at = async (id: string) => {
      const box = result.hitMap.find((b) => b.nodeId === id) as NonNullable<(typeof result.hitMap)[number]>;
      return (await regionPixels(result.png, { ...box, w: 1, h: 1, x: box.x + 2, y: box.y + 2 }))[0];
    };
    expect(await at('i')).toEqual([0, 255, 0]);
    expect(await at('s')).toEqual([0, 0, 255]);
    expect(await at('c')).toEqual([255, 0, 0]);
  });

  describe('file:// sources', () => {
    let dir: string;
    let imgUrl: string;
    let frameUrl: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'renderer-file-'));
      const img = join(dir, 'red.png');
      await writeFile(img, await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ff0000' } }).png().toBuffer());
      const frame = join(dir, 'frame.html');
      await writeFile(frame, '<!doctype html><body style="margin:0;background:#ff0000"><div style="width:100px;height:100px"></div>');
      imgUrl = 'file://' + img;
      frameUrl = 'file://' + frame;
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const hasRed = (pixels: Array<[number, number, number]>) => pixels.some(([r, g, b]) => r > 200 && g < 50 && b < 50);

    test('an img never loads', async () => {
      await pool.withPage(async (p) => {
        const result = await capturePage(p, {
          html: `<img data-d-id="i" src="${imgUrl}" width="20" height="20" style="display:block">`,
          css: '',
          device: 'base',
        });
        expect(await p.evaluate('document.images[0].naturalWidth')).toBe(0);
        const box = result.hitMap.find((b) => b.nodeId === 'i') as NonNullable<(typeof result.hitMap)[number]>;
        expect(hasRed(await regionPixels(result.png, box))).toBe(false);
      });
    });

    test('an iframe never loads', async () => {
      await pool.withPage(async (p) => {
        const result = await capturePage(p, {
          html: `<iframe data-d-id="f" src="${frameUrl}" style="display:block;border:0;width:100px;height:100px"></iframe>`,
          css: '',
          device: 'base',
        });
        expect(p.frames().map((f) => f.url())).not.toContain(frameUrl);
        const box = result.hitMap.find((b) => b.nodeId === 'f') as NonNullable<(typeof result.hitMap)[number]>;
        expect(hasRed(await regionPixels(result.png, box))).toBe(false);
      });
    });
  });
});
