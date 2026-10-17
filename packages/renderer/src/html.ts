import { DEVICE_WIDTH, type Device } from '@hub/protocol';

// Only html paints the canvas white: body stays transparent, so a page's html rule (Ruling P: the propagated
// background of a document-shell page) paints the whole canvas, as the source document's canvas would be.
export const BASE_CSS =
  'html,body{margin:0;padding:0;}html{background:#ffffff;}*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}';

const TABLET_PREFIX = '@media (max-width: 1023px){';
const MOBILE_PREFIX = '@media (max-width: 599px){';

/**
 * Drops the top-level media blocks that cannot apply at this device width, so the key
 * only changes when the device's effective CSS changes. Expects one top-level block per line.
 */
export function cssForDevice(css: string, device: Device): string {
  if (device === 'mobile') return css;
  const dropped = device === 'base' ? [TABLET_PREFIX, MOBILE_PREFIX] : [MOBILE_PREFIX];
  return css
    .split('\n')
    .filter((line) => !dropped.some((prefix) => line.startsWith(prefix)))
    .join('\n');
}

/**
 * Defense in depth for untrusted exported markup: only inline styles and data: images and fonts
 * may load, and frame-src 'none' stops an iframe from fetching a URL. The network is also aborted
 * at the context level and JS is off, so a blocked frame still commits Chromium's chrome-error
 * document, which is empty with JS off. First in head, it governs everything after it, including
 * both style elements. It does not stop `<meta http-equiv=refresh>`; capturePage handles that.
 */
export const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:; frame-src \'none\'">';

export function buildDocument(html: string, css: string, device: Device): string {
  const safeCss = css.replace(/<\/style/gi, '<\\/style');
  return (
    '<!doctype html><html><head>' +
    CSP_META +
    '<meta charset="utf-8"><meta name="viewport" content="width=' +
    DEVICE_WIDTH[device] +
    '"><style>' +
    BASE_CSS +
    '</style><style>' +
    safeCss +
    '</style></head><body>' +
    html +
    '</body></html>'
  );
}
