import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { ADAPTERS_FILE, type SourceProject } from '@hub/sync';

const exec = promisify(execFile);
async function git(dir: string, args: string[]): Promise<string> {
  return (await exec('git', ['--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { maxBuffer: 2 * 1024 * 1024, timeout: 10_000 })).stdout;
}
const SKIPPED_DIRS = ['node_modules', 'design', 'dist', 'build'];
const visible = (file: string): boolean => !file.split('/').some((part) => part.startsWith('.') || SKIPPED_DIRS.includes(part));
const isSource = (file: string): boolean => /\.(tsx?|jsx?|css)$/.test(file) && visible(file);
/** Import configuration read as data: tsconfig files (path aliases) and the one hidden file allowed, the adapters. */
const isConfig = (file: string): boolean => file === ADAPTERS_FILE || (/(?:^|\/)tsconfig\.json$/.test(file) && visible(file));

/**
 * Read only tracked source and import configuration, without executing scripts, following links or reading secrets.
 * `config` holds tracked `tsconfig.json` files and `.hub/adapters.json`, which are parsed as data by the caller.
 */
export async function readSourceProject(dir: string): Promise<{ project: SourceProject; commit: string; config?: Record<string, string> }> {
  const root = await realpath(dir);
  const commit = (await git(root, ['rev-parse', 'HEAD'])).trim();
  // status/diff can invoke checkout-configured fsmonitor and clean filters. Read immutable
  // blobs instead; these plumbing commands do not execute checkout hooks or filters.
  const tree = (await git(root, ['ls-tree', '-r', '-z', '--full-tree', commit])).split('\0').filter(Boolean);
  const isRead = (file: string): boolean => isSource(file) || isConfig(file);
  const paths = tree.map((record) => {
    const match = /^(\d+) blob ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(record);
    return match ? { file: match[3]!, blob: match[2]! } : null;
  }).filter((entry): entry is { file: string; blob: string } => entry !== null && isRead(entry.file));
  const index = (await git(root, ['ls-files', '-s', '-z'])).split('\0').filter(Boolean).map((record) => {
    const match = /^\d+ ([a-f0-9]{40,64}) (\d)\t([\s\S]+)$/.exec(record);
    return match ? { file: match[3]!, blob: match[2] === '0' ? match[1]! : '' } : null;
  }).filter((entry): entry is { file: string; blob: string } => entry !== null && isRead(entry.file));
  if (JSON.stringify(index) !== JSON.stringify(paths)) throw new Error('Commit source changes before importing.');
  if (paths.length > 2000) throw new Error('Import is limited to 2,000 source files.');
  const files: Record<string, string> = {}, config: Record<string, string> = {};
  let total = 0;
  for (const { file, blob } of paths) {
    if (/[\\\x00-\x1f]/.test(file) || file.split('/').some((part) => part === '..' || part === '.' || part === '')) throw new Error('Invalid tracked source path');
    const target = join(root, file);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Source must be a regular file: ${file}`);
    const actual = await realpath(target);
    const rel = relative(root, actual);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Source escapes checkout: ${file}`);
    if (info.size > 1024 * 1024 || (total += info.size) > 8 * 1024 * 1024) throw new Error('Import source exceeds the 1 MB per-file or 8 MB total limit.');
    const source = await git(root, ['cat-file', 'blob', blob]);
    if (await readFile(target, 'utf8') !== source) throw new Error('Commit source changes before importing.');
    (isConfig(file) ? config : files)[file] = source;
  }
  if ((await git(root, ['rev-parse', 'HEAD'])).trim() !== commit) throw new Error('Source changed during import. Retry.');
  return { project: { files }, commit, config };
}
