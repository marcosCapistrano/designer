import type { BuildTask, CiState } from '@hub/protocol';
import {
  type CiStatus,
  FAILED_CONCLUSIONS,
  type GitHub,
  type MergeOutcome,
  type PrInfo,
  type RepoRef,
} from '../github/github.js';
import { addBuildMessage, type BuildDeps, publishTask, repoRefFor } from './deps.js';
import type { BuildStore } from './store.js';

/** A Build action refused for a reason the HTTP layer reports with `status` (502: GitHub could not be reached). */
export class BuildError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502) {
    super(message);
  }
}

/** What the tablet is told when GitHub does not answer a read or a merge. The cause goes to the log. */
const GITHUB_UNREACHABLE = 'Could not reach GitHub.';

/**
 * Consecutive polls that find a task's CI still pending on one head before the poller stops
 * checking it. The poller runs every ciPollMs (30 s by default), so this is about one hour.
 * Merge still reads CI on the current head, so a stopped task can still be merged once green.
 */
const CI_POLL_LIMIT = 120;

interface PendingWatch {
  headSha: string | null;
  polls: number;
}

/** Pending-poll counts per task, kept per store so each store starts with none. */
const pendingWatches = new WeakMap<BuildStore, Map<number, PendingWatch>>();

function watchesFor(store: BuildStore): Map<number, PendingWatch> {
  let watches = pendingWatches.get(store);
  if (watches === undefined) {
    watches = new Map();
    pendingWatches.set(store, watches);
  }
  return watches;
}

/** The GitHub repo behind an app's checkout, or null when the app or its remote is unknown. */
async function repoFor(deps: BuildDeps, app: string): Promise<RepoRef | null> {
  const entry = await deps.registry.get(app);
  return entry ? repoRefFor(deps, entry.dir) : null;
}

/** What GitHub says about a PR. CI is read only while the PR is open. */
type Remote =
  | { kind: 'merged'; pr: PrInfo }
  | { kind: 'closed'; pr: PrInfo }
  | { kind: 'open'; pr: PrInfo; ci: CiStatus };

async function readRemote(github: GitHub, ref: RepoRef, n: number): Promise<Remote> {
  const pr = await github.getPr(ref, n);
  if (pr.merged) return { kind: 'merged', pr };
  if (pr.state === 'closed') return { kind: 'closed', pr };
  return { kind: 'open', pr, ci: await github.checkStatus(ref, pr.headSha) };
}

/** Stores the CI state and head, and broadcasts the task when either changed. */
function storeCi(deps: BuildDeps, task: BuildTask, state: CiState, headSha: string): BuildTask {
  if (state === task.ci && headSha === task.headSha) return task;
  const updated = deps.store.updateTask(task.id, { ci: state, headSha });
  publishTask(deps, updated, false);
  return updated;
}

/** Announces a CI state that just changed: a pass is ready to merge, a failure names its checks. */
function announceCi(deps: BuildDeps, task: BuildTask, ci: CiStatus): void {
  if (ci.state === 'success') {
    addBuildMessage(deps, task.app, task.id, 'status', 'CI passed. Ready to merge.');
  } else if (ci.state === 'failure') {
    const failed = ci.checks
      .filter((check) => check.conclusion !== null && FAILED_CONCLUSIONS.includes(check.conclusion))
      .map((check) => check.name);
    addBuildMessage(deps, task.app, task.id, 'error', `CI failed: ${failed.join(', ')}`);
  }
}

/**
 * Ends a task whose PR GitHub reports merged, and fires the merge hook when the merge commit is known.
 * A poll and a merge can both see the same merge, so a task already recorded merged is returned as is.
 */
function recordMergedOnGitHub(deps: BuildDeps, task: BuildTask, n: number, mergeSha: string | null): BuildTask {
  const current = deps.store.task(task.id);
  if (current?.status === 'merged') return current;
  const merged = deps.store.updateTask(task.id, { status: 'merged', mergeSha });
  addBuildMessage(deps, task.app, task.id, 'status', `Pull request #${n} was merged on GitHub.`);
  publishTask(deps, merged, false);
  if (mergeSha !== null) deps.onMerged?.({ app: task.app, taskId: task.id, prNumber: n, sha: mergeSha });
  return merged;
}

function recordClosed(deps: BuildDeps, task: BuildTask, n: number): BuildTask {
  const closed = deps.store.updateTask(task.id, { status: 'closed' });
  addBuildMessage(deps, task.app, task.id, 'status', `Pull request #${n} was closed.`);
  publishTask(deps, closed, false);
  return closed;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reads a review task's PR and CI from GitHub and records what changed.
 * A missing task gives null; any other unusable state, or a GitHub error, gives the stored task.
 */
export async function refreshCi(deps: BuildDeps, taskId: number): Promise<BuildTask | null> {
  const task = deps.store.task(taskId);
  if (!task) return null;
  const github = deps.github;
  if (task.status !== 'review' || task.prNumber === null || github === null) return task;
  const n = task.prNumber;

  let remote: Remote;
  try {
    const ref = await repoFor(deps, task.app);
    if (!ref) return task;
    remote = await readRemote(github, ref, n);
  } catch (err) {
    console.warn(`CI refresh for task ${taskId} failed: ${errorText(err)}`);
    return task;
  }

  // The reads took time. A merge, a close or another refresh may have changed the task meanwhile, so what is
  // written below is judged against the task as it is now, not as it was before the await.
  const current = deps.store.task(taskId);
  if (current === null || current.status !== 'review') return current;
  if (remote.kind === 'merged') return recordMergedOnGitHub(deps, current, n, remote.pr.mergeSha);
  if (remote.kind === 'closed') return recordClosed(deps, current, n);
  const { pr, ci } = remote;
  const updated = storeCi(deps, current, ci.state, pr.headSha);
  if (ci.state !== current.ci) announceCi(deps, current, ci);
  return updated;
}

/**
 * Refreshes every review task whose app is not running. A task whose CI stays pending on one head
 * is checked at most CI_POLL_LIMIT times; a new head starts a new count. `refresh` reads one task's
 * CI (default: refreshCi); a caller that shares refreshes between callers passes its own.
 */
export async function pollCi(
  deps: BuildDeps,
  isRunning: (app: string) => boolean,
  refresh: (taskId: number) => Promise<BuildTask | null> = (taskId) => refreshCi(deps, taskId),
): Promise<void> {
  const watches = watchesFor(deps.store);
  const reviews = deps.store.tasksWithStatus(['review']);
  const inReview = new Set(reviews.map((task) => task.id));
  for (const taskId of watches.keys()) {
    if (!inReview.has(taskId)) watches.delete(taskId);
  }

  for (const task of reviews) {
    if (isRunning(task.app)) continue;
    const watch = watches.get(task.id);
    if (watch !== undefined && watch.polls >= CI_POLL_LIMIT && watch.headSha === task.headSha) continue;

    const next = await refresh(task.id);
    if (next?.ci !== 'pending') {
      watches.delete(task.id);
      continue;
    }
    const polls = watch !== undefined && watch.headSha === next.headSha ? watch.polls + 1 : 1;
    watches.set(task.id, { headSha: next.headSha, polls });
  }
}

/** Squash-merges a review task's PR, pinned to the head whose CI is green. Merging a merged task returns it. */
export async function mergeTask(deps: BuildDeps, app: string, taskId: number, running: boolean): Promise<BuildTask> {
  const task = deps.store.task(taskId);
  if (!task || task.app !== app) throw new BuildError('Task not found', 404);
  if (running) throw new BuildError('Claude is still working on this app.', 409);
  if (task.status === 'merged') return task;
  if (task.status !== 'review' || task.prNumber === null) {
    throw new BuildError('This task has no open pull request.', 409);
  }
  const github = deps.github;
  if (github === null) throw new BuildError('GITHUB_TOKEN is not set.', 409);
  const n = task.prNumber;
  const ref = await repoFor(deps, app);
  if (!ref) throw new BuildError('This app has no GitHub remote.', 409);

  let remote: Remote;
  try {
    remote = await readRemote(github, ref, n);
  } catch (err) {
    console.warn(`Merge read for task ${taskId} failed: ${errorText(err)}`);
    throw new BuildError(GITHUB_UNREACHABLE, 502);
  }
  if (remote.kind === 'merged') return recordMergedOnGitHub(deps, task, n, remote.pr.mergeSha);
  if (remote.kind === 'closed') {
    recordClosed(deps, task, n);
    throw new BuildError('The pull request is closed.', 409);
  }

  const { pr, ci } = remote;
  storeCi(deps, task, ci.state, pr.headSha);
  if (ci.state !== 'success') {
    const state = ci.state === 'none' ? 'not reporting any checks' : ci.state;
    throw new BuildError(`CI is ${state}; merge needs green CI.`, 409);
  }

  let out: MergeOutcome;
  try {
    out = await github.merge(ref, n, pr.headSha);
  } catch (err) {
    console.warn(`Merge of task ${taskId} failed: ${errorText(err)}`);
    throw new BuildError(GITHUB_UNREACHABLE, 502);
  }
  if (!out.merged || out.sha === null) throw new BuildError(`GitHub refused the merge: ${out.message}`, 409);
  // A poll may have recorded this merge while the merge was in flight; record and announce it once.
  const current = deps.store.task(task.id);
  if (current?.status === 'merged') return current;
  const merged = deps.store.updateTask(task.id, { status: 'merged', mergeSha: out.sha, error: null });
  addBuildMessage(deps, app, task.id, 'status', `Merged pull request #${n}.`);
  publishTask(deps, merged, false);
  deps.onMerged?.({ app, taskId: task.id, prNumber: n, sha: out.sha });
  return merged;
}
