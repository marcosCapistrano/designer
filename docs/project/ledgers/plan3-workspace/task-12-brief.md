### Task 12: GitHub interface, fake and Octokit implementation

**Files:**
- Create: `apps/server/src/github/github.ts`, `apps/server/src/github/fake.ts`, `apps/server/src/github/octokit.ts`
- Test: `apps/server/src/github/github.test.ts`, `apps/server/src/github/octokit.test.ts`

**Interfaces:**
- Consumes: Task 2 (`CiState`), Task 3.
- Produces:

```ts
// github.ts
export interface RepoRef { owner: string; repo: string }
export interface PrInfo { number: number; url: string; state: 'open' | 'closed'; merged: boolean; mergeSha: string | null; headSha: string; headRef: string; baseRef: string }
export interface CheckRun { name: string; status: string; conclusion: string | null }
export interface CiStatus { state: CiState; checks: CheckRun[] }
export interface MergeOutcome { merged: boolean; sha: string | null; message: string }
export interface GitHub {
  findOpenPr(r: RepoRef, branch: string): Promise<PrInfo | null>;
  createPr(r: RepoRef, p: { head: string; base: string; title: string; body: string }): Promise<PrInfo>;
  getPr(r: RepoRef, n: number): Promise<PrInfo>;
  checkStatus(r: RepoRef, sha: string): Promise<CiStatus>;
  merge(r: RepoRef, n: number, sha: string): Promise<MergeOutcome>;   // squash, pinned to sha; refusals return merged:false (no throw)
}
export const FAILED_CONCLUSIONS: readonly string[] = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'];
export function summarizeChecks(runs: readonly CheckRun[]): CiState;
// [] → 'none'; any completed run with a FAILED_CONCLUSIONS conclusion → 'failure';
// else any run not completed (or completed with conclusion null) → 'pending'; else 'success'
export function parseGitHubRemote(url: string): RepoRef | null;
// git@github.com:o/r(.git), ssh://git@github.com/o/r(.git), https://[user[:pass]@]github.com/o/r(.git) → { owner, repo }; anything else → null
// fake.ts
export class FakeGitHub implements GitHub {
  constructor(opts?: { autoGreenAfter?: number });   // set: a sha without explicit checks reports one in-progress run for its first N checkStatus calls, then one success run
  readonly prs: Map<number, PrInfo & { title: string; body: string }>;
  readonly merges: { number: number; sha: string }[];
  readonly calls: string[];                         // method names, in call order
  setChecks(sha: string, runs: CheckRun[]): void;   // explicit runs win; a sha with no runs and no autoGreen → []
  movePrHead(n: number, sha: string): void;
  markMerged(n: number): void;                      // merged on GitHub: merged true, state 'closed', mergeSha `merged-${n}`
  closePr(n: number): void;
}
// octokit.ts
export class OctokitGitHub implements GitHub {
  constructor(token: string, fetchFn?: typeof fetch);   // new Octokit({ auth: token, request: { fetch: fetchFn } })
}
```

`FakeGitHub` rules:
- `createPr` numbers PRs from 1, with `url` = `` `https://github.com/${owner}/${repo}/pull/${n}` ``, `state 'open'`, `merged false`, `mergeSha null`, `headSha` = `` `head-${n}` ``. Set the head with `movePrHead`, which a pushing caller would do. The service tests read `headSha` from git and do not depend on it. A second `createPr` for the same open `head` throws `Error('A pull request already exists for <head>')`.
- `findOpenPr` matches `headRef === branch && state === 'open'`.
- `getPr` on an unknown number throws `Error('Not Found')`.
- `merge` checks, in order:
  - The PR is not open → `{ merged: false, sha: null, message: 'Pull request is not open' }`.
  - `sha !== headSha` → `{ merged: false, sha: null, message: 'Head branch was modified. Review and try the merge again.' }`.
  - Otherwise mark the PR merged and closed with `mergeSha: `merged-${n}``, push to `merges`, and return `{ merged: true, sha: `merged-${n}`, message: 'Merged' }`.

`OctokitGitHub` maps each method to one Octokit call:
- `findOpenPr` → `rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: 'open', per_page: 1 })`.
- `createPr` → `rest.pulls.create(...)`.
- `getPr` → `rest.pulls.get(...)`. `mergeSha` is `merge_commit_sha` when `merged`, else null.
- `checkStatus` → `rest.checks.listForRef({ owner, repo, ref: sha, per_page: 100 })`.
- `merge` → `rest.pulls.merge({ owner, repo, pull_number, merge_method: 'squash', sha })`. A `RequestError` with status 405 or 409 becomes `{ merged: false, sha: null, message: err.message }`; other errors rethrow.

PR fields map from `number`, `html_url`, `state`, `merged ?? false`, `head.sha`, `head.ref` and `base.ref`.

- [ ] **Step 1: Write the failing tests.**
  - `github.test.ts`:
    - `summarizeChecks`:
      - `[]` → `'none'`.
      - `[{ name: 'a', status: 'in_progress', conclusion: null }]` → `'pending'`.
      - success, skipped and neutral → `'success'`.
      - `[failure (completed), queued]` → `'failure'`.
      - `timed_out` → `'failure'`.
      - completed with `null` conclusion → `'pending'`.
    - `parseGitHubRemote`: `'git@github.com:o/r.git'`, `'https://github.com/o/r'`, `'https://github.com/o/r.git'`, `'https://x-access-token:abc@github.com/o/r.git'` and `'ssh://git@github.com/o/r.git'` → `{ owner: 'o', repo: 'r' }`. `'/tmp/origin.git'` and `'https://gitlab.com/o/r'` → `null`.
    - `fake numbers PRs and finds them by branch`.
    - `fake refuses a stale merge`: `movePrHead(1, 'h2')`, then `merge(r, 1, 'h1')` → `merged: false` and `merges` is empty.
    - `fake autoGreenAfter`: `new FakeGitHub({ autoGreenAfter: 1 })` gives `'pending'` and then `'success'` for the same sha.
  - `octokit.test.ts` uses a fake fetch that records `(url, init)` and returns `new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })`:
    - `createPr posts to the pulls endpoint`:
      - It requests `https://api.github.com/repos/o/r/pulls` with method `POST`.
      - The JSON body is `{ head: 'build/x-1', base: 'main', title: 'T', body: 'B' }`, and the `authorization` header is `'token tok'`.
      - The response `{ number: 7, html_url: 'https://github.com/o/r/pull/7', state: 'open', merged: false, head: { sha: 'abc', ref: 'build/x-1' }, base: { ref: 'main' } }` maps to `PrInfo` with `mergeSha: null`.
    - `findOpenPr filters by owner and branch`: the URL's `searchParams.get('head') === 'o:build/x-1'` and `state === 'open'`. A `[]` response → `null`.
    - `checkStatus maps check runs`: `GET …/repos/o/r/commits/abc/check-runs`. The response `{ total_count: 1, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] }` → `{ state: 'success', checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }] }`.
    - `merge squashes and pins the sha`: `PUT …/repos/o/r/pulls/7/merge` with body `{ merge_method: 'squash', sha: 'abc' }`. The response `{ merged: true, sha: 'def', message: 'Pull Request successfully merged' }` → the same outcome.
    - `a refused merge is reported, not thrown`: status 405 with `{ message: 'Pull Request is not mergeable' }` → `merged: false`, and the message contains `not mergeable`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/github`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** the same command. Expected: 12 pass.
- [ ] **Step 5: Commit** `apps/server/src/github` as `feat(server): GitHub interface with Octokit and fake implementations`, with the attribution trailer your harness provides.

---

