import type { Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { AppRegistry } from './apps/registry.js';
import { LoginLimiter } from './auth/limiter.js';
import { readCookie, SESSION_COOKIE, SessionStore } from './auth/sessions.js';
import type { BuildDeps } from './build/deps.js';
import { type RunCommand, runCommand as defaultRunCommand } from './build/commands.js';
import { BuildService } from './build/service.js';
import { BuildStore } from './build/store.js';
import type { ClaudeRunner } from './claude/runner.js';
import type { HubConfig } from './config.js';
import { openDb } from './db.js';
import { type GitRepo, openRepo as openGitRepo } from './git/git.js';
import type { GitHub } from './github/github.js';
import { attachWebSocket } from './ws/attach.js';
import { SocketHub } from './ws/hub.js';

export interface HubOptions {
  config: HubConfig;
  runner: ClaudeRunner;
  github: GitHub | null;
  /** The built client. When null the hub serves only /api and /ws. */
  clientDir: string | null;
  openRepo?: (dir: string) => GitRepo; // default: d => openRepo(d, { token: config.githubToken })
  runCommand?: RunCommand; // default: runCommand
  ciPollMs?: number; // default 30_000
  retryPollMs?: number; // default 60_000
  heartbeatMs?: number; // WebSocket ping and session recheck interval; default 30_000
  /** The clock for sessions, the login limiter and Build. Default Date.now. */
  now?: () => number;
  onMerged?: BuildDeps['onMerged'];
  log?: (line: string) => void; // default console.log
}

export interface RunningHub {
  url: string;
  port: number;
  hub: SocketHub;
  build: BuildService;
  close(): Promise<void>;
}

const DEFAULT_CI_POLL_MS = 30_000;
const DEFAULT_RETRY_POLL_MS = 60_000;
const PURGE_SESSIONS_MS = 3_600_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wires the hub: database, sessions, Build, HTTP, WebSocket and the background timers. Resolves once the
 * server is listening. A failure to listen (the port is taken, say) closes the database again and rejects.
 */
export async function startHub(opts: HubOptions): Promise<RunningHub> {
  const { config } = opts;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? console.log;

  await mkdir(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, 'hub.sqlite'));
  try {
    const sessions = new SessionStore(db, now);
    // Sessions that expired while the hub was down are gone before anyone can connect.
    sessions.purgeExpired();
    const limiter = new LoginLimiter();
    const registry = new AppRegistry(config.appsDir);
    const hub = new SocketHub();
    const build = new BuildService({
      store: new BuildStore(db, now),
      runner: opts.runner,
      hub,
      registry,
      openRepo: opts.openRepo ?? ((dir) => openGitRepo(dir, { token: config.githubToken })),
      github: opts.github,
      runCommand: opts.runCommand ?? defaultRunCommand,
      now,
      onMerged: opts.onMerged,
    });
    const interrupted = build.recover();
    if (interrupted > 0) log(`Marked ${interrupted} interrupted build task(s) as failed`);

    // Assigned once the WebSocket server exists; the app is built first because the server needs its fetch.
    let recheckSockets = (): void => {};
    const app = createApp({
      sessions,
      limiter,
      passphraseHash: config.passphraseHash,
      registry,
      build,
      dataDir: config.dataDir,
      clientDir: opts.clientDir,
      now,
      onLogout: () => recheckSockets(),
    });

    let listening = false;
    const server = await new Promise<Server>((resolve, reject) => {
      const created = serve({ fetch: app.fetch, port: config.port, hostname: config.bind }, () => {
        listening = true;
        resolve(created as Server);
      }) as Server;
      created.on('error', (err) => {
        if (!listening) reject(err);
        else log(`Server error: ${JSON.stringify(errorText(err))}`);
      });
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : config.port;

    const sockets = attachWebSocket(server, hub, {
      isAuthed: (cookieHeader) => sessions.valid(readCookie(cookieHeader, SESSION_COOKIE)),
      heartbeatMs: opts.heartbeatMs,
    });
    recheckSockets = sockets.recheck;

    let closing = false;
    /** Runs `task` every `ms` milliseconds, one at a time; an error is logged unless the hub is shutting down. */
    const every = (ms: number, label: string, task: () => unknown): ReturnType<typeof setInterval> => {
      let busy = false;
      const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        void (async () => {
          try {
            await task();
          } catch (err) {
            if (!closing) log(`${label} failed: ${JSON.stringify(errorText(err))}`);
          } finally {
            busy = false;
          }
        })();
      }, ms);
      timer.unref();
      return timer;
    };
    const timers = [
      every(opts.ciPollMs ?? DEFAULT_CI_POLL_MS, 'CI poll', () => build.pollCi()),
      every(opts.retryPollMs ?? DEFAULT_RETRY_POLL_MS, 'Queued task retry', () => build.retryQueued()),
      every(PURGE_SESSIONS_MS, 'Session purge', () => sessions.purgeExpired()),
    ];

    const url = `http://${config.bind}:${port}`;
    log(`Hub listening on ${url}`);

    let closed: Promise<void> | null = null;
    const close = (): Promise<void> => {
      closed ??= (async () => {
        closing = true;
        for (const timer of timers) clearInterval(timer);
        // Stop accepting first, so no request can start a run after stopAll has looked; sockets stay up
        // until the runs have ended, so their last messages still reach the browsers.
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        try {
          await build.stopAll();
        } finally {
          sockets.close();
          server.closeAllConnections();
          await stopped;
          db.close();
        }
      })();
      return closed;
    };

    return { url, port, hub, build, close };
  } catch (err) {
    db.close();
    throw err;
  }
}
