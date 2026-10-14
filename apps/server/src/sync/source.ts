import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { SourceProject } from '@hub/sync';

const exec = promisify(execFile);
async function git(dir: string, args: string[]): Promise<string> {
  return (await exec('git', ['-C', dir, ...args], { maxBuffer: 2 * 1024 * 1024, timeout: 10_000 })).stdout;
}
/** Read only tracked source, without executing scripts, following links or reading secrets. */
export async function readSourceProject(dir: string): Promise<{ project: SourceProject; commit: string }> {
  const root = await realpath(dir);
  const commit = (await git(root, ['rev-parse', 'HEAD'])).trim();
  if ((await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim()) throw new Error('Commit source changes before importing.');
  const paths = (await git(root, ['ls-files', '-z'])).split('\0').filter((file) => /\.(tsx?|jsx?|css)$/.test(file) && !file.split('/').some((part) => part.startsWith('.') || ['node_modules', 'design', 'dist', 'build'].includes(part)));
  if (paths.length > 2000) throw new Error('Import is limited to 2,000 source files.');
  const files: Record<string, string> = {};
  let total = 0;
  for (const file of paths) {
    if (file.includes('\\') || file.split('/').some((part) => part === '..' || part === '.' || part === '')) throw new Error('Invalid tracked source path');
    const target = join(root, file);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Source must be a regular file: ${file}`);
    const actual = await realpath(target);
    const rel = relative(root, actual);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Source escapes checkout: ${file}`);
    if (info.size > 1024 * 1024 || (total += info.size) > 8 * 1024 * 1024) throw new Error('Import source exceeds the 1 MB per-file or 8 MB total limit.');
    files[file] = await readFile(target, 'utf8');
  }
  if ((await git(root, ['rev-parse', 'HEAD'])).trim() !== commit || (await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim()) throw new Error('Source changed during import. Retry.');
  return { project: { files }, commit };
}
