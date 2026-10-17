import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_FRAME_SIZES } from '@hub/protocol';
import { BrowserPool, FsTileStore, renderDoc } from '@hub/renderer';
import { generateDoc } from './generate.js';

export interface FixtureOptions {
  pages: number;
  seed: number;
  out: string;
  /** Browser pages in use at once. Default 4. */
  poolSize?: number;
}

export interface FixtureSummary {
  pages: number;
  rendered: number;
  reused: number;
  failed: number;
}

export const DEFAULT_OUT = fileURLToPath(new URL('../.dev-renders', import.meta.url));

function intArg(flag: string, value: string, min: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${flag} must be an integer >= ${min}, got "${value}"`);
  }
  return n;
}

// Accepts `--flag value` pairs only.
export function parseArgs(argv: readonly string[]): FixtureOptions {
  const opts: FixtureOptions = { pages: 50, seed: 1, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    switch (flag) {
      case '--pages':
        opts.pages = intArg(flag, value, 1);
        break;
      case '--seed':
        opts.seed = intArg(flag, value, 0);
        break;
      case '--out':
        opts.out = resolve(process.cwd(), value);
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  return opts;
}

/** Renders the generated doc into `opts.out`, reusing renders whose content is unchanged. */
export async function renderFixtures(opts: FixtureOptions): Promise<FixtureSummary> {
  const poolSize = opts.poolSize ?? 4;
  const doc = generateDoc({ pages: opts.pages, seed: opts.seed });
  const store = new FsTileStore(opts.out);
  const prev = await store.readManifest();
  const pool = new BrowserPool({ size: poolSize });
  try {
    const res = await renderDoc(pool, doc, { sizes: () => DEFAULT_FRAME_SIZES, prev, store, concurrency: poolSize });
    await store.writeManifest(res.manifest);
    return {
      pages: Object.keys(doc.pages).length,
      rendered: res.rendered.length,
      reused: res.reused.length,
      failed: res.failed.length,
    };
  } finally {
    await pool.close();
  }
}

async function main(): Promise<void> {
  const summary = await renderFixtures(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary));
  if (summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
