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
  push(branch: string): Promise<void>;
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

/**
 * Carries the auth entries in GIT_CONFIG_PARAMETERS (git's own single-quoted key=value list),
 * so the token never appears in git's argv or .git/config.
 */
function authedEnv(env: Record<string, string>, token: string | null | undefined): Record<string, string> {
  const entries = authConfig(token);
  if (entries.length === 0) return env;
  const parameters = entries.map((entry) => `'${entry.replace(/'/g, `'\\''`)}'`).join(' ');
  return { ...env, GIT_CONFIG_PARAMETERS: parameters };
}

export function openRepo(dir: string, opts: RepoOptions = {}): GitRepo {
  const env = gitEnv(opts.identity);
  const local = simpleGit({ baseDir: dir }).env(env);
  const authed = simpleGit({ baseDir: dir }).env(authedEnv(env, opts.token));

  const refExists = (ref: string): Promise<boolean> =>
    local.raw(['rev-parse', '--verify', '--quiet', ref]).then(
      () => true,
      () => false,
    );
  const isDirty = async (): Promise<boolean> => (await local.raw(['status', '--porcelain'])).trim() !== '';
  const headSha = async (): Promise<string> => (await local.raw(['rev-parse', 'HEAD'])).trim();

  return {
    dir,

    async currentBranch() {
      return (await local.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    },

    async defaultBranch() {
      try {
        const ref = (await local.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
        if (ref !== '') return ref.replace(/^origin\//, '');
      } catch {
        // origin/HEAD is not set; fall through to the branch-name probe.
      }
      return (await refExists('refs/remotes/origin/main')) ? 'main' : 'master';
    },

    async fetch() {
      await authed.raw(['fetch', 'origin', '--prune']);
    },

    async createBranchFrom(branch, base) {
      await local.raw(['checkout', '--no-track', '-B', branch, `origin/${base}`]);
    },

    async checkout(branch) {
      await local.raw(['checkout', branch]);
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
      return Number((await local.raw(['rev-list', '--count', `origin/${base}..HEAD`])).trim());
    },

    async push(branch) {
      await authed.raw(['push', '--set-upstream', 'origin', branch]);
    },

    async remoteUrl() {
      try {
        return (await local.raw(['config', '--get', 'remote.origin.url'])).trim();
      } catch {
        return null;
      }
    },
  };
}
