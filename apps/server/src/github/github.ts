import type { CiState } from '@hub/protocol';

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PrInfo {
  number: number;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeSha: string | null;
  headSha: string;
  headRef: string;
  baseRef: string;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

/** A check suite: the group of check runs one app (GitHub Actions, say) reports for a commit. */
export interface CheckSuite {
  status: string;
  conclusion: string | null;
  /** How many check runs the suite has created so far. */
  runCount: number;
}

export interface CiStatus {
  state: CiState;
  checks: CheckRun[];
}

export interface MergeOutcome {
  merged: boolean;
  sha: string | null;
  message: string;
}

export interface GitHub {
  findOpenPr(r: RepoRef, branch: string): Promise<PrInfo | null>;
  createPr(r: RepoRef, p: { head: string; base: string; title: string; body: string }): Promise<PrInfo>;
  getPr(r: RepoRef, n: number): Promise<PrInfo>;
  checkStatus(r: RepoRef, sha: string): Promise<CiStatus>;
  /** Squash merge pinned to `sha`. Refusals return `merged: false` instead of throwing. */
  merge(r: RepoRef, n: number, sha: string): Promise<MergeOutcome>;
}

export const FAILED_CONCLUSIONS: readonly string[] = [
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'stale',
];

/** Conclusions that count as passing. Any other conclusion is unknown and fails closed (pending). */
const PASSING_CONCLUSIONS: readonly string[] = ['success', 'skipped', 'neutral'];

/**
 * Whether a suite is still to report. GitHub creates a job's check run only when the job is queued, so in a chain
 * of dependent jobs the finished jobs can all be green while the suite itself is still queued or in progress:
 * the suite is what says that more runs may come. A suite that has created no run at all is not counted: some
 * GitHub Apps leave such a suite queued for good, which would hold every pull request pending.
 */
function suiteIsOpen(suite: CheckSuite): boolean {
  return suite.status !== 'completed' && suite.runCount > 0;
}

/**
 * [] -> 'none'; any completed run with a FAILED_CONCLUSIONS conclusion -> 'failure';
 * else 'success' only when every run is completed with a PASSING_CONCLUSIONS conclusion
 * and no check suite is still open; otherwise 'pending' (not completed, no conclusion,
 * an unrecognised conclusion, or a suite that has not completed).
 */
export function summarizeChecks(runs: readonly CheckRun[], suites: readonly CheckSuite[] = []): CiState {
  const open = suites.some(suiteIsOpen);
  if (runs.length === 0) return open ? 'pending' : 'none';
  const failed = runs.some(
    (run) => run.status === 'completed' && run.conclusion !== null && FAILED_CONCLUSIONS.includes(run.conclusion),
  );
  if (failed) return 'failure';
  const allPassing = runs.every(
    (run) => run.status === 'completed' && run.conclusion !== null && PASSING_CONCLUSIONS.includes(run.conclusion),
  );
  return allPassing && !open ? 'success' : 'pending';
}

const REMOTE_PATTERNS: readonly RegExp[] = [
  /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  /^https:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
];

/** Parses a GitHub remote URL into owner and repo. Any other remote (local path, other host) gives null. */
export function parseGitHubRemote(url: string): RepoRef | null {
  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(url);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { owner: match[1], repo: match[2] };
    }
  }
  return null;
}
