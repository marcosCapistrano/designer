import { readFileSync } from 'node:fs';
import { isIPv6 } from 'node:net';
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
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'HCLOUD_TOKEN',
  'HUB_PASSPHRASE_HASH',
  'HUB_SSH_KEY_PATH',
  'CREDENTIALS_DIRECTORY',
];

/** An IPv4 part that is zero in any base the C resolver accepts: 0, 00, 0x0, 0x. */
const ZERO_V4_PART = /^(0x0*|0+)$/i;

/** The eight 16-bit groups of an IPv6 address (an embedded IPv4 tail counts as two groups), or null when it is not IPv6. */
function ipv6Groups(address: string): number[] | null {
  if (!isIPv6(address)) return null;
  let text = address;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (tail !== null) {
    const [, a = '0', b = '0', c = '0', d = '0'] = tail;
    const high = ((Number(a) << 8) | Number(b)).toString(16);
    const low = ((Number(c) << 8) | Number(d)).toString(16);
    text = `${address.slice(0, address.length - tail[0].length)}${high}:${low}`;
  }
  const halves = text.split('::');
  const groups = (part: string | undefined): number[] =>
    part === undefined || part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16));
  const left = groups(halves[0]);
  if (halves.length === 1) return left;
  const right = groups(halves[1]);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/**
 * Whether `host` would bind every interface. Node hands the host to the resolver, so this recognizes every
 * spelling of the wildcard that reaches it: `0` and the other short IPv4 forms (`0.0`, `0x0`, `00`), the
 * IPv6 forms (`::`, `::0`, `[::]`, `0:0:0:0:0:0:0:0`, with or without a zone) and their IPv4-mapped twins.
 */
export function isWildcardBind(host: string): boolean {
  let text = host.trim().toLowerCase();
  if (text === '*' || text === '') return true;
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (text === '') return true;
  if (text.includes(':')) {
    const groups = ipv6Groups(text);
    if (groups === null) return false;
    if (groups.every((group) => group === 0)) return true;
    // ::ffff:0.0.0.0, the IPv4 wildcard in its IPv6-mapped spelling.
    return groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff && groups[6] === 0 && groups[7] === 0;
  }
  const parts = text.split('.');
  return parts.length <= 4 && parts.every((part) => ZERO_V4_PART.test(part));
}

type Env = Record<string, string | undefined>;

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * The secret `key`, from the environment or else the CREDENTIALS_DIRECTORY file of that name.
 * A missing file is an absent secret; any other read error (a directory, no permission) is a ConfigError
 * that names the key and the error code, never the secret.
 */
function readCredential(env: Env, key: string): string | undefined {
  const fromEnv = nonBlank(env[key]);
  if (fromEnv !== undefined) return fromEnv;
  const dir = nonBlank(env.CREDENTIALS_DIRECTORY);
  if (dir === undefined) return undefined;
  try {
    return nonBlank(readFileSync(join(dir, key), 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new ConfigError(`Cannot read credential ${key} from CREDENTIALS_DIRECTORY (${code ?? 'unknown error'})`);
  }
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

  if (isWildcardBind(bind)) {
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
