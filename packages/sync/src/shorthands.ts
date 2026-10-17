// Which longhands each CSS shorthand sets or resets. The design model sorts declarations on export, so two
// declarations that touch a common longhand must cascade in their sorted order, or the export changes the result.
// Leaves are physical longhands. A logical property names every physical longhand it can resolve to whatever the
// direction (inline-start is left or right), so the check holds in rtl documents too; block maps to top/bottom and
// inline-size to width, which assumes horizontal writing (css.ts fails on any other writing-mode).

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const LOGICAL: Record<string, readonly string[]> = {
  block: ['top', 'bottom'], inline: ['left', 'right'],
  'block-start': ['top'], 'block-end': ['bottom'], 'inline-start': ['left', 'right'], 'inline-end': ['left', 'right'],
};
const CORNERS: Record<string, readonly string[]> = {
  'start-start': ['top-left', 'top-right'], 'start-end': ['top-left', 'top-right'], 'end-start': ['bottom-left', 'bottom-right'], 'end-end': ['bottom-left', 'bottom-right'],
};
// Legacy names the browser parses as another property (besides `-webkit-X`, which is read as `X` below).
const ALIASES: Record<string, string> = {
  'word-wrap': 'overflow-wrap', 'font-width': 'font-stretch',
  'page-break-before': 'break-before', 'page-break-after': 'break-after', 'page-break-inside': 'break-inside',
  'column-break-before': 'break-before', 'column-break-after': 'break-after', 'column-break-inside': 'break-inside',
};

const TABLE = new Map<string, string[]>();
const define = (shorthand: string, longhands: string[]) => TABLE.set(shorthand, longhands);

for (const box of ['margin', 'padding', 'scroll-margin', 'scroll-padding']) {
  define(box, SIDES.map((side) => `${box}-${side}`));
  for (const [logical, sides] of Object.entries(LOGICAL)) define(`${box}-${logical}`, sides.map((side) => `${box}-${side}`));
}
define('inset', [...SIDES]);
for (const [logical, sides] of Object.entries(LOGICAL)) define(`inset-${logical}`, [...sides]);

const BORDER_PARTS = ['width', 'style', 'color'] as const;
const BORDER_IMAGE = ['border-image-source', 'border-image-slice', 'border-image-width', 'border-image-outset', 'border-image-repeat'];
define('border', [...SIDES.flatMap((side) => BORDER_PARTS.map((part) => `border-${side}-${part}`)), ...BORDER_IMAGE]);
define('border-image', BORDER_IMAGE);
for (const part of BORDER_PARTS) define(`border-${part}`, SIDES.map((side) => `border-${side}-${part}`));
for (const side of SIDES) define(`border-${side}`, BORDER_PARTS.map((part) => `border-${side}-${part}`));
for (const [logical, sides] of Object.entries(LOGICAL)) {
  define(`border-${logical}`, sides.flatMap((side) => BORDER_PARTS.map((part) => `border-${side}-${part}`)));
  for (const part of BORDER_PARTS) define(`border-${logical}-${part}`, sides.map((side) => `border-${side}-${part}`));
}
define('border-radius', ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((corner) => `border-${corner}-radius`));
for (const [logical, corners] of Object.entries(CORNERS)) define(`border-${logical}-radius`, corners.map((corner) => `border-${corner}-radius`));

define('outline', ['outline-color', 'outline-style', 'outline-width']);
define('background', ['background-color', 'background-image', 'background-position-x', 'background-position-y', 'background-size', 'background-repeat', 'background-attachment', 'background-origin', 'background-clip']);
define('background-position', ['background-position-x', 'background-position-y']);
const FONT_VARIANT = ['font-variant-caps', 'font-variant-ligatures', 'font-variant-numeric', 'font-variant-east-asian', 'font-variant-alternates', 'font-variant-position', 'font-variant-emoji'];
define('font', ['font-style', ...FONT_VARIANT, 'font-weight', 'font-stretch', 'font-size', 'line-height', 'font-family', 'font-size-adjust', 'font-kerning', 'font-optical-sizing', 'font-feature-settings', 'font-variation-settings', 'font-language-override', 'font-synthesis-weight', 'font-synthesis-style', 'font-synthesis-small-caps', 'font-synthesis-position']);
define('font-variant', FONT_VARIANT);
define('flex', ['flex-grow', 'flex-shrink', 'flex-basis']);
define('flex-flow', ['flex-direction', 'flex-wrap']);
define('grid', ['grid-template-rows', 'grid-template-columns', 'grid-template-areas', 'grid-auto-rows', 'grid-auto-columns', 'grid-auto-flow']);
define('grid-template', ['grid-template-rows', 'grid-template-columns', 'grid-template-areas']);
define('grid-area', ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end']);
define('grid-row', ['grid-row-start', 'grid-row-end']);
define('grid-column', ['grid-column-start', 'grid-column-end']);
define('gap', ['row-gap', 'column-gap']);
define('grid-gap', ['row-gap', 'column-gap']);
define('grid-row-gap', ['row-gap']);
define('grid-column-gap', ['column-gap']);
define('overflow', ['overflow-x', 'overflow-y']);
define('overflow-block', ['overflow-y']);
define('overflow-inline', ['overflow-x']);
define('list-style', ['list-style-type', 'list-style-position', 'list-style-image']);
define('animation', ['animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state', 'animation-timeline', 'animation-range-start', 'animation-range-end', 'animation-composition']);
define('animation-range', ['animation-range-start', 'animation-range-end']);
define('transition', ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay', 'transition-behavior']);
define('place-items', ['align-items', 'justify-items']);
define('place-content', ['align-content', 'justify-content']);
define('place-self', ['align-self', 'justify-self']);
define('columns', ['column-width', 'column-count']);
define('column-rule', ['column-rule-width', 'column-rule-style', 'column-rule-color']);
define('text-decoration', ['text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness']);
define('text-emphasis', ['text-emphasis-style', 'text-emphasis-color']);
define('white-space', ['white-space-collapse', 'text-wrap-mode']);
define('text-wrap', ['text-wrap-mode', 'text-wrap-style']);
define('mask', ['mask-image', 'mask-mode', 'mask-repeat', 'mask-position-x', 'mask-position-y', 'mask-clip', 'mask-origin', 'mask-size', 'mask-composite', 'mask-border-source', 'mask-border-slice', 'mask-border-width', 'mask-border-outset', 'mask-border-repeat', 'mask-border-mode']);
define('mask-position', ['mask-position-x', 'mask-position-y']);
define('mask-border', ['mask-border-source', 'mask-border-slice', 'mask-border-width', 'mask-border-outset', 'mask-border-repeat', 'mask-border-mode']);
define('container', ['container-name', 'container-type']);
define('contain-intrinsic-size', ['contain-intrinsic-width', 'contain-intrinsic-height']);
define('font-synthesis', ['font-synthesis-weight', 'font-synthesis-style', 'font-synthesis-small-caps', 'font-synthesis-position']);
define('overscroll-behavior', ['overscroll-behavior-x', 'overscroll-behavior-y']);
define('overscroll-behavior-inline', ['overscroll-behavior-x']);
define('overscroll-behavior-block', ['overscroll-behavior-y']);
define('marker', ['marker-start', 'marker-mid', 'marker-end']);
define('scroll-timeline', ['scroll-timeline-name', 'scroll-timeline-axis']);
define('view-timeline', ['view-timeline-name', 'view-timeline-axis', 'view-timeline-inset']);
define('text-box', ['text-box-trim', 'text-box-edge']);
define('text-stroke', ['text-stroke-width', 'text-stroke-color']);
define('position-try', ['position-try-order', 'position-try-fallbacks']);
// The logical sizing properties (horizontal writing).
for (const [prefix, axis] of [['', ''], ['min-', 'min-'], ['max-', 'max-']] as const) {
  define(`${prefix}inline-size`, [`${axis}width`]);
  define(`${prefix}block-size`, [`${axis}height`]);
}
define('contain-intrinsic-inline-size', ['contain-intrinsic-width']);
define('contain-intrinsic-block-size', ['contain-intrinsic-height']);
define('offset', ['offset-position', 'offset-path', 'offset-distance', 'offset-rotate', 'offset-anchor']);

/** The property a declaration is parsed as: `-webkit-X` as `X` (Chromium's prefixed aliases), legacy names as their successor. */
function canonical(property: string): string {
  const name = property.startsWith('-webkit-') ? property.slice(8) : property;
  return ALIASES[name] ?? name;
}

const cache = new Map<string, ReadonlySet<string>>();
/** The physical longhands a declaration of `property` may set: its table entry, or the property itself. */
export function longhands(property: string): ReadonlySet<string> {
  let found = cache.get(property);
  if (!found) {
    const own = canonical(property);
    const expand = (name: string): string[] => TABLE.has(name) ? TABLE.get(name)!.flatMap(expand) : [name];
    found = new Set(expand(own));
    cache.set(property, found);
  }
  return found;
}

// A single logical inline side or corner resolves to one physical longhand that depends on direction: it may set
// either, but is not known to set any one of them.
const EITHER = /(?:^|-)inline-(?:start|end)(?:-|$)|-(?:start|end)-(?:start|end)-radius$/;
const certain = new Map<string, ReadonlySet<string>>();
/** The physical longhands a declaration of `property` sets whatever the direction. */
export function definiteLonghands(property: string): ReadonlySet<string> {
  let found = certain.get(property);
  if (!found) {
    const expand = (name: string): string[] => EITHER.test(name) ? [] : TABLE.has(name) ? TABLE.get(name)!.flatMap(expand) : [name];
    found = new Set(expand(canonical(property)));
    certain.set(property, found);
  }
  return found;
}

/**
 * True when a later declaration of `later` resets every longhand an earlier declaration of `earlier` may set, so the
 * earlier one has no effect on the element and can be dropped without changing the result.
 */
export function resets(earlier: string, later: string): boolean {
  if (earlier === later || earlier.startsWith('--') || later.startsWith('--')) return false;
  if (later === 'all') return !['direction', 'unicode-bidi'].includes(earlier);
  if (earlier === 'all') return false;
  const covered = definiteLonghands(later);
  for (const longhand of longhands(earlier)) if (!covered.has(longhand)) return false;
  return true;
}

/** True when a declaration of one property sets or resets a longhand the other also sets. */
export function overlaps(a: string, b: string): boolean {
  if (a === b) return false;
  if (a.startsWith('--') || b.startsWith('--')) return false;
  // `all` resets every property except custom properties, direction and unicode-bidi.
  if (a === 'all' || b === 'all') return !['direction', 'unicode-bidi'].includes(a === 'all' ? b : a);
  const other = longhands(b);
  for (const longhand of longhands(a)) if (other.has(longhand)) return true;
  return false;
}
