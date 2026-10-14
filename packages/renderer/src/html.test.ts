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

describe('buildDocument', () => {
  it('sets width and wraps the body', () => {
    const out = buildDocument('<p>x</p>', 'p{}', 'tablet');
    expect(out.startsWith('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=834">')).toBe(true);
    expect(out).toContain(BASE_CSS);
    expect(out.endsWith('<style>p{}</style></head><body><p>x</p></body></html>')).toBe(true);
  });

  it('escapes a closing style tag', () => {
    const out = buildDocument('', '--x{}</style><p>x</p>', 'base');
    expect(out).toContain('<\\/style><p>x</p>');
    expect((out.match(/<\/style>/g) ?? []).length).toBe(2);
  });
});
