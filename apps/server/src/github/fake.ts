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

type StoredPr = PrInfo & { title: string; body: string; repo: string };

/** The repo as the fake keys it: pull requests belong to one repo, as on GitHub. */
function repoKey(r: RepoRef): string {
  return `${r.owner}/${r.repo}`;
}

function toInfo(pr: PrInfo): PrInfo {
  return {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    merged: pr.merged,
    mergeSha: pr.mergeSha,
    headSha: pr.headSha,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
  };
}

function copyRuns(runs: readonly CheckRun[]): CheckRun[] {
  return runs.map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion }));
}

function copySuites(suites: readonly CheckSuite[]): CheckSuite[] {
  return suites.map((suite) => ({ status: suite.status, conclusion: suite.conclusion, runCount: suite.runCount }));
}

/** In-memory GitHub for tests. The test drives PR head moves, checks and merges on GitHub's side. */
export class FakeGitHub implements GitHub {
  readonly prs = new Map<number, StoredPr>();
  readonly merges: { number: number; sha: string }[] = [];
  readonly calls: string[] = [];

  private readonly autoGreenAfter: number | undefined;
  private readonly checks = new Map<string, CheckRun[]>();
  private readonly suites = new Map<string, CheckSuite[]>();
  private readonly checkCalls = new Map<string, number>();
  private nextNumber = 1;

  constructor(opts: { autoGreenAfter?: number } = {}) {
    this.autoGreenAfter = opts.autoGreenAfter;
  }

  async findOpenPr(r: RepoRef, branch: string): Promise<PrInfo | null> {
    this.calls.push('findOpenPr');
    const pr = [...this.prs.values()].find(
      (candidate) => candidate.repo === repoKey(r) && candidate.headRef === branch && candidate.state === 'open',
    );
    return pr ? toInfo(pr) : null;
  }

  async createPr(r: RepoRef, p: { head: string; base: string; title: string; body: string }): Promise<PrInfo> {
    this.calls.push('createPr');
    const existing = [...this.prs.values()].find(
      (candidate) => candidate.repo === repoKey(r) && candidate.headRef === p.head && candidate.state === 'open',
    );
    if (existing) throw new Error(`A pull request already exists for ${p.head}`);
    const number = this.nextNumber;
    this.nextNumber += 1;
    const pr: StoredPr = {
      number,
      url: `https://github.com/${r.owner}/${r.repo}/pull/${number}`,
      state: 'open',
      merged: false,
      mergeSha: null,
      headSha: `head-${number}`,
      headRef: p.head,
      baseRef: p.base,
      title: p.title,
      body: p.body,
      repo: repoKey(r),
    };
    this.prs.set(number, pr);
    return toInfo(pr);
  }

  async getPr(r: RepoRef, n: number): Promise<PrInfo> {
    this.calls.push('getPr');
    return toInfo(this.prIn(r, n));
  }

  async checkStatus(_r: RepoRef, sha: string): Promise<CiStatus> {
    this.calls.push('checkStatus');
    const checks = this.runsFor(sha);
    return { state: summarizeChecks(checks, this.suites.get(sha) ?? []), checks };
  }

  async merge(r: RepoRef, n: number, sha: string): Promise<MergeOutcome> {
    this.calls.push('merge');
    const pr = this.prIn(r, n);
    if (pr.state !== 'open') return { merged: false, sha: null, message: 'Pull request is not open' };
    if (sha !== pr.headSha) {
      return { merged: false, sha: null, message: 'Head branch was modified. Review and try the merge again.' };
    }
    pr.merged = true;
    pr.state = 'closed';
    pr.mergeSha = `merged-${n}`;
    this.merges.push({ number: n, sha });
    return { merged: true, sha: `merged-${n}`, message: 'Merged' };
  }

  /** Sets the check runs for a sha. Explicit runs win, including an explicit empty list. */
  setChecks(sha: string, runs: CheckRun[]): void {
    this.checks.set(sha, copyRuns(runs));
  }

  /** Sets the check suites for a sha (default: none). A suite that is not completed holds the state pending. */
  setSuites(sha: string, suites: CheckSuite[]): void {
    this.suites.set(sha, copySuites(suites));
  }

  /** Moves a PR's head, as a pushing caller would. */
  movePrHead(n: number, sha: string): void {
    this.requirePr(n).headSha = sha;
  }

  /** Marks a PR merged on GitHub, outside the hub. */
  markMerged(n: number): void {
    const pr = this.requirePr(n);
    pr.merged = true;
    pr.state = 'closed';
    pr.mergeSha = `merged-${n}`;
  }

  closePr(n: number): void {
    this.requirePr(n).state = 'closed';
  }

  /** The PR as GitHub answers for a repo: one that belongs to another repo is Not Found. */
  private prIn(r: RepoRef, n: number): StoredPr {
    const pr = this.prs.get(n);
    if (!pr || pr.repo !== repoKey(r)) throw new Error('Not Found');
    return pr;
  }

  private requirePr(n: number): StoredPr {
    const pr = this.prs.get(n);
    if (!pr) throw new Error('Not Found');
    return pr;
  }

  private runsFor(sha: string): CheckRun[] {
    const explicit = this.checks.get(sha);
    if (explicit) return copyRuns(explicit);
    if (this.autoGreenAfter === undefined) return [];
    const calls = (this.checkCalls.get(sha) ?? 0) + 1;
    this.checkCalls.set(sha, calls);
    if (calls <= this.autoGreenAfter) {
      return [{ name: 'ci', status: 'in_progress', conclusion: null }];
    }
    return [{ name: 'ci', status: 'completed', conclusion: 'success' }];
  }
}
