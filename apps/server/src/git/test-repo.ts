import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitEnv, type GitIdentity } from './git.js';

export const TEST_IDENTITY: GitIdentity = { name: 'Hub Test', email: 'hub-test@example.com' };
export const TEST_REMOTE = 'https://github.com/acme/demo.git';

export interface TestRepo {
  origin: string;
  work: string;
}

/**
 * Runs git for a test. Output is piped, so git's progress and warnings stay out of the test log (they are in the
 * error message when git fails), and the machine's global git config cannot change what a test sees.
 */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...gitEnv(TEST_IDENTITY), GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

function writeRepoFile(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/**
 * Creates a local bare "origin" seeded with README.md (and opts.files), then clones it to `work`.
 * `work` reads like GitHub (origin = TEST_REMOTE), and `insteadOf` routes its fetch and push to the local bare repo.
 * Everything lives under a fresh mkdtemp directory in os.tmpdir(); callers remove dirname(origin).
 */
export function makeTestRepo(opts: { workDir?: string; files?: Record<string, string> } = {}): TestRepo {
  const tmp = mkdtempSync(join(tmpdir(), 'hub-git-'));
  const origin = join(tmp, 'origin.git');
  git(tmp, 'init', '--bare', '-b', 'main', origin);

  const seed = join(tmp, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  writeRepoFile(seed, 'README.md', '# demo\n');
  for (const [path, content] of Object.entries(opts.files ?? {})) {
    writeRepoFile(seed, path, content);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', 'origin', 'main');
  rmSync(seed, { recursive: true, force: true });

  const work = opts.workDir ?? join(tmp, 'demo');
  git(tmp, 'clone', origin, work);
  git(work, 'remote', 'set-url', 'origin', TEST_REMOTE);
  git(work, 'config', `url.${origin}.insteadOf`, TEST_REMOTE);
  return { origin, work };
}
