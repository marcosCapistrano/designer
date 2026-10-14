import { DEVICE_WIDTH, type Device } from '@hub/protocol';

export const BASE_CSS =
  'html,body{margin:0;padding:0;background:#ffffff;}*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}';

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

export function buildDocument(html: string, css: string, device: Device): string {
  const safeCss = css.replace(/<\/style/gi, '<\\/style');
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=' +
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
