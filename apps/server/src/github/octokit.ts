import { Octokit } from '@octokit/rest';
import {
  type CheckRun,
  type CheckSuite,
  type CiStatus,
  type GitHub,
  type MergeOutcome,
  type PrInfo,
  type RepoRef,
  summarizeChecks,
} from './github.js';

/** The fields of a pull request object that this adapter reads from the GitHub REST API. */
interface PullPayload {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean | null;
  merge_commit_sha?: string | null;
  head: { sha: string; ref: string };
  base: { ref: string };
}

function toPrInfo(pr: PullPayload): PrInfo {
  const merged = pr.merged ?? false;
  return {
    number: pr.number,
    url: pr.html_url,
    state: pr.state === 'open' ? 'open' : 'closed',
    merged,
    mergeSha: merged ? (pr.merge_commit_sha ?? null) : null,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
  };
}

/**
 * A refused merge (HTTP 405 or 409). octokit/request-error's RequestError is not importable
 * from this package, so it is recognised by its shape: the `HttpError` name and a status.
 */
function isRefusedMergeError(err: unknown): err is Error & { status: number } {
  if (!(err instanceof Error) || err.name !== 'HttpError') return false;
  const status = (err as Error & { status?: unknown }).status;
  return status === 405 || status === 409;
}

/** How long one GitHub request may take before it is abandoned. Without a limit a hung read waits for undici's ~300 s. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** `base` with a deadline on every request, on top of any signal the caller passes. */
function withTimeout(base: typeof fetch, timeoutMs: number): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (init?.signal) signals.push(init.signal);
    return base(input, { ...init, signal: AbortSignal.any(signals) });
  }) as typeof fetch;
}

/**
 * GitHub over the REST API, through Octokit. `fetchFn` lets tests replace the network.
 * Every request is abandoned after `timeoutMs` (30 s by default).
 */
export class OctokitGitHub implements GitHub {
  private readonly rest: Octokit;

  constructor(token: string, fetchFn?: typeof fetch, timeoutMs: number = REQUEST_TIMEOUT_MS) {
    this.rest = new Octokit({ auth: token, request: { fetch: withTimeout(fetchFn ?? fetch, timeoutMs) } });
  }

  async findOpenPr(r: RepoRef, branch: string): Promise<PrInfo | null> {
    const { data } = await this.rest.pulls.list({
      owner: r.owner,
      repo: r.repo,
      head: `${r.owner}:${branch}`,
      state: 'open',
      per_page: 1,
    });
    const first = data[0];
    return first ? toPrInfo(first) : null;
  }

  async createPr(r: RepoRef, p: { head: string; base: string; title: string; body: string }): Promise<PrInfo> {
    const { data } = await this.rest.pulls.create({
      owner: r.owner,
      repo: r.repo,
      head: p.head,
      base: p.base,
      title: p.title,
      body: p.body,
    });
    return toPrInfo(data);
  }

  async getPr(r: RepoRef, n: number): Promise<PrInfo> {
    const { data } = await this.rest.pulls.get({ owner: r.owner, repo: r.repo, pull_number: n });
    return toPrInfo(data);
  }

  async checkStatus(r: RepoRef, sha: string): Promise<CiStatus> {
    const { data } = await this.rest.checks.listForRef({ owner: r.owner, repo: r.repo, ref: sha, per_page: 100 });
    const checks: CheckRun[] = data.check_runs.map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
    }));
    const suites = await this.checkSuites(r, sha);
    // Only one page of each is read. If GitHub has more than were read, the unread ones are unknown, so the
    // state fails closed to 'pending' rather than summarizing a partial list. A count that is missing or not a
    // number is just as unknown.
    const unread = !(data.total_count <= data.check_runs.length) || suites.unread;
    return { state: unread ? 'pending' : summarizeChecks(checks, suites.suites), checks };
  }

  /** The check suites of a commit, and whether some were left unread. */
  private async checkSuites(r: RepoRef, sha: string): Promise<{ suites: CheckSuite[]; unread: boolean }> {
    const { data } = await this.rest.checks.listSuitesForRef({ owner: r.owner, repo: r.repo, ref: sha, per_page: 100 });
    const suites: CheckSuite[] = data.check_suites.map((suite) => ({
      status: suite.status ?? 'queued',
      conclusion: suite.conclusion,
      // A suite object that does not say how many runs it has is counted as having some: fail closed.
      runCount: suite.latest_check_runs_count ?? 1,
    }));
    return { suites, unread: !(data.total_count <= data.check_suites.length) };
  }

  async merge(r: RepoRef, n: number, sha: string): Promise<MergeOutcome> {
    try {
      const { data } = await this.rest.pulls.merge({
        owner: r.owner,
        repo: r.repo,
        pull_number: n,
        merge_method: 'squash',
        sha,
      });
      return { merged: data.merged, sha: data.sha, message: data.message };
    } catch (err) {
      if (isRefusedMergeError(err)) {
        return { merged: false, sha: null, message: err.message };
      }
      throw err;
    }
  }
}
