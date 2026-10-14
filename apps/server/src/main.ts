import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './build/commands.js';
import { SdkClaudeRunner } from './claude/sdk.js';
import { ConfigError, type HubConfig, loadConfig } from './config.js';
import { errorText } from './errors.js';
import { OctokitGitHub } from './github/octokit.js';
import { startHub } from './server.js';

/** Longest error message written to the log, as in the HTTP error handler. */
const MAX_LOGGED_MESSAGE_CHARS = 500;

/** One log line for a failure: the message only (never the stack or the error object), JSON-escaped and cut. */
function oneLine(prefix: string, err: unknown): string {
  return `${prefix}: ${JSON.stringify(errorText(err).slice(0, MAX_LOGGED_MESSAGE_CHARS))}`;
}

/** The hub cannot trust its state after one of these, so it logs one line and exits; systemd restarts it. */
function crashOn(prefix: string): (err: unknown) => never {
  return (err) => {
    console.error(oneLine(prefix, err));
    process.exit(1);
  };
}

async function main(): Promise<void> {
  let config: HubConfig;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const github = config.githubToken ? new OctokitGitHub(config.githubToken) : null;
  const clientDir = fileURLToPath(new URL('../../client/dist', import.meta.url));
  const hasClient = existsSync(join(clientDir, 'index.html'));
  if (!hasClient) console.log('Client build not found; run pnpm -F @hub/client build');

  const hub = await startHub({
    config,
    // Claude signs in with the subscription token from the config, never an API key, and the token stays out of argv.
    runner: new SdkClaudeRunner({ oauthToken: config.claudeOauthToken }),
    github,
    clientDir: hasClient ? clientDir : null,
    runCommand,
  });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await hub.close();
      process.exit(0);
    } catch (err) {
      console.error(oneLine('Shutdown failed', err));
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

process.on('uncaughtException', crashOn('Uncaught exception'));
process.on('unhandledRejection', crashOn('Unhandled rejection'));
main().catch(crashOn('Failed to start'));
