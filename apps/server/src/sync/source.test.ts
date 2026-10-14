import { dirname, join } from 'node:path';
import { symlinkSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTestRepo, git } from '../git/test-repo.js';
import { readSourceProject } from './source.js';
describe('source checkout reading', () => {
  it('reads tracked source, excludes hidden files and does not execute modules', async () => {
    const repo = makeTestRepo({ files: { 'page.tsx': 'throw new Error("must not execute")', '.env': 'SECRET', 'node_modules/pkg.ts': 'ignored', 'README.md': 'notes' } });
    writeFileSync(join(repo.work, 'untracked.tsx'), 'not part of the source commit');
    const out = await readSourceProject(repo.work);
    expect(out.project.files).toEqual({ 'page.tsx': 'throw new Error("must not execute")' });
    expect(out.commit).toMatch(/^[a-f0-9]{40}$/);
  });
  it('refuses uncommitted changes and tracked source symlinks', async () => {
    const repo = makeTestRepo({ files: { 'page.tsx': 'export default () => <main />' } });
    writeFileSync(join(repo.work, 'page.tsx'), 'changed');
    await expect(readSourceProject(repo.work)).rejects.toThrow('Commit source changes');
    git(repo.work, 'add', '.'); git(repo.work, 'commit', '-m', 'change');
    writeFileSync(join(dirname(repo.work), 'secret.tsx'), 'secret');
    symlinkSync('../secret.tsx', join(repo.work, 'linked.tsx'));
    git(repo.work, 'add', '.'); git(repo.work, 'commit', '-m', 'link');
    await expect(readSourceProject(repo.work)).rejects.toThrow('regular file');
  });
});
