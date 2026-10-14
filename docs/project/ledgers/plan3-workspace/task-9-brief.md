### Task 9: ClaudeRunner contract, fake runner, deploy guard

**Files:**
- Create: `apps/server/src/claude/runner.ts`, `apps/server/src/claude/fake.ts`, `apps/server/src/claude/guard.ts`
- Test: `apps/server/src/claude/fake.test.ts`, `apps/server/src/claude/guard.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces (`runner.ts`; the architecture contract, plus the optional `signal`):

```ts
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'done'; sessionId: string; ok: boolean; error?: string };
export interface RunOptions {
  cwd: string; prompt: string; resume?: string; mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  systemPrompt?: string;   // appended to Claude Code's own system prompt
  signal?: AbortSignal;    // abort → done { ok: false, error: 'aborted' }
}
/** run() never throws and always ends with exactly one 'done'. */
export interface ClaudeRunner { run(opts: RunOptions): AsyncIterable<AgentEvent> }
export const USAGE_LIMIT = 'usage_limit';
export function usageLimitError(resetsAtMs: number | null): string;   // 'usage_limit' | `usage_limit:${resetsAtMs}`
export function parseUsageLimit(error: string | undefined): { resetsAtMs: number | null } | null;
```

- Produces (`fake.ts`):

```ts
export type FakeStep = AgentEvent | ((opts: RunOptions) => void | AgentEvent | Promise<void | AgentEvent>);
export class FakeClaudeRunner implements ClaudeRunner {
  constructor(scripts: FakeStep[][]);       // call i plays scripts[min(i, scripts.length - 1)]
  readonly calls: RunOptions[];
  run(opts: RunOptions): AsyncIterable<AgentEvent>;
}
```

`run` behavior:
- Before each step, if `opts.signal?.aborted`, yield `{ type: 'done', sessionId: '', ok: false, error: 'aborted' }` and stop.
- An event step is yielded. A function step is awaited, and its return value is yielded when it is an event.
- When the script ends without a `done`, yield `{ type: 'done', sessionId: 'fake-session', ok: true }`.

- Produces (`guard.ts`):

```ts
export const DEPLOY_DENY_RULES: readonly string[] = ['Bash(git push *)', 'Bash(docker *)', 'Bash(docker-compose *)', 'Bash(ssh *)',
  'Bash(scp *)', 'Bash(rsync *)', 'Bash(kubectl *)', 'Bash(hcloud *)', 'Bash(gh pr merge *)', 'Bash(gh workflow run *)',
  'Bash(gh release *)', 'Bash(npm publish *)', 'Bash(pnpm publish *)'];
export function deployDenyReason(command: string): string | null;
export function checkToolUse(cwd: string, toolName: string, input: Record<string, unknown>): string | null;
```

`deployDenyReason` algorithm. It is deliberately conservative: a false positive costs a retry, while a miss could deploy.
1. `s = command.replace(/["'`]/g, ' ').replace(/\$\(/g, ';').replace(/[()]/g, ' ')`, then segments = `s.split(/&&|\|\||[;|&\n]/)`, trimmed, non-empty.
2. Per segment, split words on whitespace. While the first word matches `/^[A-Za-z_][A-Za-z0-9_]*=/` or is one of `sudo env exec command nohup time xargs bash sh zsh -c -lc`, drop it. `program = basename(words[0])`.
3. Rules, checked in this order. Return the first reason found.

| Match | Reason (exact) |
|---|---|
| `git`, first non-option argument (skip `-C <x>`, `-c <x>` and other `-…`) is `push` | `git push is done by the Hub after its checks pass.` |
| `git`, subcommand `checkout` or `switch`, and a later word is exactly `main` or `master` | `Stay on the task branch; the Hub manages main.` |
| program in `docker docker-compose podman kubectl helm hcloud ssh scp sftp rsync flyctl fly vercel netlify terraform ansible ansible-playbook caddy` | `` `Deploying is a Hub action; ${program} is not allowed in Build.` `` |
| `gh` and args start with `pr merge`, `workflow run`, `release`, `secret` or `api` | `Merges, releases and workflow runs go through the Hub.` |
| `npm`/`pnpm`/`yarn`/`bun` and an argument is `publish` | `Publishing packages is not allowed in Build.` |
| `npm`/`pnpm`/`yarn`/`bun` and (`args[0] === 'deploy'` or `args[0] === 'run'` and `args[1]` starts with `deploy`) | `Deploying is a Hub action; deploy scripts are not allowed in Build.` |
| `curl` or `wget` and any word contains `api.hetzner.cloud` | `Deploying is a Hub action; the Hetzner API is not allowed in Build.` |

`checkToolUse`:
- `Bash` → `deployDenyReason(String(input.command ?? ''))`.
- `Edit`, `Write` and `NotebookEdit`: `p = resolve(cwd, String(input.file_path ?? input.notebook_path ?? ''))` and `rel = relative(cwd, p)`.
  - `rel` starts with `..` or is absolute → `` `Edits must stay inside the app checkout (${cwd}).` ``
  - `rel === '.git'` or starts with `.git/` → `Do not edit .git directly.`
- Any other tool → `null`.

- [ ] **Step 1: Write the failing tests.**
  - `guard.test.ts`:
    - `allows ordinary work`: each of `pnpm test`, `git status`, `git commit -m "push the button"`, `git checkout -b feature`, `git checkout -- src/a.ts`, `grep -r docker .`, `cat Dockerfile` and `echo ssh is fine` → `null`.
    - `denies composed and path-qualified deploy commands`: each of these gives a non-null reason:
      - `git push`, `git push origin build/x`, `cd web && git push`, `git -C web push`, `/usr/bin/git push`, `FOO=1 git push`
      - `sudo docker compose up`, `bash -c "ssh deploy@1.2.3.4"`, `echo hi; scp a b:/c`, `x=$(ssh host)`
      - `gh pr merge 3`, `pnpm publish`, `npm run deploy:prod`, `curl -X POST https://api.hetzner.cloud/v1/servers`
      - `git switch main`, `git checkout master`
    - `push reason is exact`: `deployDenyReason('git push')` === `'git push is done by the Hub after its checks pass.'`.
    - `edits stay in the checkout`: `checkToolUse('/repo', 'Write', { file_path: '/repo/src/a.ts' })` → `null`. `{ file_path: '/etc/passwd' }` and `{ file_path: '../other/x' }` contain `'inside the app checkout'`. `{ file_path: '.git/config' }` → `'Do not edit .git directly.'` `Read` with `{ file_path: '/etc/hosts' }` → `null`. `Bash` with `{ command: 'git push' }` → the push reason.
  - `fake.test.ts`:
    - `plays scripted events and appends done`: `[[{ type: 'text', text: 'a' }]]` → events `[text a, { type: 'done', sessionId: 'fake-session', ok: true }]`.
    - `functions run in order and may yield events`: a step `o => ({ type: 'text', text: o.cwd })` yields the cwd.
    - `later calls use later scripts, then repeat the last`: with 2 scripts and 3 calls, the third plays script 2. `calls.length === 3`.
    - `abort stops with an aborted done`: the signal is aborted before `run` → only `{ type: 'done', sessionId: '', ok: false, error: 'aborted' }`.
    - `usage limit helpers round-trip`: `usageLimitError(123) === 'usage_limit:123'` → `{ resetsAtMs: 123 }`. `usageLimitError(null) === 'usage_limit'` → `{ resetsAtMs: null }`. `parseUsageLimit('boom')` and `parseUsageLimit(undefined)` → `null`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/claude`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** the same command. Expected: 9 pass.
- [ ] **Step 5: Commit** `apps/server/src/claude` as `feat(server): ClaudeRunner contract, fake runner, deploy guard`, with the attribution trailer your harness provides.

---

