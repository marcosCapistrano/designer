import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device } from '@hub/protocol';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { exportPage, type DesignDoc } from '@hub/design-model';
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

describe('hit map paint order', () => {
  const order = (r: Awaited<ReturnType<typeof cap>>) => r.hitMap.map((b) => b.nodeId);

  test('a positioned z-index:auto element comes after later in-flow siblings', async () => {
    const result = await cap(
      '<main data-d-id="a"><div data-d-id="badge"></div><div data-d-id="flow"></div></main>',
      '[data-d-id="badge"]{position:absolute;top:0;left:0;width:50px;height:50px}[data-d-id="flow"]{height:100px}',
    );
    expect(order(result)).toEqual(['a', 'flow', 'badge']);
  });

  test('a relative z-index:auto element comes after later in-flow siblings, in tree order among positioned ones', async () => {
    const result = await cap(
      '<main data-d-id="a"><div data-d-id="p1"></div><div data-d-id="flow"></div><div data-d-id="p2"></div></main>',
      '[data-d-id="p1"],[data-d-id="p2"]{position:relative;height:20px}[data-d-id="flow"]{height:20px}',
    );
    expect(order(result)).toEqual(['a', 'flow', 'p1', 'p2']);
  });

  test('in-flow content of a positioned element stays with it, and a z-index:0 element ties in tree order', async () => {
    const result = await cap(
      '<main data-d-id="a"><div data-d-id="p1"><span data-d-id="inner"></span></div><div data-d-id="z0"></div><div data-d-id="flow"></div></main>',
      '[data-d-id="p1"]{position:relative;height:20px}[data-d-id="inner"]{display:block;height:5px}[data-d-id="z0"]{position:relative;z-index:0;height:20px}[data-d-id="flow"]{height:20px}',
    );
    expect(order(result)).toEqual(['a', 'flow', 'p1', 'inner', 'z0']);
  });

  test('a stacking context keeps its whole subtree below a higher sibling context', async () => {
    const result = await cap(
      '<main data-d-id="a"><div data-d-id="low"><div data-d-id="deep"></div></div><div data-d-id="high"></div></main>',
      '[data-d-id="low"]{position:relative;z-index:1;height:50px}[data-d-id="deep"]{position:absolute;z-index:9;top:0;left:0;width:10px;height:10px}[data-d-id="high"]{position:relative;z-index:3;height:50px}',
    );
    expect(order(result)).toEqual(['a', 'low', 'deep', 'high']);
  });

  test('negative z-index comes before in-flow content', async () => {
    const result = await cap(
      '<main data-d-id="a"><div data-d-id="flow"></div><div data-d-id="behind"></div></main>',
      '[data-d-id="flow"]{height:20px}[data-d-id="behind"]{position:absolute;z-index:-1;top:0;left:0;width:10px;height:10px}',
    );
    expect(order(result)).toEqual(['behind', 'a', 'flow']);
  });

  test('opacity creates a stacking context that paints with the z-index:0 layer', async () => {
    const result = await cap(
      '<main data-d-id="a"><div data-d-id="faded"></div><div data-d-id="flow"></div></main>',
      '[data-d-id="faded"]{opacity:0.5;height:20px}[data-d-id="flow"]{height:20px}',
    );
    expect(order(result)).toEqual(['a', 'flow', 'faded']);
  });
});

describe('hit map visibility', () => {
  test('opacity:0 elements and their subtree are not hittable', async () => {
    const result = await cap(
      '<main data-d-id="a"><div data-d-id="ghost"><div data-d-id="ghost-child"></div></div><div data-d-id="faint"></div></main>',
      '[data-d-id="ghost"]{opacity:0;height:30px}[data-d-id="ghost-child"]{height:10px}[data-d-id="faint"]{opacity:0.01;height:30px}',
    );
    expect(result.hitMap.map((b) => b.nodeId).sort()).toEqual(['a', 'faint']);
  });

  test('a visible child of a visibility:hidden parent stays hittable', async () => {
    const result = await cap(
      '<main data-d-id="a"><div data-d-id="hid"><div data-d-id="shown"></div></div></main>',
      '[data-d-id="hid"]{visibility:hidden;height:30px}[data-d-id="shown"]{visibility:visible;height:10px}',
    );
    expect(result.hitMap.map((b) => b.nodeId).sort()).toEqual(['a', 'shown']);
  });
});

describe('hit map overflow clipping', () => {
  const box = (r: Awaited<ReturnType<typeof cap>>, id: string) => r.hitMap.find((b) => b.nodeId === id);

  test('a box is clipped to an overflow:hidden ancestor', async () => {
    const result = await cap(
      '<main data-d-id="a"><div data-d-id="child"></div></main>',
      '[data-d-id="a"]{overflow:hidden;width:100px;height:60px;padding:10px;border:5px solid #000}[data-d-id="child"]{width:300px;height:300px}',
    );
    // The clip is the padding box (x 5 to 125, y 5 to 85); the child starts at the content box, 15,15.
    expect(box(result, 'child')).toEqual({ nodeId: 'child', x: 15, y: 15, w: 110, h: 70 });
    expect(box(result, 'a')).toEqual({ nodeId: 'a', x: 0, y: 0, w: 130, h: 90 });
  });

  test('a box entirely outside the clip is dropped', async () => {
    const result = await cap(
      '<main data-d-id="a"><div data-d-id="out"></div><div data-d-id="in"></div></main>',
      '[data-d-id="a"]{overflow:hidden;width:100px;height:50px}[data-d-id="out"]{margin-left:200px;width:50px;height:20px}[data-d-id="in"]{width:50px;height:20px}',
    );
    expect(result.hitMap.map((b) => b.nodeId).sort()).toEqual(['a', 'in']);
  });

  test('clips intersect across nested ancestors', async () => {
    const result = await cap(
      '<main data-d-id="a"><div data-d-id="mid"><div data-d-id="leaf"></div></div></main>',
      '[data-d-id="a"]{overflow:hidden;width:200px;height:200px}[data-d-id="mid"]{overflow:clip;margin:20px 0 0 30px;width:100px;height:100px}[data-d-id="leaf"]{width:500px;height:500px}',
    );
    expect(box(result, 'mid')).toEqual({ nodeId: 'mid', x: 30, y: 20, w: 100, h: 100 });
    expect(box(result, 'leaf')).toEqual({ nodeId: 'leaf', x: 30, y: 20, w: 100, h: 100 });
  });

  test('overflow:auto and overflow:scroll clip as well', async () => {
    const result = await cap(
      '<main data-d-id="a"><div data-d-id="s"><div data-d-id="sc"></div></div><div data-d-id="t"><div data-d-id="tc"></div></div></main>',
      '[data-d-id="s"]{overflow:auto;width:80px;height:40px}[data-d-id="t"]{overflow:scroll;width:60px;height:30px}[data-d-id="sc"],[data-d-id="tc"]{width:400px;height:400px}',
    );
    expect(box(result, 'sc')).toMatchObject({ w: 80, h: 40 });
    expect(box(result, 'tc')).toMatchObject({ w: 60, h: 30 });
  });

  test('an absolute child escapes an overflow ancestor that is not its containing block', async () => {
    const result = await cap(
      '<main data-d-id="a"><div data-d-id="clip"><div data-d-id="abs"></div></div></main>',
      '[data-d-id="a"]{position:relative;height:300px}[data-d-id="clip"]{overflow:hidden;width:50px;height:50px}[data-d-id="abs"]{position:absolute;top:100px;left:100px;width:40px;height:40px}',
    );
    expect(box(result, 'abs')).toEqual({ nodeId: 'abs', x: 100, y: 100, w: 40, h: 40 });
  });

  test('an absolute child is clipped by a positioned overflow ancestor', async () => {
    const result = await cap(
      '<main data-d-id="a"><div data-d-id="clip"><div data-d-id="abs"></div><div data-d-id="gone"></div></div></main>',
      '[data-d-id="clip"]{position:relative;overflow:hidden;width:50px;height:50px}[data-d-id="abs"]{position:absolute;top:30px;left:30px;width:40px;height:40px}[data-d-id="gone"]{position:absolute;top:80px;left:0;width:10px;height:10px}',
    );
    expect(box(result, 'abs')).toEqual({ nodeId: 'abs', x: 30, y: 30, w: 20, h: 20 });
    expect(box(result, 'gone')).toBeUndefined();
  });

  test('a fixed element is not clipped by overflow ancestors', async () => {
    const result = await cap(
      '<main data-d-id="a"><div data-d-id="clip"><div data-d-id="fixed"></div></div></main>',
      '[data-d-id="clip"]{overflow:hidden;width:50px;height:50px}[data-d-id="fixed"]{position:fixed;top:100px;left:100px;width:40px;height:40px}',
    );
    expect(box(result, 'fixed')).toEqual({ nodeId: 'fixed', x: 100, y: 100, w: 40, h: 40 });
  });

  test('body overflow propagates to the viewport and does not clip', async () => {
    const result = await cap(
      '<div data-d-id="tall"></div>',
      'body{overflow:hidden;height:50px}[data-d-id="tall"]{height:200px}',
    );
    expect(box(result, 'tall')).toEqual({ nodeId: 'tall', x: 0, y: 0, w: 1440, h: 200 });
  });

  test('an inline element with overflow set does not clip', async () => {
    const result = await cap(
      '<main data-d-id="a"><span data-d-id="i" style="overflow:hidden"><div data-d-id="blk" style="width:50px;height:20px"></div></span></main>',
      '',
    );
    expect(box(result, 'blk')).toMatchObject({ w: 50, h: 20 });
  });
});

test('skips hidden and empty elements', async () => {
  const result = await cap(
    '<main data-d-id="a"><div data-d-id="h1"></div><div data-d-id="h2">x</div><div data-d-id="h3">y</div></main>',
    '[data-d-id="h2"]{display:none}[data-d-id="h3"]{visibility:hidden}',
  );
  expect(result.hitMap.map((b) => b.nodeId)).toEqual(['a']);
});

// Ruling P: an imported page whose root was the source html element renders like the source document.
test('a document-shell page resolves rem against the html font-size and paints the canvas with the body background', async () => {
  const doc: DesignDoc = {
    meta: { version: 1, seq: 1 }, components: {}, tokens: {},
    pages: { home: { id: 'home', name: 'Home', route: '/', root: {
      id: 'h', kind: 'element', tag: 'div', attrs: { 'data-d-shell': 'html' }, style: { base: { 'font-size': '62.5%' } },
      children: [{ id: 'b', kind: 'element', tag: 'div', attrs: {}, style: { base: { 'background-color': 'rgb(0, 0, 255)', margin: '20px' } }, children: [
        { id: 'x', kind: 'element', tag: 'p', attrs: {}, style: { base: { 'font-size': '1.6rem', width: '10em', height: '1em', margin: '0' } }, children: [] },
      ] }],
    } } },
  };
  const exported = exportPage(doc, 'home');
  if (!exported.ok) throw new Error(exported.error);
  const result = await cap(exported.value.html, exported.value.css);
  const x = result.hitMap.find((b) => b.nodeId === 'x');
  expect({ w: x?.w, h: x?.h }).toEqual({ w: 160, h: 16 });
  // Below the content and inside body's margin, as the source browser paints them: the propagated body background.
  for (const [left, top] of [[700, 800], [5, 25]] as const) {
    const pixel = await sharp(result.png).extract({ left, top, width: 1, height: 1 }).raw().toBuffer();
    expect([...pixel.subarray(0, 3)]).toEqual([0, 0, 255]);
  }
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
