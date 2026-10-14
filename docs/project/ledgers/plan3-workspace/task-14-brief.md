### Task 14: Build naming and command runner

**Files:**
- Create: `apps/server/src/build/naming.ts`, `apps/server/src/build/commands.ts`
- Test: `apps/server/src/build/naming.test.ts`, `apps/server/src/build/commands.test.ts`

**Interfaces:**
- Consumes: Task 1 (`AppManifest`), Task 3 (`scrubEnv`).
- Produces:

```ts
// commands.ts
export type BuildCommandName = 'install' | 'typecheck' | 'test';
export interface BuildCommand { name: BuildCommandName; cmd: string }
export interface CommandResult { ok: boolean; code: number | null; output: string; timedOut: boolean; aborted: boolean }
export const OUTPUT_TAIL = 4000;
export const COMMAND_TIMEOUT_MS = 900_000;
export type RunCommand = (cmd: string, opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<CommandResult>;
export function resolveBuildCommands(dir: string, manifest: AppManifest | null): Promise<BuildCommand[]>;
export const runCommand: RunCommand;
// naming.ts
export function branchSlug(prompt: string, id: number): string;
export function prTitle(prompt: string): string;
export function prBody(prompts: readonly string[]): string;
export function summarizeTool(name: string, input: unknown, cwd: string): string;
export function buildSystemPrompt(branch: string): string;
export function fixPrompt(c: BuildCommand, r: CommandResult): string;
```

`resolveBuildCommands`:
- If the manifest is valid → `[install, typecheck, test]` from `manifest.build`, in that order.
- Otherwise, read `<dir>/package.json`. If it is missing or unparsable → `[]`.
- The package manager is `pnpm` when `pnpm-lock.yaml` exists, else `yarn` when `yarn.lock` exists, else `npm`.
- Install is `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, or `npm ci` (with `package-lock.json`) / `npm install` (without).
- `typecheck` is added when `scripts.typecheck` exists: `` `${pm} run typecheck` ``.
- `test` is added when `scripts.test` exists and does not contain `no test specified`: `` `${pm} test` ``.

`runCommand`:
- Runs `spawn('bash', ['-c', cmd], { cwd, env: { ...scrubEnv(process.env), CI: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`.
- Stdout and stderr are appended to one string. When it passes `2 * OUTPUT_TAIL` characters, keep only the last `OUTPUT_TAIL`. The result `output` is the last `OUTPUT_TAIL` characters.
- On timeout (`timeoutMs ?? COMMAND_TIMEOUT_MS`) or abort, run `process.kill(-pid, 'SIGTERM')` and then `SIGKILL` after 5 s.
- `ok = code === 0 && !timedOut && !aborted`.

`naming.ts` rules:
- `branchSlug`:
  1. Lowercase the prompt, replace `/[^a-z0-9]+/g` with spaces, split into words, and take the first 6.
  2. Join them with `-`, slice to 40 characters, and strip a trailing `-`.
  3. If the result is empty, use `'task'`. Then append `` `-${id}` ``.
- `prTitle`:
  1. Take the first line, collapse whitespace, and trim.
  2. If it is longer than 72 characters, use the first 71 plus `…`.
  3. If it is empty, use `'Hub build task'`.
- `prBody(prompts)` = `'Opened by the Hub Build area.\n\n## Requests\n\n' + prompts.map((p, i) => `${i + 1}. ${p.replace(/\s+/g, ' ').trim()}`).join('\n') + '\n'`.
- `summarizeTool`:
  - `Bash` → `$ ` plus the first line of `command`, cut to 160 characters plus `…` when longer.
  - `Read`, `Edit`, `Write` and `NotebookEdit` → `` `${name} ${shown}` ``. `shown` is the path relative to `cwd` when the path is inside it, else the absolute path.
  - `Grep` and `Glob` → `` `${name} ${pattern}` ``.
  - Anything else, including a non-object input → `name`.
- `buildSystemPrompt(branch)` (exact):

```
You are Claude Code running inside the Hub, in this app's git checkout on branch `${branch}`.
- Stay on this branch. Do not switch branches, push, merge or deploy: the Hub pushes, opens the pull request and deploys after its own checks.
- Make the change the user asks for, add or update tests, and run the project's typecheck and tests before you finish.
- Commit your work with a clear message when you are done.
- The user reads your replies on a tablet: keep them short and say what you changed.
```

- `fixPrompt(c, r)` (exact): `` `The Hub ran \`${c.cmd}\` (${c.name}) and it failed${r.timedOut ? ' (timed out)' : ` with exit code ${r.code}`}. Fix the cause, run it again yourself, and commit. Last output:\n\n${r.output.slice(-3000)}` ``.

- [ ] **Step 1: Write the failing tests.**
  - `naming.test.ts`:
    - `branch slugs`:
      - `('Add a dark-mode toggle to Settings!', 12)` → `'add-a-dark-mode-toggle-to-12'`.
      - `('!!!', 5)` → `'task-5'`.
      - `('Implement the extraordinarily comprehensive internationalization subsystem now', 9)` → `'implement-the-extraordinarily-comprehens-9'`.
    - `pr titles`: `'  Fix   the\nlogin bug'` → `'Fix the'`. `'a'.repeat(100)` → `'a'.repeat(71) + '…'`. `''` → `'Hub build task'`.
    - `pr body lists the requests`: `prBody(['one', 'two\nlines'])` === `'Opened by the Hub Build area.\n\n## Requests\n\n1. one\n2. two lines\n'`.
    - `tool summaries`:
      - `('Bash', { command: 'pnpm test\nmore' }, '/r')` → `'$ pnpm test'`.
      - A 200-character command → length 163 (`'$ '` + 160 + `…`).
      - `('Edit', { file_path: '/r/src/a.ts' }, '/r')` → `'Edit src/a.ts'`.
      - `('Read', { file_path: '/etc/hosts' }, '/r')` → `'Read /etc/hosts'`.
      - `('Grep', { pattern: 'TODO' }, '/r')` → `'Grep TODO'`.
      - `('mcp__x__y', null, '/r')` → `'mcp__x__y'`.
    - `system prompt names the branch`: it contains `` 'branch `build/x-1`' `` and `'Do not switch branches, push, merge or deploy'`.
    - `fix prompt quotes the command and exit code`: `fixPrompt({ name: 'test', cmd: 'pnpm test' }, { ok: false, code: 1, output: 'boom', timedOut: false, aborted: false })` contains ``'`pnpm test` (test) and it failed with exit code 1'`` and ends with `'boom'`.
  - `commands.test.ts`:
    - `manifest commands come first`: a manifest with build `{ install: 'i', typecheck: 'tc', test: 't' }` → `[{ name: 'install', cmd: 'i' }, { name: 'typecheck', cmd: 'tc' }, { name: 'test', cmd: 't' }]`.
    - `pnpm project without a manifest`: `pnpm-lock.yaml` plus scripts typecheck and test → `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm test`.
    - `npm default test script is skipped`: `package-lock.json` and `scripts.test = 'echo "Error: no test specified" && exit 1'` → only `[{ name: 'install', cmd: 'npm ci' }]`.
    - `yarn project`: `yarn install --frozen-lockfile`, `yarn run typecheck`, `yarn test`.
    - `no package.json means no commands`: `[]`.
    - `reports exit code and output`: `'echo out; echo err 1>&2; exit 3'` → `ok false`, `code 3`, and the output contains `out` and `err`.
    - `keeps only the output tail`: `"head -c 10000 /dev/zero | tr '\\0' x"` → `output.length === 4000`.
    - `times out and kills the process group`: `'sleep 10 & sleep 10; wait'` with `timeoutMs: 200` → `timedOut true`, resolving in under 3000 ms.
    - `abort stops the command`: abort after 100 ms on `'sleep 10'` → `aborted true`.
    - `secrets are not passed`: `vi.stubEnv('GITHUB_TOKEN', 'leak')`, then `'echo "${GITHUB_TOKEN:-none}"'` → the trimmed output is `'none'`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/build/naming.test.ts src/build/commands.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command. Expected: 16 pass.
- [ ] **Step 5: Commit** `apps/server/src/build/naming.* apps/server/src/build/commands.*` as `feat(server): build naming helpers and process-group command runner`, with the attribution trailer your harness provides.

---

