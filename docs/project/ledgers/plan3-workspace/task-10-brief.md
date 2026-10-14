### Task 10: Agent SDK runner

**Files:**
- Create: `apps/server/src/claude/sdk.ts`
- Test: `apps/server/src/claude/sdk.test.ts`

**Interfaces:**
- Consumes: Task 9 (`RunOptions`, `AgentEvent`, `ClaudeRunner`, `usageLimitError`, `DEPLOY_DENY_RULES`, `checkToolUse`), Task 3 (`scrubEnv`).
- Produces:

```ts
import { query, type Options, type SDKMessage, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
export const AUTH_FAILED_MESSAGE = 'Claude Code is not logged in on the hub. Run `claude setup-token` and store the token with ops/hub/set-secret.sh CLAUDE_CODE_OAUTH_TOKEN (docs/hub-bootstrap.md).';
export interface RunnerContext { env: Record<string, string | undefined>; oauthToken: string | null }
export function guardHook(cwd: string): HookCallback;
export function buildQueryOptions(opts: RunOptions, ctx: RunnerContext): Options;
export interface MapState { sessionId: string | null; resultOk: boolean | null; resultError: string | null; apiError: string | null; limited: boolean; resetsAtMs: number | null }
export function newMapState(): MapState;
export function mapMessage(msg: SDKMessage, state: MapState): AgentEvent[];
export function finalEvent(state: MapState, opts: { resume?: string; aborted: boolean; thrown: unknown }): AgentEvent;
export class SdkClaudeRunner implements ClaudeRunner {
  constructor(opts?: { oauthToken?: string | null; env?: Record<string, string | undefined> /* process.env */; queryFn?: typeof query });
  run(opts: RunOptions): AsyncIterable<AgentEvent>;
}
```

`buildQueryOptions` returns exactly these keys. Omit `resume` when it is undefined. It does not set `abortController`.

```ts
{
  cwd: opts.cwd,
  ...(opts.resume ? { resume: opts.resume } : {}),
  permissionMode: 'bypassPermissions',          // full permissions inside the repo…
  allowDangerouslySkipPermissions: true,
  disallowedTools: [...DEPLOY_DENY_RULES],      // …but deploys are denied, even in bypass mode
  hooks: { PreToolUse: [{ hooks: [guardHook(opts.cwd)] }] },   // no matcher: every tool call
  canUseTool: async (toolName) => ({ behavior: 'deny', message: `${toolName} needs a person's approval and the Hub cannot ask. Ask in your reply instead.` }),
  allowedTools: opts.allowedTools ?? [],
  mcpServers: (opts.mcpServers ?? {}) as Options['mcpServers'],
  settingSources: ['project'],                  // the app's CLAUDE.md and .claude/settings.json
  systemPrompt: { type: 'preset', preset: 'claude_code', ...(opts.systemPrompt ? { append: opts.systemPrompt } : {}) },
  env: { ...scrubEnv(ctx.env), ...(ctx.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: ctx.oauthToken } : {}) },
}
```

`guardHook(cwd)`:
- If `input.hook_event_name !== 'PreToolUse'` → `{}`.
- `reason = checkToolUse(cwd, input.tool_name, input.tool_input as Record<string, unknown>)`.
- A reason → `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }`. No reason → `{}`.

`mapMessage` narrows on `msg.type`. If the installed SDK types differ, cast through `unknown` to these minimal shapes:
- `system` with `subtype === 'init'` → `state.sessionId = session_id`, `[]`.
- `assistant` → `[]` when `parent_tool_use_id !== null` (subagent internals stay hidden).
  - If `error` is set, `state.apiError = error`, and `'rate_limit'` also sets `limited = true`.
  - Then for each `message.content` block: `text` with non-blank text → `{ type: 'text', text }`; `tool_use` → `{ type: 'tool', name, input }`.
- `rate_limit_event`: when `rate_limit_info.status === 'rejected'`, set `limited = true`. If `resetsAt` is a number, `resetsAtMs = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt`.
- `result` → `sessionId = session_id`, `resultOk = subtype === 'success' && !is_error`. When it is not ok, `resultError = subtype === 'success' ? (result || 'Claude reported an error') : subtype`.
- Anything else → `[]`.

`finalEvent` sets `sessionId = state.sessionId ?? opts.resume ?? ''`. The rules apply in this order:
1. `limited` → `error: usageLimitError(resetsAtMs)`.
2. `aborted` → `'aborted'`.
3. `apiError` in `authentication_failed`/`oauth_org_not_allowed` → `AUTH_FAILED_MESSAGE`.
4. `resultOk === true` → `{ ok: true }` with no `error` key.
5. Otherwise `error = resultError ?? apiError ?? (thrown instanceof Error ? thrown.message : 'Claude Code ended without a result')`.

`run`:
1. Create an `AbortController` and link it to `opts.signal` (abort now if already aborted, otherwise `once` on `'abort'`).
2. Iterate `queryFn({ prompt: opts.prompt, options: { ...buildQueryOptions(opts, ctx), abortController: ac } })` and yield the events from `mapMessage`.
3. Catch any throw; the SDK throws after an error result.
4. Finally yield `finalEvent(state, { resume: opts.resume, aborted: ac.signal.aborted, thrown })`.

- [ ] **Step 1: Write the failing tests** (no real Claude):
  - `options give full repo permissions but deny deploys`:
    - Call `o = buildQueryOptions({ cwd: '/repo', prompt: 'x', resume: 's1', systemPrompt: 'extra' }, { env: { PATH: '/bin', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 'g' }, oauthToken: 'o' })`.
    - Assert `cwd '/repo'`, `resume 's1'`, `permissionMode 'bypassPermissions'`, `allowDangerouslySkipPermissions true`.
    - Assert `disallowedTools` contains `'Bash(git push *)'`, `settingSources` is `['project']`, and `systemPrompt` toEqual `{ type: 'preset', preset: 'claude_code', append: 'extra' }`.
    - Assert `env` toEqual `{ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'o' }`.
  - `no resume key when not resuming`: `'resume' in o === false`.
  - `PreToolUse hook denies a composed push`:
    - Call the hook from `o.hooks.PreToolUse[0].hooks[0]` with `({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cd web && git push' }, session_id: 's', transcript_path: '', cwd: '/repo' } as any, 'tu1', { signal: new AbortController().signal })`.
    - It returns `hookSpecificOutput.permissionDecision === 'deny'`.
    - For `pnpm test` it returns `{}`.
  - `canUseTool denies and says why`: `o.canUseTool!('AskUserQuestion', {}, {} as any)` → `behavior 'deny'`, and the message contains `'AskUserQuestion'`.
  - `maps text and tool blocks`: an assistant message (`parent_tool_use_id: null`) with content `[{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }]` → `[{ type: 'text', text: 'Hi' }, { type: 'tool', name: 'Bash', input: { command: 'ls' } }]`.
  - `hides subagent messages`: with `parent_tool_use_id: 'x'` → `[]`.
  - `success result ends ok`: init `session_id 'abc'`, then result `success` → `finalEvent` toEqual `{ type: 'done', sessionId: 'abc', ok: true }`.
  - `error result carries the subtype`: result `error_max_turns` → `ok: false`, `error: 'error_max_turns'`.
  - `rejected rate limit becomes usage_limit`: `{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1760000000 } }` → error `'usage_limit:1760000000000'`.
  - `assistant rate_limit error becomes usage_limit`: error `'usage_limit'`.
  - `authentication failure explains the fix`: assistant `error: 'authentication_failed'` → `AUTH_FAILED_MESSAGE`.
  - `run yields done after the query throws`: a fake `queryFn` async generator yields an init (`session_id 'abc'`) and then throws `new Error('process exited')` → the last event is `{ type: 'done', sessionId: 'abc', ok: false, error: 'process exited' }`.
  - `run aborts`: a fake `queryFn` waits for `options.abortController.signal`'s `abort`, then throws. Aborting `opts.signal` → error `'aborted'`.
  - `live: answers with the subscription login`: `test.skipIf(!process.env.HUB_LIVE_CLAUDE)`. `new SdkClaudeRunner({ oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null })` in a temp dir, with prompt `'Reply with the single word OK and do nothing else.'` → some text event contains `OK`, and `done.ok === true`.
- [ ] **Step 2: Run** `pnpm -F @hub/server exec vitest run src/claude/sdk.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `sdk.ts`.
- [ ] **Step 4: Run** the same command. Expected: 13 pass and 1 skipped. `pnpm -F @hub/server typecheck` is clean.
- [ ] **Step 5: Commit** `apps/server/src/claude/sdk.ts apps/server/src/claude/sdk.test.ts` as `feat(server): Agent SDK runner with bypass permissions and a deploy-guard hook`, with the attribution trailer your harness provides.

---

