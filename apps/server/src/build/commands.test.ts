import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppManifest } from '@hub/protocol/manifest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OUTPUT_TAIL, resolveBuildCommands, runCommand } from './commands.js';

const tempDirs: string[] = [];

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hub-commands-'));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

function packageJson(scripts: Record<string, string>): string {
  return JSON.stringify({ name: 'demo', version: '1.0.0', scripts });
}

const manifest: AppManifest = {
  name: 'demo-app',
  template: 'base@1',
  design: { dir: 'design', routes: 'routes.json', devices: ['desktop'] },
  build: { install: 'i', typecheck: 'tc', test: 't' },
  deploy: {
    image: 'ghcr.io/owner/demo-app',
    staging: { server: 'staging', url: 'https://staging.example.com' },
    production: { server: 'prod', url: 'https://example.com', domain: null },
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveBuildCommands', () => {
  it('runs the manifest commands first, in order', async () => {
    const dir = makeProject({});
    await expect(resolveBuildCommands(dir, manifest)).resolves.toEqual([
      { name: 'install', cmd: 'i' },
      { name: 'typecheck', cmd: 'tc' },
      { name: 'test', cmd: 't' },
    ]);
  });

  it('uses pnpm when pnpm-lock.yaml exists', async () => {
    const dir = makeProject({
      'pnpm-lock.yaml': '',
      'package.json': packageJson({ typecheck: 'tsc --noEmit', test: 'vitest run' }),
    });
    await expect(resolveBuildCommands(dir, null)).resolves.toEqual([
      { name: 'install', cmd: 'pnpm install --frozen-lockfile' },
      { name: 'typecheck', cmd: 'pnpm run typecheck' },
      { name: 'test', cmd: 'pnpm test' },
    ]);
  });

  it('skips npm default test script', async () => {
    const dir = makeProject({
      'package-lock.json': '{}',
      'package.json': packageJson({ test: 'echo "Error: no test specified" && exit 1' }),
    });
    await expect(resolveBuildCommands(dir, null)).resolves.toEqual([{ name: 'install', cmd: 'npm ci' }]);
  });

  it('uses yarn when yarn.lock exists', async () => {
    const dir = makeProject({
      'yarn.lock': '',
      'package.json': packageJson({ typecheck: 'tsc', test: 'jest' }),
    });
    await expect(resolveBuildCommands(dir, null)).resolves.toEqual([
      { name: 'install', cmd: 'yarn install --frozen-lockfile' },
      { name: 'typecheck', cmd: 'yarn run typecheck' },
      { name: 'test', cmd: 'yarn test' },
    ]);
  });

  it('uses npm install without a lockfile', async () => {
    const dir = makeProject({ 'package.json': packageJson({}) });
    await expect(resolveBuildCommands(dir, null)).resolves.toEqual([{ name: 'install', cmd: 'npm install' }]);
  });

  it('returns no commands without a package.json', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' });
    await expect(resolveBuildCommands(dir, null)).resolves.toEqual([]);
  });

  it('returns no commands for an unparsable package.json', async () => {
    const dir = makeProject({ 'package.json': '{ not json' });
    await expect(resolveBuildCommands(dir, null)).resolves.toEqual([]);
  });
});

describe('runCommand', () => {
  const cwd = tmpdir();

  it('reports exit code and output', async () => {
    const result = await runCommand('echo out; echo err 1>&2; exit 3', { cwd });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it('keeps only the output tail', async () => {
    const result = await runCommand("head -c 10000 /dev/zero | tr '\\0' x", { cwd });
    expect(result.output.length).toBe(4000);
  });

  it('keeps the end of the output, not the beginning', async () => {
    // Every line differs, so a head-keeping bug cannot pass by length alone.
    const lines = Array.from({ length: 5000 }, (_, i) => String(i + 1));
    const full = `${lines.join('\n')}\n`;

    const result = await runCommand('seq 1 5000', { cwd });

    expect(full.length).toBeGreaterThan(OUTPUT_TAIL);
    expect(result.output).toBe(full.slice(-OUTPUT_TAIL));
    expect(result.output.endsWith('\n5000\n')).toBe(true);
    expect(result.output.includes('\n1\n')).toBe(false);
  });

  it('reports a command that cannot start (a missing working directory)', async () => {
    const result = await runCommand('echo hi', { cwd: join(cwd, 'hub-no-such-dir-xyz') });

    expect(result.ok).toBe(false);
    expect(result.code).toBeNull();
    expect(result.output).toContain('ENOENT');
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it('runs with CI=1, whatever the hub itself has', async () => {
    vi.stubEnv('CI', '0');
    const result = await runCommand('echo "ci=$CI"', { cwd });
    expect(result.output.trim()).toBe('ci=1');
  });

  it('an abort that is already in force stops the command before it does anything', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCommand('sleep 10', { cwd, signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
  });

  describe('a background process that ignores SIGTERM', () => {
    // The subshell ignores SIGTERM and has no pipe, so it outlives the shell unless the group is killed outright.
    const script = "(trap '' TERM; exec sleep 30) >/dev/null 2>&1 </dev/null & echo $!; sleep 30";

    function alive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    async function survivor(options: { timeoutMs?: number; signal?: AbortSignal }): Promise<number> {
      const result = await runCommand(script, { cwd, ...options });
      const pid = Number(result.output.trim().split('\n')[0]);
      expect(Number.isInteger(pid) && pid > 1).toBe(true);
      return pid;
    }

    it('is killed when the command times out', async () => {
      const pid = await survivor({ timeoutMs: 300 });
      try {
        await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 2000 });
      } finally {
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
    });

    it('is killed when the command is aborted', async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const pid = await survivor({ signal: controller.signal });
      try {
        await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 2000 });
      } finally {
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
    });
  });

  it('times out and kills the process group', async () => {
    const started = Date.now();
    const result = await runCommand('sleep 10 & sleep 10; wait', { cwd, timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('abort stops the command', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runCommand('sleep 10', { cwd, signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('does not pass secrets to the command', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'leak');
    const result = await runCommand('echo "${GITHUB_TOKEN:-none}"', { cwd });
    expect(result.output.trim()).toBe('none');
  });
});
