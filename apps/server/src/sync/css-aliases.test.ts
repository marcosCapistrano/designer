import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserPool } from '@hub/renderer';
import { definiteLonghands, longhands, PROPERTY_ALIASES, SHORTHANDS } from '@hub/sync';

// Pins the importer's CSS property table (packages/sync/src/shorthands.ts) to the renderer's Chromium. The importer
// drops a declaration a later one fully resets, so every alias and reset it assumes must hold in this browser.
let pool: BrowserPool;
beforeAll(() => { pool = new BrowserPool({ size: 1 }); });
afterAll(async () => { await pool.close(); });

/** Per name: the properties CSSOM sets for `name: inherit`, or null when Chromium does not parse the name. */
async function expansions(names: string[]): Promise<Record<string, string[] | null>> {
  return pool.withPage(async (page) => {
    await page.setContent('<div></div>');
    return page.evaluate((list) => Object.fromEntries(list.map((name) => {
      const probe = document.createElement('div');
      probe.style.setProperty(name, 'inherit');
      return [name, probe.style.length ? [...probe.style] : null];
    })), names);
  });
}

describe('importer CSS table against Chromium', () => {
  it('every alias shares its property with the name it is read as', async () => {
    const found = await expansions([...Object.keys(PROPERTY_ALIASES), ...Object.values(PROPERTY_ALIASES)]);
    const wrong = Object.entries(PROPERTY_ALIASES).filter(([alias, target]) => found[alias] === null || JSON.stringify(found[alias]) !== JSON.stringify(found[target]));
    expect(wrong).toEqual([]);
  });

  it('a shorthand resets in Chromium every longhand the importer drops for it', async () => {
    const found = await expansions([...SHORTHANDS.keys()]);
    const wrong = [...SHORTHANDS.keys()].flatMap((shorthand) => {
      const actual = new Set((found[shorthand] ?? []).flatMap((longhand) => [...longhands(longhand)]));
      const missing = [...definiteLonghands(shorthand)].filter((longhand) => !actual.has(longhand));
      return missing.length ? [`${shorthand}: ${missing.join(', ')}`] : [];
    });
    expect(wrong).toEqual([]);
  });

  it('-webkit-line-clamp, -webkit-border-image and -webkit-writing-mode are properties of their own', async () => {
    const found = await expansions(['-webkit-line-clamp', '-webkit-border-image', '-webkit-writing-mode', '-webkit-box-decoration-break']);
    for (const [name, set] of Object.entries(found)) expect(set, name).toEqual([name]);
    for (const name of Object.keys(found)) expect(Object.hasOwn(PROPERTY_ALIASES, name)).toBe(false);
  });
});
