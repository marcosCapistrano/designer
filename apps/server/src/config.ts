import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface HubConfig {
  bind: string;
  port: number;
  dataDir: string;
  appsDir: string;
  passphraseHash: string;
  githubToken: string | null;
  githubOwner: string | null;
  claudeOauthToken: string | null;
}

export class ConfigError extends Error {}

export const DEFAULT_PORT = 8787;

/** Secrets that may come from systemd encrypted credentials (CREDENTIALS_DIRECTORY). */
export const CREDENTIAL_KEYS: readonly string[] = ['HUB_PASSPHRASE_HASH', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** Env keys that are never passed to child processes (Claude, git, build commands). */
export const SECRET_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'HCLOUD_TOKEN',
  'HUB_PASSPHRASE_HASH',
  'HUB_SSH_KEY_PATH',
  'CREDENTIALS_DIRECTORY',
];

const WILDCARD_BINDS: readonly string[] = ['0.0.0.0', '::', '[::]', '*'];

type Env = Record<string, string | undefined>;

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function readCredential(env: Env, key: string): string | undefined {
  const fromEnv = nonBlank(env[key]);
  if (fromEnv !== undefined) return fromEnv;
  const dir = nonBlank(env.CREDENTIALS_DIRECTORY);
  if (dir === undefined) return undefined;
  const file = join(dir, key);
  return existsSync(file) ? nonBlank(readFileSync(file, 'utf8')) : undefined;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new ConfigError('HUB_PORT must be a port number');
  }
  return port;
}

export function loadConfig(env: Env): HubConfig {
  const missing: string[] = [];
  const need = (name: string, value: string | undefined): string => {
    if (value === undefined) missing.push(name);
    return value ?? '';
  };
  const bind = need('HUB_BIND', nonBlank(env.HUB_BIND));
  const dataDir = need('HUB_DATA_DIR', nonBlank(env.HUB_DATA_DIR));
  const appsDir = need('HUB_APPS_DIR', nonBlank(env.HUB_APPS_DIR));
  const passphraseHash = need('HUB_PASSPHRASE_HASH', readCredential(env, 'HUB_PASSPHRASE_HASH'));
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (WILDCARD_BINDS.includes(bind)) {
    throw new ConfigError(
      'HUB_BIND must be one specific address (127.0.0.1 behind tailscale serve), not a wildcard',
    );
  }
  const port = parsePort(nonBlank(env.HUB_PORT));
  if (!passphraseHash.startsWith('scrypt:')) {
    throw new ConfigError('HUB_PASSPHRASE_HASH must come from: pnpm --silent -F @hub/server hash-passphrase');
  }

  return {
    bind,
    port,
    dataDir: resolve(dataDir),
    appsDir: resolve(appsDir),
    passphraseHash,
    githubToken: readCredential(env, 'GITHUB_TOKEN') ?? null,
    githubOwner: nonBlank(env.GITHUB_OWNER) ?? null,
    claudeOauthToken: readCredential(env, 'CLAUDE_CODE_OAUTH_TOKEN') ?? null,
  };
}

/** Copies every defined entry except secrets. Never mutates `env`. */
export function scrubEnv(env: Env): Record<string, string> {
  const secrets = new Set(SECRET_ENV_KEYS);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !secrets.has(key)) out[key] = value;
  }
  return out;
}
