import { Octokit } from '@octokit/rest';
import {
  type CheckRun,
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

/** GitHub over the REST API, through Octokit. `fetchFn` lets tests replace the network. */
export class OctokitGitHub implements GitHub {
  private readonly rest: Octokit;

  constructor(token: string, fetchFn?: typeof fetch) {
    this.rest = new Octokit({ auth: token, request: { fetch: fetchFn } });
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
    return { state: summarizeChecks(checks), checks };
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
