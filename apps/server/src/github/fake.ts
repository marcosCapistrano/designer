import {
  type CheckRun,
  type CiStatus,
  type GitHub,
  type MergeOutcome,
  type PrInfo,
  type RepoRef,
  summarizeChecks,
} from './github.js';

type StoredPr = PrInfo & { title: string; body: string };

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

/** In-memory GitHub for tests. The test drives PR head moves, checks and merges on GitHub's side. */
export class FakeGitHub implements GitHub {
  readonly prs = new Map<number, StoredPr>();
  readonly merges: { number: number; sha: string }[] = [];
  readonly calls: string[] = [];

  private readonly autoGreenAfter: number | undefined;
  private readonly checks = new Map<string, CheckRun[]>();
  private readonly checkCalls = new Map<string, number>();
  private nextNumber = 1;

  constructor(opts: { autoGreenAfter?: number } = {}) {
    this.autoGreenAfter = opts.autoGreenAfter;
  }

  async findOpenPr(_r: RepoRef, branch: string): Promise<PrInfo | null> {
    this.calls.push('findOpenPr');
    const pr = [...this.prs.values()].find((candidate) => candidate.headRef === branch && candidate.state === 'open');
    return pr ? toInfo(pr) : null;
  }

  async createPr(r: RepoRef, p: { head: string; base: string; title: string; body: string }): Promise<PrInfo> {
    this.calls.push('createPr');
    const existing = [...this.prs.values()].find(
      (candidate) => candidate.headRef === p.head && candidate.state === 'open',
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
    };
    this.prs.set(number, pr);
    return toInfo(pr);
  }

  async getPr(_r: RepoRef, n: number): Promise<PrInfo> {
    this.calls.push('getPr');
    const pr = this.prs.get(n);
    if (!pr) throw new Error('Not Found');
    return toInfo(pr);
  }

  async checkStatus(_r: RepoRef, sha: string): Promise<CiStatus> {
    this.calls.push('checkStatus');
    const checks = this.runsFor(sha);
    return { state: summarizeChecks(checks), checks };
  }

  async merge(_r: RepoRef, n: number, sha: string): Promise<MergeOutcome> {
    this.calls.push('merge');
    const pr = this.prs.get(n);
    if (!pr) throw new Error('Not Found');
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
