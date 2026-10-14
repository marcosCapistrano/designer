import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AppManifest } from '@hub/protocol/manifest';
import { scrubEnv } from '../config.js';

export type BuildCommandName = 'install' | 'typecheck' | 'test';
export interface BuildCommand {
  name: BuildCommandName;
  cmd: string;
}
export interface CommandResult {
  ok: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

export const OUTPUT_TAIL = 4000;
export const COMMAND_TIMEOUT_MS = 900_000;
const KILL_GRACE_MS = 5000;

export type RunCommand = (
  cmd: string,
  opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
) => Promise<CommandResult>;

type PackageManager = 'pnpm' | 'yarn' | 'npm';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The package.json scripts, or null when the file is missing or unparsable. */
async function readScripts(dir: string): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return isRecord(parsed.scripts) ? parsed.scripts : {};
}

async function detectPackageManager(dir: string): Promise<PackageManager> {
  if (await exists(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

async function installCommand(dir: string, pm: PackageManager): Promise<string> {
  if (pm === 'pnpm') return 'pnpm install --frozen-lockfile';
  if (pm === 'yarn') return 'yarn install --frozen-lockfile';
  return (await exists(join(dir, 'package-lock.json'))) ? 'npm ci' : 'npm install';
}

/**
 * The build commands for a checkout, in run order. A valid app manifest wins;
 * otherwise the commands come from package.json and its lockfile.
 */
export async function resolveBuildCommands(dir: string, manifest: AppManifest | null): Promise<BuildCommand[]> {
  if (manifest !== null) {
    return [
      { name: 'install', cmd: manifest.build.install },
      { name: 'typecheck', cmd: manifest.build.typecheck },
      { name: 'test', cmd: manifest.build.test },
    ];
  }
  const scripts = await readScripts(dir);
  if (scripts === null) return [];

  const pm = await detectPackageManager(dir);
  const commands: BuildCommand[] = [{ name: 'install', cmd: await installCommand(dir, pm) }];
  const typecheck = scripts.typecheck;
  if (typeof typecheck === 'string') {
    commands.push({ name: 'typecheck', cmd: `${pm} run typecheck` });
  }
  const test = scripts.test;
  if (typeof test === 'string' && !test.includes('no test specified')) {
    commands.push({ name: 'test', cmd: `${pm} test` });
  }
  return commands;
}

/**
 * Runs one shell command in its own process group, with scrubbed env and CI=1.
 * On timeout or abort the whole group gets SIGTERM, then SIGKILL after a grace period; and when the shell has
 * ended by then, the rest of the group is killed at once, so a background process that ignored SIGTERM
 * does not outlive the command.
 */
export const runCommand: RunCommand = (cmd, opts) =>
  new Promise((resolvePromise) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd: opts.cwd,
      env: { ...scrubEnv(process.env), CI: '1' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const append = (text: string): void => {
      output += text;
      if (output.length > 2 * OUTPUT_TAIL) output = output.slice(-OUTPUT_TAIL);
    };

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group has already exited.
      }
    };

    const stop = (): void => {
      killGroup('SIGTERM');
      killTimer ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };

    const onAbort = (): void => {
      aborted = true;
      stop();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs ?? COMMAND_TIMEOUT_MS);

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The shell is gone, so the pending SIGKILL timer would be cleared below. A timed-out or aborted command
      // may have left a daemonized child that ignores SIGTERM and holds no pipe; the group is killed now.
      if (timedOut || aborted) killGroup('SIGKILL');
      if (killTimer !== undefined) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        ok: code === 0 && !timedOut && !aborted,
        code,
        output: output.slice(-OUTPUT_TAIL),
        timedOut,
        aborted,
      });
    };

    child.stdout.on('data', (chunk: Buffer) => append(stdoutDecoder.write(chunk)));
    child.stderr.on('data', (chunk: Buffer) => append(stderrDecoder.write(chunk)));
    child.on('error', (err) => {
      append(`${err.message}\n`);
      finish(null);
    });
    child.on('close', (code) => {
      append(stdoutDecoder.end());
      append(stderrDecoder.end());
      finish(code);
    });

    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
