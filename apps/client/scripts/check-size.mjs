import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const [dir, limitArg] = process.argv.slice(2);
if (!dir || !limitArg) throw new Error('usage: node scripts/check-size.mjs <dir> <limitBytes>');
const limit = Number(limitArg);
if (!Number.isFinite(limit)) throw new Error(`invalid limit: ${limitArg}`);

async function jsFiles(root) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await jsFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(path);
  }
  return out.sort();
}

let total = 0;
for (const file of await jsFiles(dir)) {
  const bytes = gzipSync(await readFile(file), { level: 9 }).length;
  total += bytes;
  console.log(`${bytes}\t${relative(dir, file).split(sep).join('/')}`);
}
console.log(`JS gzip total: ${total} bytes (limit ${limit})`);
process.exitCode = total >= limit ? 1 : 0;
