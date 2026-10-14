// Tests for the hub's ops files (ops/hub/*, docs/hub-bootstrap.md). They live here because apps/server's ops.test.ts
// belongs to the server lane; they run the real scripts against stub commands, so no secret ever reaches a real tool.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file: string): string => readFileSync(join(repo, file), 'utf8');

const SCRIPTS = ['ops/hub/bootstrap.sh', 'ops/hub/set-secret.sh', 'ops/hub/check-claude.sh'] as const;

// Fake secrets. The base64 form is what the GitHub header carries.
const TOKEN = 'ghp_FAKEtokenFAKEtokenFAKEtoken0123456789';
const TOKEN_B64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const AUTHKEY = 'tskey-auth-FAKEkeyFAKEkey-FAKEFAKEFAKEFAKEFAKE';

describe('docs/hub-bootstrap.md', () => {
  const docs = read('docs/hub-bootstrap.md');
  const codeBlocks = [...docs.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');

  it('does not claim every step is safe to re-run', () => {
    expect(docs).not.toMatch(/safe to re-?run/i);
  });

  it('prompts without `read -p`, which is a coprocess flag in zsh', () => {
    for (const block of codeBlocks) {
      expect(block).not.toMatch(/\bread\b[^\n]*\s-[a-zA-Z]*p\b/);
    }
    expect(codeBlocks.some((b) => b.includes('stty -echo; IFS= read -r'))).toBe(true);
  });

  it('never exports a secret or puts it in front of a command', () => {
    for (const block of codeBlocks) {
      expect(block).not.toMatch(/\bexport\s+(GITHUB_TOKEN|TS_AUTHKEY|GH|TS|T|P)\b/);
      expect(block).not.toMatch(/\bTS_AUTHKEY=/);
      expect(block).not.toMatch(/\bGITHUB_TOKEN=/);
    }
  });

  it('never passes a secret as an argument to a command', () => {
    for (const block of codeBlocks) {
      for (const line of block.split('\n')) {
        // $GH, $TS, $T and $P may be used by builtins only: printf prints them into a pipe.
        if (!/\$\{?(GH|TS|T|P)\}?\b/.test(line)) continue;
        expect(line, line).toMatch(/^\s*printf\b/);
        expect(line, line).not.toMatch(/\bssh\b[^|]*\$\{?(GH|TS|T|P)\b/);
      }
    }
  });

  it('git pull in the update step carries the GitHub header, through git environment variables', () => {
    const update = codeBlocks.find((b) => b.includes('git pull'));
    expect(update).toBeDefined();
    expect(update).toMatch(/GIT_CONFIG_KEY_0=http\.https:\/\/github\.com\/\.extraheader/);
    expect(update).toMatch(/GIT_CONFIG_VALUE_0="\$header"/);
    for (const line of (update ?? '').split('\n')) {
      if (line.includes('extraheader')) expect(line, line).not.toMatch(/\s-c\s/);
    }
    for (const block of codeBlocks) {
      if (block.includes('git pull')) expect(block).toContain('GIT_CONFIG_COUNT=1');
    }
  });

  it('tells the user to protect each app default branch', () => {
    expect(docs).toMatch(/Protect each app's default branch/);
    expect(docs).toMatch(/Require a pull request before merging/);
  });

  it('numbers its steps in order', () => {
    const numbers = [...docs.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});

describe('ops/hub/hub.service', () => {
  it('mounts the hub code read-only', () => {
    expect(read('ops/hub/hub.service').split('\n')).toContain('ReadOnlyPaths=/opt/hub');
  });

  it('keeps the hub data and apps directories writable', () => {
    const unit = read('ops/hub/hub.service');
    // ProtectSystem=full leaves /var alone; a ReadWritePaths or ProtectHome line would need a second look.
    expect(unit).not.toMatch(/^ProtectSystem=(strict)$/m);
    expect(unit).not.toMatch(/^ReadOnlyPaths=.*\/var\/lib\/hub/m);
  });
});

describe('ops scripts', () => {
  const shellcheck = spawnSync('shellcheck', ['--version']);
  it.skipIf(shellcheck.error !== undefined)('pass shellcheck at warning level (SC2155, SC2086 and the rest)', () => {
    const result = spawnSync('shellcheck', ['--severity=warning', ...SCRIPTS], { cwd: repo, encoding: 'utf8' });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('header comment of bootstrap.sh does not show a secret in front of the command', () => {
    const header = read('ops/hub/bootstrap.sh').split('\n').slice(0, 8).join('\n');
    expect(header).not.toMatch(/(TS_AUTHKEY|GITHUB_TOKEN)=/);
  });

  it('bootstrap.sh never exports or reads a secret from its environment', () => {
    const text = read('ops/hub/bootstrap.sh');
    expect(text).not.toMatch(/\bexport\s+[^\n]*(GITHUB_TOKEN|TS_AUTHKEY|github_token|ts_authkey)/);
    expect(text).not.toMatch(/\$\{?(GITHUB_TOKEN|TS_AUTHKEY)\b/);
  });
});

/** Runs a copy of an ops script in a sandbox: stub commands record what they were given, paths point at a temp dir. */
describe.skipIf(process.platform !== 'linux')('ops scripts against stub commands', () => {
  let sandbox = '';
  let bin = '';
  const STUBS = [
    'apt-get', 'curl', 'git', 'id', 'install', 'node', 'npm', 'pnpm', 'sudo', 'systemctl',
    'systemd-creds', 'tailscale', 'ufw', 'useradd',
  ] as const;

  const STUB_BODY = `
const fs = require('node:fs');
const cp = require('node:child_process');
const argv = process.argv.slice(2);
const log = (extra) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ cmd: NAME, argv, env: process.env, ...extra }) + '\\n');
if (NAME === 'id') { log({}); if (argv[0] === '-u') console.log(process.env.STUB_UID ?? '0'); process.exit(0); }
if (NAME === 'node') { log({}); if (argv[0] === '--version') console.log(process.env.STUB_NODE_VERSION ?? 'v22.1.0'); process.exit(0); }
if (NAME === 'tailscale') { log({}); process.exit(argv[0] === 'status' ? Number(process.env.STUB_TS_STATUS ?? 0) : 0); }
if (NAME === 'curl') { log({}); console.log('env >> "$STUB_INSTALLER_ENV"'); process.exit(0); }
if (NAME === 'systemd-creds') { log({ stdin: argv.includes('encrypt') ? fs.readFileSync(0, 'utf8') : '' }); process.exit(0); }
if (NAME === 'sudo') {
  log({});
  let i = 0;
  while (i < argv.length && (argv[i] === '-u' || argv[i] === '-H')) i += argv[i] === '-u' ? 2 : 1;
  const r = cp.spawnSync(argv[i], argv.slice(i + 1), { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
log({});
`;

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'hub-ops-'));
    bin = join(sandbox, 'bin');
    mkdirSync(bin, { recursive: true });
    const writeStub = (file: string, name: string): void => {
      writeFileSync(file, `#!${process.execPath}\nconst NAME = ${JSON.stringify(name)};\n${STUB_BODY}`);
      chmodSync(file, 0o755);
    };
    for (const name of STUBS) writeStub(join(bin, name), name);
    for (const dir of ['opt/hub/ops/hub', 'etc', 'home', 'var/lib/hub/.local/bin']) mkdirSync(join(sandbox, dir), { recursive: true });
    writeStub(join(sandbox, 'var/lib/hub/.local/bin/claude'), 'claude');
    cpSync(join(repo, 'ops/hub/hub.env.example'), join(sandbox, 'opt/hub/ops/hub/hub.env.example'));
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  /** A copy of the script with its absolute server paths moved into the sandbox. */
  function sandboxed(file: string): string {
    let text = read(file);
    for (const path of ['/opt/hub', '/etc/hub', '/etc/credstore.encrypted', '/var/lib/hub', '/etc/systemd/system', '/etc/environment']) {
      text = text.replaceAll(path, `${sandbox}${path}`);
    }
    const out = join(sandbox, file.split('/').pop() ?? file);
    writeFileSync(out, text);
    return out;
  }

  interface Call {
    cmd: string;
    argv: string[];
    env: Record<string, string>;
    stdin?: string;
  }

  function run(script: string, opts: { stdin?: string; env?: Record<string, string>; args?: string[] }) {
    const log = join(sandbox, 'calls.jsonl');
    const installerEnv = join(sandbox, 'installer.env');
    for (const f of [log, installerEnv]) writeFileSync(f, '');
    const result = spawnSync('bash', [script, ...(opts.args ?? [])], {
      input: opts.stdin ?? '',
      encoding: 'utf8',
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: join(sandbox, 'home'),
        STUB_LOG: log,
        STUB_INSTALLER_ENV: installerEnv,
        ...opts.env,
      },
    });
    const calls = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Call);
    return { ...result, calls, installerEnv: readFileSync(installerEnv, 'utf8') };
  }

  describe('bootstrap.sh', () => {
    const secrets = (token: string, key: string): string => `${token}\n${key}\n`;

    function bootstrap(stdin: string, env: Record<string, string> = {}) {
      cpSync(join(repo, 'ops/hub/set-secret.sh'), join(sandbox, 'opt/hub/ops/hub/set-secret.sh'));
      writeFileSync(join(sandbox, 'opt/hub/ops/hub/set-secret.sh'), read('ops/hub/set-secret.sh').replaceAll('/etc/credstore.encrypted', `${sandbox}/etc/credstore.encrypted`));
      chmodSync(join(sandbox, 'opt/hub/ops/hub/set-secret.sh'), 0o755);
      return run(sandboxed('ops/hub/bootstrap.sh'), { stdin, env: { STUB_TS_STATUS: '1', ...env } });
    }

    it('runs to the end with both secrets on stdin', () => {
      const r = bootstrap(secrets(TOKEN, AUTHKEY));
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Bootstrap done.');
    });

    it('puts the GitHub token on no command line', () => {
      const r = bootstrap(secrets(TOKEN, AUTHKEY));
      expect(r.status).toBe(0);
      for (const call of r.calls) {
        expect(JSON.stringify(call.argv), call.cmd).not.toContain(TOKEN);
        expect(JSON.stringify(call.argv), call.cmd).not.toContain(TOKEN_B64);
      }
    });

    it('puts the Tailscale key on one command line only: tailscale up', () => {
      const r = bootstrap(secrets(TOKEN, AUTHKEY));
      const withKey = r.calls.filter((c) => JSON.stringify(c.argv).includes(AUTHKEY));
      expect(withKey.map((c) => [c.cmd, c.argv[0]])).toEqual([['tailscale', 'up']]);
    });

    it('does not hand a secret to the installers it pipes into bash', () => {
      // An old node makes the script run the NodeSource installer (`curl | bash -`) as root, after the secrets are read.
      const r = bootstrap(secrets(TOKEN, AUTHKEY), { STUB_NODE_VERSION: 'v18.0.0' });
      expect(r.status).toBe(0);
      expect(r.calls.filter((c) => c.cmd === 'curl').length).toBeGreaterThanOrEqual(2);
      // One dump per installer; each starts with the stub variables the dump itself adds.
      expect(r.installerEnv.match(/^STUB_INSTALLER_ENV=/gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
      for (const secret of [TOKEN, TOKEN_B64, AUTHKEY]) expect(r.installerEnv).not.toContain(secret);
    });

    it('does not export a secret to any command, git apart (which gets the header by design)', () => {
      const r = bootstrap(secrets(TOKEN, AUTHKEY));
      for (const call of r.calls) {
        const env = JSON.stringify(call.env);
        expect(env, call.cmd).not.toContain(TOKEN);
        expect(env, call.cmd).not.toContain(AUTHKEY);
        if (call.cmd !== 'git') expect(env, call.cmd).not.toContain(TOKEN_B64);
      }
    });

    it('gives git the header in its environment', () => {
      const r = bootstrap(secrets(TOKEN, AUTHKEY));
      const clone = r.calls.find((c) => c.cmd === 'git' && c.argv[0] === 'clone');
      expect(clone?.env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
      expect(clone?.env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${TOKEN_B64}`);
    });

    it('stores the token through set-secret, on stdin', () => {
      const r = bootstrap(secrets(TOKEN, AUTHKEY));
      const store = r.calls.find((c) => c.cmd === 'systemd-creds' && c.argv.includes('encrypt'));
      expect(store?.argv).toContain('--name=GITHUB_TOKEN');
      expect(store?.stdin).toBe(TOKEN);
    });

    it('works with both secrets blank: no authkey, no clone header, nothing stored', () => {
      const r = bootstrap('\n\n');
      expect(r.status).toBe(0);
      const up = r.calls.find((c) => c.cmd === 'tailscale' && c.argv[0] === 'up');
      expect(up?.argv.some((a) => a.startsWith('--authkey'))).toBe(false);
      const clone = r.calls.find((c) => c.cmd === 'git' && c.argv[0] === 'clone');
      expect(clone?.env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(r.calls.some((c) => c.cmd === 'systemd-creds' && c.argv.includes('encrypt'))).toBe(false);
    });

    it('works when stdin is closed at once', () => {
      expect(bootstrap('').status).toBe(0);
    });

    it('skips tailscale up when the server is already on the tailnet', () => {
      const r = bootstrap(secrets(TOKEN, AUTHKEY), { STUB_TS_STATUS: '0' });
      expect(r.calls.some((c) => c.cmd === 'tailscale' && c.argv[0] === 'up')).toBe(false);
      expect(r.calls.some((c) => JSON.stringify(c.argv).includes(AUTHKEY))).toBe(false);
    });

    it('refuses to run as non-root', () => {
      const r = bootstrap(secrets(TOKEN, AUTHKEY), { STUB_UID: '1000' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Run as root');
    });
  });

  describe('set-secret.sh', () => {
    const setSecret = (name: string, stdin: string) => run(sandboxed('ops/hub/set-secret.sh'), { stdin, args: [name] });

    it('stores a secret read from stdin without putting it on any command line', () => {
      const r = setSecret('GITHUB_TOKEN', TOKEN);
      expect(r.status).toBe(0);
      const store = r.calls.find((c) => c.cmd === 'systemd-creds');
      expect(store?.stdin).toBe(TOKEN);
      for (const call of r.calls) expect(JSON.stringify(call.argv), call.cmd).not.toContain(TOKEN);
    });

    it('says "Empty value" when stdin is empty, and stores nothing', () => {
      const r = setSecret('GITHUB_TOKEN', '');
      expect(r.status).toBe(1);
      expect(r.stderr.trim()).toBe('Empty value');
      expect(r.calls.some((c) => c.cmd === 'systemd-creds')).toBe(false);
    });

    it('says "Empty value" for a blank line too', () => {
      const r = setSecret('GITHUB_TOKEN', '\n');
      expect(r.status).toBe(1);
      expect(r.stderr.trim()).toBe('Empty value');
    });
  });

  describe('check-claude.sh', () => {
    const credentials = (token: string | null): string => {
      const dir = mkdtempSync(join(sandbox, 'creds-'));
      if (token !== null) writeFileSync(join(dir, 'CLAUDE_CODE_OAUTH_TOKEN'), token);
      return dir;
    };

    it('runs claude with the credential in its environment only, and no API key', () => {
      const r = run(sandboxed('ops/hub/check-claude.sh'), {
        env: { CREDENTIALS_DIRECTORY: credentials(TOKEN), ANTHROPIC_API_KEY: 'sk-ant-must-not-leak' },
      });
      expect(r.status).toBe(0);
      const claude = r.calls.find((c) => c.cmd === 'claude');
      expect(claude?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
      expect(claude?.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(JSON.stringify(claude?.argv)).not.toContain(TOKEN);
    });

    it('stops at the credential read when the credential is missing, instead of running claude without it', () => {
      const r = run(sandboxed('ops/hub/check-claude.sh'), { env: { CREDENTIALS_DIRECTORY: credentials(null) } });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      // `export X="$(cat missing)"` reports export's success, so the script would go on and run claude.
      expect(r.calls.some((c) => c.cmd === 'claude')).toBe(false);
    });

    it('says what is wrong when it is not run under systemd', () => {
      const r = run(sandboxed('ops/hub/check-claude.sh'), {});
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('CREDENTIALS_DIRECTORY');
    });
  });
});
