import {
  DEVICE_VIEWPORT_HEIGHT,
  DEVICE_WIDTH,
  MAX_PAGE_HEIGHT,
  type Device,
  type HitBox,
} from '@hub/protocol';
import type { Frame, Page } from 'playwright';
import { buildDocument } from './html.js';

export interface CaptureJob {
  html: string;
  /** Used as given; callers apply cssForDevice first when they need the device's effective CSS. */
  css: string;
  device: Device;
}

export interface Capture {
  png: Buffer;
  width: number;
  height: number;
  hitMap: HitBox[];
}

/**
 * Runs inside Chromium via page.evaluate and returns the hit boxes of every `[data-d-id]` element
 * in paint order, so a later box paints on top of an earlier one. Kept as a string so no
 * transpiler rewrites it. It must not contain a backtick, a `${` or a backslash.
 *
 * Paint order follows CSS 2.1 Appendix E for the part of it that decides which node a tap hits.
 * Each element gets a sort key made of one `[layer, z, owner, self]` group per stacking context
 * on its way down from the root, so a whole stacking context sorts as one item among its siblings:
 *  - layer -1: negative z-index. 0: in-flow, non-positioned content. 1: positioned elements with
 *    z-index auto or 0, and stacking contexts that have no z-index (opacity, transform, ...), in
 *    tree order. 2: positive z-index.
 *  - A stacking context (root, fixed or sticky, positioned or flex/grid item with a z-index,
 *    opacity below 1, transform, filter, clip-path, mask, blend mode, isolation, contain, and the
 *    matching will-change) is an item in its parent context and the root of its own.
 *  - A positioned element without z-index is not a context, but it paints as one atomic layer-1
 *    item in the enclosing context: its in-flow content stays with it (its `owner`).
 * A box is dropped when an ancestor chain makes it invisible (visibility hidden or collapse, or any
 * ancestor with opacity 0) and is clipped to every ancestor whose overflow is not visible, along
 * the containing-block chain (an absolutely positioned element is clipped by its containing block
 * and above, not by overflow ancestors between them; a fixed element by none).
 *
 * Still approximated:
 *  - floats and inline-level content paint in DOM order with block content, not in their own layers
 *  - transformed or rotated boxes use their axis-aligned bounding box, and a transformed ancestor's
 *    clip is its border box
 *  - clip-path, mask, pointer-events and a scroll container's scrolled-out content are ignored
 *  - elements covered by an opaque sibling are still hittable; the hit map is not an occlusion map
 *  - other stacking context triggers (container-type, view-transition-name, top layer) are ignored
 */
export const HIT_MAP_SCRIPT = `(() => {
  const root = document.documentElement;
  const body = document.body;
  const order = new Map();
  let counter = 0;
  for (const e of document.getElementsByTagName('*')) order.set(e, counter++);

  const info = new Map();
  const infoOf = (el) => {
    let i = info.get(el);
    if (i) return i;
    const cs = getComputedStyle(el);
    const parent = el.parentElement;
    const parentDisplay = parent ? infoOf(parent).display : '';
    const positioned = cs.position !== 'static';
    const flexItem = parentDisplay.indexOf('flex') >= 0 || parentDisplay.indexOf('grid') >= 0;
    const zRaw = cs.zIndex;
    const z = (positioned || flexItem) && zRaw !== 'auto' ? parseInt(zRaw, 10) || 0 : null;
    const will = cs.willChange;
    const contain = cs.contain;
    const fx =
      cs.transform !== 'none' || cs.translate !== 'none' || cs.rotate !== 'none' || cs.scale !== 'none' ||
      cs.perspective !== 'none' || cs.filter !== 'none' || cs.backdropFilter !== 'none' ||
      contain.indexOf('layout') >= 0 || contain.indexOf('paint') >= 0 || contain.indexOf('strict') >= 0 || contain.indexOf('content') >= 0 ||
      will.indexOf('transform') >= 0 || will.indexOf('perspective') >= 0 || will.indexOf('filter') >= 0;
    const sc =
      el === root || cs.position === 'fixed' || cs.position === 'sticky' || z !== null || fx ||
      parseFloat(cs.opacity) < 1 || cs.clipPath !== 'none' || cs.maskImage !== 'none' ||
      cs.mixBlendMode !== 'normal' || cs.isolation === 'isolate' ||
      will.indexOf('opacity') >= 0 || will.indexOf('clip-path') >= 0 || will.indexOf('mask') >= 0 || will.indexOf('isolation') >= 0 || will.indexOf('mix-blend-mode') >= 0;
    i = {
      display: cs.display,
      pos: cs.position,
      positioned,
      sc,
      fx,
      layer: z === null || z === 0 ? 1 : z < 0 ? -1 : 2,
      z: z === null ? 0 : z,
      transparent: parseFloat(cs.opacity) === 0,
      hidden: cs.visibility !== 'visible',
      ox: cs.overflowX,
      oy: cs.overflowY,
    };
    info.set(el, i);
    return i;
  };

  const keyOf = (el) => {
    const contexts = [];
    for (let a = el; a; a = a.parentElement) if (a === root || infoOf(a).sc) contexts.push(a);
    contexts.reverse();
    const key = [];
    for (let i = 1; i < contexts.length; i++) {
      const c = contexts[i];
      const ci = infoOf(c);
      key.push(ci.layer, ci.z, order.get(c), 0);
    }
    const last = contexts[contexts.length - 1];
    if (el !== last) {
      let owner = null;
      for (let a = el; a !== last; a = a.parentElement) {
        if (infoOf(a).positioned) { owner = a; break; }
      }
      key.push(owner ? 1 : 0, 0, owner ? order.get(owner) : 0, order.get(el));
    }
    return key;
  };

  const nearest = (el, test) => {
    for (let a = el.parentElement; a; a = a.parentElement) if (test(infoOf(a))) return a;
    return null;
  };

  const clipsBox = (a) => {
    if (a === root) return false;
    const ai = infoOf(a);
    if (ai.display === 'inline' || ai.display === 'contents') return false;
    // The body's overflow moves to the viewport unless the root has its own.
    if (a === body) { const ri = infoOf(root); if (ri.ox === 'visible' && ri.oy === 'visible') return false; }
    return ai.ox !== 'visible' || ai.oy !== 'visible';
  };

  const out = [];
  for (const el of document.querySelectorAll('[data-d-id]')) {
    if (infoOf(el).hidden) continue;
    let invisible = false;
    for (let a = el; a; a = a.parentElement) if (infoOf(a).transparent) { invisible = true; break; }
    if (invisible) continue;
    const r = el.getBoundingClientRect();
    let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    if (x1 - x0 <= 0 || y1 - y0 <= 0) continue;
    let cur = el;
    while (cur !== root) {
      const ci = infoOf(cur);
      const anc =
        ci.pos === 'fixed' ? nearest(cur, (i) => i.fx)
        : ci.pos === 'absolute' ? nearest(cur, (i) => i.positioned || i.fx)
        : cur.parentElement;
      if (!anc) break;
      if (clipsBox(anc)) {
        const ai = infoOf(anc);
        const ar = anc.getBoundingClientRect();
        const pad = ai.fx ? { l: ar.left, t: ar.top, w: ar.width, h: ar.height } : { l: ar.left + anc.clientLeft, t: ar.top + anc.clientTop, w: anc.clientWidth, h: anc.clientHeight };
        if (ai.ox !== 'visible') { x0 = Math.max(x0, pad.l); x1 = Math.min(x1, pad.l + pad.w); }
        if (ai.oy !== 'visible') { y0 = Math.max(y0, pad.t); y1 = Math.min(y1, pad.t + pad.h); }
        if (x1 <= x0 || y1 <= y0) break;
      }
      cur = anc;
    }
    if (x1 <= x0 || y1 <= y0) continue;
    const x = Math.floor(x0 + scrollX), y = Math.floor(y0 + scrollY);
    out.push({ box: { nodeId: el.getAttribute('data-d-id'), x, y, w: Math.ceil(x1 + scrollX) - x, h: Math.ceil(y1 + scrollY) - y }, key: keyOf(el), at: order.get(el) });
  }
  out.sort((p, q) => {
    const n = Math.min(p.key.length, q.key.length);
    for (let i = 0; i < n; i++) if (p.key[i] !== q.key[i]) return p.key[i] - q.key[i];
    return p.key.length - q.key.length || p.at - q.at;
  });
  return out.map((e) => e.box);
})()`;

/** Matches a refresh that is scheduled but may not have fired when the load event does. */
const PENDING_REFRESH_SCRIPT = 'document.querySelector(\'meta[http-equiv="refresh" i]\') !== null';

const CONTEXT_DESTROYED = /Execution context was destroyed/;

const NAVIGATED = 'Page navigated during capture';

/**
 * Renders one page at one device width and returns a full-page PNG plus its hit map.
 *
 * Throws an Error starting "Page navigated during capture" when the main frame navigates (for
 * example through `<meta http-equiv=refresh>`), so the outcome never depends on a timing race.
 * A refresh that has not fired yet is detected in the DOM instead of waited for.
 */
export async function capturePage(page: Page, job: CaptureJob): Promise<Capture> {
  const mainFrame = page.mainFrame();
  let navigatedTo: string | null = null;
  const onNavigated = (frame: Frame): void => {
    if (frame === mainFrame) navigatedTo ??= frame.url();
  };
  page.on('framenavigated', onNavigated);
  const failIfNavigated = (): void => {
    if (navigatedTo !== null) throw new Error(`${NAVIGATED} (to ${navigatedTo})`);
  };
  try {
    return await captureLoaded(page, job, failIfNavigated);
  } catch (err) {
    // A navigation destroys the execution context, and that rejection can arrive before the
    // framenavigated event does, so the message counts as evidence of a navigation too.
    failIfNavigated();
    if (err instanceof Error && CONTEXT_DESTROYED.test(err.message)) {
      throw new Error(`${NAVIGATED} (execution context destroyed)`, { cause: err });
    }
    throw err;
  } finally {
    page.off('framenavigated', onNavigated);
  }
}

async function captureLoaded(page: Page, job: CaptureJob, failIfNavigated: () => void): Promise<Capture> {
  const d = job.device;
  await page.setViewportSize({ width: DEVICE_WIDTH[d], height: DEVICE_VIEWPORT_HEIGHT[d] });
  await page.setContent(buildDocument(job.html, job.css, d), { waitUntil: 'load' });
  failIfNavigated();
  if (await page.evaluate(PENDING_REFRESH_SCRIPT)) throw new Error(`${NAVIGATED} (pending <meta http-equiv="refresh">)`);
  await page.evaluate('document.fonts.ready.then(() => true)');

  const full = Number(
    await page.evaluate('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)'),
  );
  const width = DEVICE_WIDTH[d];
  const height = Math.min(MAX_PAGE_HEIGHT, Math.max(DEVICE_VIEWPORT_HEIGHT[d], full));

  // The script already returns boxes in paint order, clipped to their overflow ancestors.
  const hitMap = ((await page.evaluate(HIT_MAP_SCRIPT)) as HitBox[]).filter(
    (b) => b.x < width && b.y < height && b.x + b.w > 0 && b.y + b.h > 0,
  );

  const png = await page.screenshot({
    type: 'png',
    fullPage: true,
    clip: { x: 0, y: 0, width, height },
    animations: 'disabled',
    caret: 'hide',
  });
  failIfNavigated();

  return { png, width, height, hitMap };
}
