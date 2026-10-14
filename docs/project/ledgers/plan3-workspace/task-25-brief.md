### Task 25: Build area UI

**Files:**
- Create: `apps/client/src/areas/build/BuildArea.tsx`, `apps/client/src/areas/build/TaskCard.tsx`, `apps/client/src/areas/build/build.css`

**Interfaces:**
- Consumes: Task 22 (`ApiClient`, `ApiError`, `WsClient`), Task 23 (`BuildView`, `EMPTY_VIEW`, `applyState`, `applyServerMsg`, `lastMessageId`, `summarizeTask`).
- Produces:

```tsx
export function BuildArea(props: { app: string; api: ApiClient; ws: WsClient }): JSX.Element;
export function TaskCard(props: { task: BuildTask; running: boolean; onMerge: () => Promise<void>; onClose: () => Promise<void> }): JSX.Element;
```

`BuildArea`:
- **Loading and live updates:**
  - Mount: `api.buildState(app)` → `applyState`. Subscribe with `ws.on(m => setView(v => applyServerMsg(v, app, m)))`.
  - Catch-up: `ws.onStatus(s => s === 'open' && refetch(lastMessageId(viewRef.current)))` refetches with `after` and applies the result. Keep a `viewRef`.
  - Unsubscribe both on unmount.
- **Layout:** a full-height flex column with the TaskCard at the top, then the message list, then the composer.
- **Message list** (`data-testid="build-messages"`, scrollable):
  - One element per message with `data-testid={`msg-${kind}`}`.
  - `user` messages are right-aligned bubbles. `assistant` messages are left bubbles with `white-space: pre-wrap`. `tool` messages are small, gray and monospace. `status` messages are small and italic. `error` messages are red.
  - Auto-scroll to the bottom on new messages when the list was within 80 px of the bottom.
- **Composer:**
  - `<textarea data-testid="build-input" placeholder="Ask Claude to change this app…">` and `<button data-testid="build-send">Send</button>`.
  - Send is disabled while the trimmed text is empty, `view.running` is true, or a send is pending. Ctrl/Cmd+Enter sends.
  - On success, clear the input. An `ApiError` message shows in `data-testid="build-error"`.
  - `<button data-testid="build-stop">Stop</button>` is visible only while running and calls `api.stopBuild(app)`.
- **TaskCard** is rendered when `view.task` is set. `onMerge` and `onClose` call `api.merge`/`api.closeTask` and apply the returned task.

`TaskCard` (`data-testid="task-card"`) shows:
- the title, and the branch in monospace;
- `data-testid="task-status"` with `summarizeTask(...).label`, colored by `tone`;
- when `prUrl` is set, `<a data-testid="pr-link" href={prUrl} target="_blank" rel="noreferrer">PR #{prNumber}</a>`;
- `data-testid="ci-state"` with the raw `task.ci` text;
- `task.error` in `data-testid="task-error"`;
- `<button data-testid="merge" disabled={!canMerge}>Merge</button>`, showing `Merging…` while pending, with `mergeHint` below it and errors in `data-testid="merge-error"`;
- `<button data-testid="close-task">Close task</button>`, only when the task is open (not merged or closed) and not running.

- [ ] **Step 1: Implement** the three files. Browser behavior is tested in Task 28.
- [ ] **Step 2: Verify:** `pnpm -F @hub/client typecheck && pnpm -F @hub/client build && pnpm -F @hub/client size` passes, with total < 150000.
- [ ] **Step 3: Commit** `apps/client/src/areas/build` as `feat(client): Build chat with streaming, PR and CI status, Merge`, with the attribution trailer your harness provides.

---

