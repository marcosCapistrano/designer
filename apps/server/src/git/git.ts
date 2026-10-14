import { simpleGit } from 'simple-git';

export interface GitIdentity {
  name: string;
  email: string;
}

export interface RepoOptions {
  token?: string | null;
  identity?: GitIdentity;
}

export interface GitRepo {
  readonly dir: string;
  currentBranch(): Promise<string>;
  defaultBranch(): Promise<string>;
  fetch(): Promise<void>;
  createBranchFrom(branch: string, base: string): Promise<void>;
  checkout(branch: string): Promise<void>;
  isDirty(): Promise<boolean>;
  commitAll(message: string): Promise<string | null>;
  headSha(): Promise<string>;
  commitsAhead(base: string): Promise<number>;
  /**
   * Pushes `branch` to origin as `refs/heads/<branch>:refs/heads/<branch>`, whatever `remote.origin.push` says.
   * With `leaseSha` the push may rewrite the branch (an amend or rebase) but only while origin still has `leaseSha`
   * there (`--force-with-lease`); without it the push must be a fast-forward.
   */
  push(branch: string, opts?: { leaseSha?: string | null }): Promise<void>;
  remoteUrl(): Promise<string | null>;
}

/** Minimal child-process environment for every git call; simple-git refuses EDITOR, PAGER and GIT_CONFIG_COUNT (among others). */
export function gitEnv(identity?: GitIdentity): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    GIT_TERMINAL_PROMPT: '0',
  };
  if (identity !== undefined) {
    env.GIT_AUTHOR_NAME = identity.name;
    env.GIT_AUTHOR_EMAIL = identity.email;
    env.GIT_COMMITTER_NAME = identity.name;
    env.GIT_COMMITTER_EMAIL = identity.email;
  }
  return env;
}

/** The auth extraheader as git `key=value` strings; empty when there is no token. */
export function authConfig(token: string | null | undefined): string[] {
  if (token === null || token === undefined || token === '') return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return [`http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

/** git's own GIT_CONFIG_PARAMETERS encoding: each `key=value` entry single-quoted, entries separated by spaces. */
export function configParameters(entries: readonly string[]): string {
  return entries.map((entry) => `'${entry.replace(/'/g, `'\\''`)}'`).join(' ');
}

/**
 * Git hooks live in the checkout, which Claude can write. The two calls that carry the token (fetch, push) point
 * hooksPath at /dev/null, so a Claude-written hook (pre-push, reference-transaction, ...) never runs with the
 * token in its environment.
 */
const NO_HOOKS = 'core.hooksPath=/dev/null';

/**
 * The environment for calls that talk to GitHub: hooks off, and the auth entries in GIT_CONFIG_PARAMETERS,
 * so the token never appears in git's argv or .git/config.
 */
export function authedEnv(env: Record<string, string>, token: string | null | undefined): Record<string, string> {
  return { ...env, GIT_CONFIG_PARAMETERS: configParameters([NO_HOOKS, ...authConfig(token)]) };
}

const FULL_SHA = /^[0-9a-f]{40,64}$/;

/** Branch names are hub-built (`build/...`); this keeps one that looks like an option out of a git command line. */
function assertBranchName(branch: string): void {
  if (branch.trim() === '' || branch.startsWith('-')) throw new Error(`Invalid branch name: ${JSON.stringify(branch)}`);
}

export function openRepo(dir: string, opts: RepoOptions = {}): GitRepo {
  const env = gitEnv(opts.identity);
  const local = simpleGit({ baseDir: dir }).env(env);
  const authed = simpleGit({ baseDir: dir }).env(authedEnv(env, opts.token));

  // --untracked-files=normal wins over a status.showUntrackedFiles=no that Claude may have written to .git/config.
  const isDirty = async (): Promise<boolean> =>
    (await local.raw(['status', '--porcelain', '--untracked-files=normal'])).trim() !== '';
  const headSha = async (): Promise<string> => (await local.raw(['rev-parse', 'HEAD'])).trim();

  return {
    dir,

    async currentBranch() {
      return (await local.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    },

    /**
     * The branch origin's HEAD points at: the local origin/HEAD when it is set, else what origin itself reports
     * (`ls-remote --symref`). It throws when neither says, rather than guessing: the answer feeds the guard that keeps
     * the hub off the default branch.
     */
    async defaultBranch() {
      // -q: an unset or non-symbolic origin/HEAD is an empty answer, not an error; a real failure still throws.
      const ref = (await local.raw(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])).trim();
      if (ref !== '') return ref.replace(/^origin\//, '');

      const listing = await authed.raw(['ls-remote', '--symref', 'origin', 'HEAD']);
      const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(listing);
      if (match?.[1] === undefined) {
        throw new Error('Cannot tell which branch is the default: origin/HEAD is not set and origin did not report its HEAD.');
      }
      return match[1];
    },

    async fetch() {
      await authed.raw(['fetch', 'origin', '--prune']);
    },

    async createBranchFrom(branch, base) {
      assertBranchName(branch);
      await local.raw(['checkout', '--no-track', '-B', branch, `origin/${base}`, '--']);
    },

    async checkout(branch) {
      assertBranchName(branch);
      await local.raw(['checkout', branch, '--']);
    },

    isDirty,

    async commitAll(message) {
      if (!(await isDirty())) return null;
      await local.raw(['add', '-A']);
      await local.raw(['commit', '-m', message]);
      return headSha();
    },

    headSha,

    async commitsAhead(base) {
      return Number((await local.raw(['rev-list', '--count', `origin/${base}..HEAD`, '--'])).trim());
    },

    async push(branch, opts = {}) {
      assertBranchName(branch);
      const ref = `refs/heads/${branch}`;
      const lease: string[] = [];
      if (opts.leaseSha !== undefined && opts.leaseSha !== null) {
        if (!FULL_SHA.test(opts.leaseSha)) throw new Error(`Invalid lease commit: ${JSON.stringify(opts.leaseSha)}`);
        lease.push(`--force-with-lease=${ref}:${opts.leaseSha}`);
      }
      // An explicit src:dst refspec: a bare branch name would follow remote.origin.push, which Claude can write.
      await authed.raw(['push', ...lease, '--set-upstream', 'origin', `${ref}:${ref}`]);
    },

    async remoteUrl() {
      // An unset remote.origin.url exits 1 with no output, which comes back as ''; a real failure throws.
      const url = (await local.raw(['config', '--get', 'remote.origin.url'])).trim();
      return url === '' ? null : url;
    },
  };
}
