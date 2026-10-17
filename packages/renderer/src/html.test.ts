import { describe, expect, it } from 'vitest';
import { BASE_CSS, buildDocument, cssForDevice } from './html.js';

const CSS = ':root{--c:#fff;}\n[data-d-id="n1"]{padding:8px;}\n@media (max-width: 1023px){[data-d-id="n1"]{padding:6px;}}\n@media (max-width: 599px){[data-d-id="n1"]{padding:4px;}}';

describe('cssForDevice', () => {
  it('base drops both media blocks', () => {
    expect(cssForDevice(CSS, 'base')).toBe(':root{--c:#fff;}\n[data-d-id="n1"]{padding:8px;}');
  });

  it('tablet keeps only the tablet block', () => {
    expect(cssForDevice(CSS, 'tablet')).toBe(
      ':root{--c:#fff;}\n[data-d-id="n1"]{padding:8px;}\n@media (max-width: 1023px){[data-d-id="n1"]{padding:6px;}}',
    );
  });

  it('mobile keeps everything', () => {
    expect(cssForDevice(CSS, 'mobile')).toBe(CSS);
  });

  it('media-only css on base is empty', () => {
    expect(cssForDevice('@media (max-width: 599px){a{color:red;}}', 'base')).toBe('');
  });
});

const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:; frame-src \'none\'">';

describe('buildDocument', () => {
  it('puts the Content-Security-Policy meta first in head', () => {
    for (const width of [1440, 834, 390]) {
      expect(buildDocument('<p>x</p>', 'p{}', width).startsWith('<!doctype html><html><head>' + CSP_META)).toBe(true);
    }
  });

  it('sets width and wraps the body', () => {
    const out = buildDocument('<p>x</p>', 'p{}', 834);
    expect(out.startsWith('<!doctype html><html><head>' + CSP_META + '<meta charset="utf-8"><meta name="viewport" content="width=834">')).toBe(true);
    expect(out).toContain(BASE_CSS);
    expect(out.endsWith('<style>p{}</style></head><body><p>x</p></body></html>')).toBe(true);
  });

  it('escapes a closing style tag', () => {
    const out = buildDocument('', '--x{}</style><p>x</p>', 1440);
    expect(out).toContain('<\\/style><p>x</p>');
    expect((out.match(/<\/style>/g) ?? []).length).toBe(2);
  });

  it('paints the canvas from html only, so a page html rule propagates and body never covers it (Ruling P)', () => {
    // Canvas is white under the default scheme and follows a propagated color-scheme.
    expect(BASE_CSS).toContain('html{background:Canvas;}');
    expect(BASE_CSS).not.toMatch(/body[^{]*\{[^}]*background/);
    const out = buildDocument('<div data-d-id="h" data-d-shell="html"></div>', 'html{background:red;font-size:62.5%;}', 'base');
    expect(out.indexOf(BASE_CSS)).toBeLessThan(out.indexOf('html{background:red;font-size:62.5%;}'));
  });
});
