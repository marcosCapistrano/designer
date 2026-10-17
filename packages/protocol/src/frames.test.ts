import { describe, expect, test } from 'vitest';
import {
  DEFAULT_FRAME_SIZES, FRAME_PRESETS, FRAME_GAP, ROW_GAP,
  tierForWidth, sizeKey, parseSizeKey, validateFrames, defaultFrames,
  type CanvasFrame, type FrameSize,
} from './index.js';

test('tierForWidth follows the media query breakpoints', () => {
  expect(tierForWidth(240)).toBe('mobile');
  expect(tierForWidth(599)).toBe('mobile');
  expect(tierForWidth(600)).toBe('tablet');
  expect(tierForWidth(1023)).toBe('tablet');
  expect(tierForWidth(1024)).toBe('base');
  expect(tierForWidth(3840)).toBe('base');
});

test('default sizes and presets', () => {
  expect(DEFAULT_FRAME_SIZES).toEqual([
    { width: 1440, viewportHeight: 900 },
    { width: 834, viewportHeight: 1194 },
    { width: 390, viewportHeight: 844 },
  ]);
  expect(FRAME_PRESETS).toHaveLength(10);
  expect(FRAME_PRESETS[0]).toEqual({ width: 1920, viewportHeight: 1080 });
  expect(FRAME_PRESETS[9]).toEqual({ width: 360, viewportHeight: 780 });
});

test('sizeKey and parseSizeKey', () => {
  expect(sizeKey({ width: 1600, viewportHeight: 900 })).toBe('1600x900');
  expect(parseSizeKey('1600x900')).toEqual({ width: 1600, viewportHeight: 900 });
  expect(parseSizeKey('base')).toBeNull();
  expect(parseSizeKey('100x900')).toBeNull();
  expect(parseSizeKey('1600x900x1')).toBeNull();
  expect(parseSizeKey('1600x319')).toBeNull();
});

describe('validateFrames', () => {
  const pages = new Set(['page-1', 'page-2']);
  const frame = (over: Partial<CanvasFrame> = {}): CanvasFrame => ({
    id: 'f0123456789abcdef', pageId: 'page-1', x: 0, y: 0, width: 1440, viewportHeight: 900, ...over,
  });
  const err = (v: unknown) => {
    const r = validateFrames(v, pages);
    return r.ok ? null : r.error;
  };

  test('accepts a valid list', () => {
    const frames = [frame(), frame({ id: 'fabcdefabcdefabcd', pageId: 'page-2', x: -5, y: 1_000_000 })];
    expect(validateFrames(frames, pages)).toEqual({ ok: true, frames });
  });

  test('rejects bad fields with indexed messages', () => {
    const ok = (n: number) => Array.from({ length: n }, (_, i) => frame({ id: `f${i.toString(16).padStart(16, '0')}` }));
    const at = (i: number, over: Partial<CanvasFrame>) => ok(i + 1).map((f, j) => (j === i ? { ...f, ...over } : f));
    expect(err(at(3, { width: 239 }))).toBe('frames[3].width must be an integer from 240 to 3840');
    expect(err(at(0, { width: 1600.5 }))).toBe('frames[0].width must be an integer from 240 to 3840');
    expect(err(at(1, { viewportHeight: 4001 }))).toBe('frames[1].viewportHeight must be an integer from 320 to 4000');
    expect(err(at(0, { x: 1_000_001 }))).toBe('frames[0].x must be an integer from -1000000 to 1000000');
    expect(err(at(2, { pageId: 'nope' }))).toBe('frames[2].pageId is not a page of this app');
    expect(err(at(0, { id: 'g0123456789abcdef' }))).toBe('frames[0].id must be f followed by 16 lowercase hex characters');
    expect(err(at(5, { id: ok(1)[0]!.id }))).toBe('frames[5].id duplicates frames[0].id');
    expect(err('x')).toBe('frames must be an array');
    expect(err([null])).toBe('frames[0] must be an object');
  });

  test('enforces count limits', () => {
    const many = (n: number, pageOf: (i: number) => string) =>
      Array.from({ length: n }, (_, i) => frame({ id: `f${i.toString(16).padStart(16, '0')}`, pageId: pageOf(i) }));
    expect(err(many(13, () => 'page-1'))).toBe('page page-1 has more than 12 frames');
    expect(validateFrames(many(12, () => 'page-1'), pages).ok).toBe(true);
    expect(err(many(601, (i) => (i % 2 ? 'page-1' : 'page-2')))).toBe('more than 600 frames');
  });
});

describe('defaultFrames', () => {
  const heightOf = (_p: string, s: FrameSize) => s.viewportHeight + 100;
  const counter = () => { let n = 0; return () => `f${(n++).toString(16).padStart(16, '0')}`; };

  test('lays out one row per page', () => {
    const out = defaultFrames([{ pageId: 'a' }, { pageId: 'b' }], [], heightOf, counter());
    expect(FRAME_GAP).toBe(80);
    expect(ROW_GAP).toBe(200);
    expect(out.map((f) => [f.pageId, f.x, f.y, f.width])).toEqual([
      ['a', 0, 0, 1440], ['a', 1520, 0, 834], ['a', 2434, 0, 390],
      ['b', 0, 1294 + 200, 1440], ['b', 1520, 1294 + 200, 834], ['b', 2434, 1294 + 200, 390],
    ]);
    expect(out.map((f) => f.id)).toEqual(Array.from({ length: 6 }, (_, i) => `f${i.toString(16).padStart(16, '0')}`));
  });

  test('keeps existing frames and places new rows below them', () => {
    const existing: CanvasFrame[] = [
      { id: 'faaaaaaaaaaaaaaaa', pageId: 'a', x: 40, y: 100, width: 1000, viewportHeight: 700 },
    ];
    const out = defaultFrames([{ pageId: 'a' }, { pageId: 'b' }], existing, heightOf, counter());
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(existing[0]);
    expect(out.slice(1).every((f) => f.pageId === 'b' && f.y === 100 + 800 + 200)).toBe(true);
    expect(out[1]!.x).toBe(0);
  });
});
