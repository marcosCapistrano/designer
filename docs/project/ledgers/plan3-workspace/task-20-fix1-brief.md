# Task 20 fix round 1 (from review ad27785257b12ea28)

Worktree /home/claude/wt-p3-20, branch p3-20. First run `git merge --no-ff feat/hub-server` (the integration branch has moved), then fix. Commit per item group. Run the full server suite and `tsc --noEmit` at the end.

## Important
I1. Request body size limit. In app.ts, right after `secureHeaders()` and before `authRoutes`:
`app.use('/api/*', bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'Request too large' }, 413) }))` (from 'hono/body-limit').
Tests: a 300 KB POST to /api/login with no cookie gives 413; a 300 KB POST to /api/apps/:app/build/messages with a cookie gives 413 and `build.send` is not called. Include one chunked upload with no Content-Length if app.request allows a ReadableStream body.

I2. CSRF layer. Ruling: accept. SameSite is per site, and the hub shares its site with staging apps on the same tailnet domain, so a script on a deployed app could drive build routes.
- Add `app.use('/api/*', csrf())` (from 'hono/csrf') after `secureHeaders()`.
- Make the first line of `onError` `if (err instanceof HTTPException) return err.getResponse();` so csrf's 403 is not turned into a 500.
- Tests: cookie + `sec-fetch-site: same-site` + text/plain body on /messages gives 403 and the service is not called; a bodyless same-site merge POST gives 403; cookie + `sec-fetch-site: same-origin` + application/json gives 2xx. Check that the existing client e2e/api calls still pass (they are same-origin JSON).

## Minor (all in this round)
M1. Non-Error throws bypass onError. Register first: `app.use('*', async (c, next) => { try { await next(); } catch (e) { throw e instanceof Error ? e : new Error(String(e)); } })`. Simplify `errorText` to `err.message`. Test: a backend that rejects with a string gives 500 JSON `{"error":"Internal error"}` with nosniff.
M2. Static route: 404 any request path with a segment that starts with '.', and refuse to serve a file whose realpath is outside clientDir (symlink escape). Tests: `/.env`, `/%2eenv`, `/.git/config`, a symlinked file and a symlinked directory pointing outside clientDir all give 404.
M3. `POST .../build/stop` on an app the registry doesn't know gives 404 (same shape as the other unknown-app responses). Do not apply APP_NAME_RE to build routes.
M4. Static traversal tests: `/%2e%2e/x` and `/..%2fx` give 404; a HEAD on /assets/x.js keeps the immutable Cache-Control.
M5. Correct the comment at app.ts:62-64 (and nothing else about it): the header is lost only with a native Response (the app.request() test path); under serve() the onFound form works; the wrapper is kept because it is right under both.
M6. Log line: log `JSON.stringify(c.req.path)` and the message truncated to 500 chars with newlines escaped (JSON.stringify does both).

Report: append a "Fix round 1" section to task-20-report.txt.
