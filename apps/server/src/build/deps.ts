import type { BuildMessage, BuildMessageKind, BuildTask } from '@hub/protocol';
import type { AppRegistry } from '../apps/registry.js';
import type { ClaudeRunner } from '../claude/runner.js';
import type { GitRepo } from '../git/git.js';
import { type GitHub, parseGitHubRemote, type RepoRef } from '../github/github.js';
import type { WsHub } from '../ws/hub.js';
import type { RunCommand } from './commands.js';
import type { BuildStore } from './store.js';

/** Everything a Build action needs from the server, so tests can substitute each part. */
export interface BuildDeps {
  store: BuildStore;
  runner: ClaudeRunner;
  hub: WsHub;
  registry: Pick<AppRegistry, 'get'>;
  openRepo: (dir: string) => GitRepo;
  github: GitHub | null;
  runCommand: RunCommand;
  now: () => number;
  onMerged?: (e: { app: string; taskId: number; prNumber: number; sha: string }) => void; // plan 4: staging deploy
}

/** Stores a Build message and broadcasts it to every connected client. */
export function addBuildMessage(
  deps: BuildDeps,
  app: string,
  taskId: number | null,
  kind: BuildMessageKind,
  text: string,
): BuildMessage {
  const message = deps.store.addMessage({ app, taskId, kind, text });
  deps.hub.broadcast({ type: 'build.message', app, message });
  return message;
}

/** Broadcasts a task and whether Claude is running on it. */
export function publishTask(deps: BuildDeps, task: BuildTask, running: boolean): void {
  deps.hub.broadcast({ type: 'build.task', app: task.app, task, running });
}

/** The GitHub owner and repo behind a checkout's origin remote, or null when it is not a GitHub remote. */
export async function repoRefFor(deps: BuildDeps, dir: string): Promise<RepoRef | null> {
  return parseGitHubRemote((await deps.openRepo(dir).remoteUrl()) ?? '');
}
