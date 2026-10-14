# SDD ledger — plan: docs/superpowers/plans/2026-10-14-renderer-canvas.md
Spec: docs/superpowers/specs/2026-10-14-hub-design.md; contract docs/superpowers/specs/2026-10-14-architecture.md
Branch: feat/renderer-canvas in worktree /home/claude/wt-p2 (base fecef7c = plan 1 through Task 6, + docs 691e7f0)
Execution: parallel lanes in worktrees off feat/renderer-canvas; implementers haiku, reviewers sonnet.
Dependency lanes: T1 root. Renderer: T2,T3,T5 after T1; T4 after T2+T3; T6 after T5; T7 after T4+T6 and plan 1 complete (merge plan 1 first). Client: T8,T11,T15,T18 after T1; T12 after T11; T13,T14 after T12; T16 after T15; T17 after T16; T19 after T13+T17; T20 after T19; T21 after T14,T18,T19,T20; T22 after T21; T9 after plan 1 merge + T8; T10 after T7+T9; T23 after T10+T22; T24 after T23.
Pre-flight: plan written by opus with self-review; per-task reviews are the net.
Task 1: implementer done 660eddb (DONE)
Ruling 1 (plan 2): lanes to limit package.json/lockfile merge conflicts: Lane R (worktree ../wt-p2r, branch p2r) runs T2,T3,T4,T5,T6 sequentially; Lane C (../wt-p2c, branch p2c) runs T8 then T11,T12,T13,T14,T18; later lanes branch from merged state. Each task is reviewed while the lane's next task builds; lanes merge into feat/renderer-canvas at checkpoints.
Task 1: complete (691e7f0..660eddb, review clean)
Task 1: minor (deferred): constants DEVICE_VIEWPORT_HEIGHT/DEVICE_LABEL/MAX_PAGE_HEIGHT/MANIFEST_PATH unasserted; readonly not frozen; vitest.config outside typecheck.
Task 2: implementer done ba529c2 on p2r (DONE_WITH_CONCERNS)
Task 8: implementer done 711fbc3 on p2c (DONE; lockfile re-resolved vitest peers; esbuild postinstall ignored, builds fine)
Ruling 2 (plan 2): client lanes off 711fbc3: lane C (wt-p2c) T11→T12→T13→T14; lane C2 (wt-p2c2) T15→T16→T17; lane C3 (wt-p2c3) T18. Lockfile conflicts at merge are resolved by re-running pnpm install.
Task 2: complete (660eddb..ba529c2, review clean)
Task 2: minor (deferred): tileKey doc should say css must be cssForDevice'd; key lacks BASE_CSS/renderer version (cache-bust needed if BASE_CSS changes); no empty-css test; sharp build script ignored (harmless).
Task 8: complete (660eddb..711fbc3, review clean)
Task 8: minor (deferred): @types/node ^22.20.5 vs ^22; check-size exits 0 with no .js files (should fail closed); no automated check-size test; two vite majors coexist.
Task 11: implementer done 3860004 on p2c (DONE; fitRect NaN on empty rect, unguarded)
Task 11: complete (711fbc3..3860004, review clean)
Task 11: minor (deferred): fitRect on empty rect gives scale 4 (NaN only if view == 2*padding) — Task 17 reviewer to check empty-page fit; rectsIntersect true for zero-width inside rect; clamp test doesn't check anchor; snapCamera can return -0.
Task 3: implementer done 73614df on p2r (DONE; launch.args replaces CHROMIUM_ARGS; index.ts loads playwright — client must not import @hub/renderer)
Task 15: implementer done 93c5d4a on p2c2 (DONE; no-IDB test passes without typeof guard)
Task 18: implementer done 91d2cc9 on p2c3 (DONE; no stub geom needed)
Ruling 3 (plan 2): lane R2 (wt-p2r2, branch p2r2 off 73614df) runs T5→T6 in parallel with lane R's T4; renderer index.ts conflicts resolved by union at merge.
Task 12: implementer done 4c40666 on p2c (DONE)
Ruling 4 (plan 2): lane C4 (wt-p2c4, branch p2c4 off 4c40666) runs T14 while lane C runs T13.
Agents (for fix-round resume): T3 a7424d2961e455392, T12 a70457fb4614c4684, T15 aad409d0f6d209641, T18 a5fdafabaeefe0c2a; dispatched T4 a2936f54ffb2c096d (p2r BASE 73614df), T5 a7cde4fe607c8bf31 (p2r2 BASE 73614df), T16 aecbb03a03a69a215 (p2c2 BASE 93c5d4a), T13 a43efd82a0fc79110 (p2c BASE 4c40666), T14 a4999d48a673a5932 (p2c4 BASE 4c40666). Reviews running: T3, T15+T18, T12.
Task 12: complete (3860004..4c40666, review clean)
Task 12: minor (deferred): frameAt right/bottom exclusive edges, row gap, outside point, layoutBounds([]) untested; redundant early return; it-names differ from brief labels.
Task 5: implementer done e61a351 on p2r2 (DONE; sequential encoding)
Task 3: complete (ba529c2..73614df, review clean)
Task 3: minor (deferred): idle-slot disconnect filter, FIFO, waiting stat, RangeError, close-with-waiters untested; close() races with in-flight launch/handoff give raw Playwright errors (never hangs); PoolOptions.launch needs JSDoc (args replaces CHROMIUM_ARGS); reused slots keep page state — T4 reviewer to check viewport set per job.
Task 14: implementer done 57e0bd6 on p2c4 (DONE; boxSelect O(k^2))
Task 4: implementer done c2f6f06 on p2r (DONE; report file read directly, no handback)
Task 16: implementer done 46e7424 on p2c2 (DONE; 9 tests incl LRU eviction)
Task 13: implementer done b01ffa9 on p2c (DONE)
Task 5: complete (73614df..e61a351, review clean)
Task 5: minor (deferred): no guard that PNG size equals width/height (stride garbles silently); padding only checked on right edge at one level; fixture recomputed per test; sequential encoding.
Task 14: complete (4c40666..57e0bd6, review clean)
Task 14: minor (deferred, FIX IN FINAL WAVE): boxSelect inner loop should scan descending (j=i-1..0) — 6x faster on nested maps, matters if marquee preview calls it per pointermove; float-edge epsilon if hit maps are unrounded (T4 rounds? check); edge tests (chain, order dependence, inclusive edges, empty map).
Task 6: implementer done b289efa on p2r2 (DONE; sequential writes; temp-dir cleanup)
Task 4: complete (73614df..c2f6f06, review clean)
Task 4: minor (deferred): short-page test doesn't check PNG dims; network-block test weak (DNS fails anyway); redundant slice; left/right overflow filter branches untested; JSDoc should say pages must come from BrowserPool.
Task 15: complete (711fbc3..93c5d4a, review clean)
Task 15: minor (deferred): no committed test for error swallowing (stub open to throw); createStore try/catch dead on idb-keyval 6.3 (comment it); hashOfId no-slash behavior undocumented.
Task 18: complete (711fbc3..91d2cc9, review clean)
Task 18: minor (deferred): duplicate down for tracked id is ignored, can't self-heal after lost up — consider reset on repeat id + public reset() for blur/visibilitychange (T21 to call); cancel/third-pointer/zero-distance/slop-boundary/wheel meta tests missing; pinch emits pan{0,0} every move (T21 heads-up).
Task 13: complete (4c40666..b01ffa9, review clean)
Task 13: minor (deferred): frameTiles tests all at origin frame (offset regressions undetected); fallbackFor null branches untested.
Task 16: complete (93c5d4a..46e7424, review clean)
Task 16: minor (deferred): malformed-cache fallback, retry after rejected load, remember-on-cache-hit untested; load awaits cache.put.
Checkpoint merge: feat/renderer-canvas 0a199cd = plan 1 (2903d08) + lanes p2r(T2-4) p2r2(T5-6) p2c(T8,11-13) p2c3(T18) p2c4(T14). 440 tests pass, typecheck clean. p2c2 (T15-17) merges after T17.
Ruling 5 (plan 2): plan 1 merged at 2903d08 (pre-T13) so T7/T9 can start; T13 adds tests and narrows exports only (exportPage stays). Re-merge plan 1 after its final review.
Ruling 6 (plan 2): T7 on lane R3 (wt-p2r3, p2r3 off 0a199cd); T9 on lane G (wt-p2g, p2g off 0a199cd).
Task 6: complete (e61a351..b289efa, review clean)
Task 6: minor (deferred, FIX IN FINAL WAVE): isExistsError swallow wraps writeFile loop too — EPERM on write returns success with nothing stored; put rename in own try and confirm hasLevel after swallow. Also: race-collision test missing; filename duplicated vs tilePath; parseManifest doesn't check pages array; Memory store aliases Buffer.
Task 17: implementer done 90ef13f on p2c2 (DONE_WITH_CONCERNS: default now = Date.now per brief)
Ruling 7 (plan 2): an injectable clock defaulting to Date.now (Task 17 `now` option) is allowed; the "no Date in src" rule targets hidden time dependence in pure logic, and tests inject `now`. — cost if wrong: none (seam exists).
Checkpoint merge b503877: + p2c2 (T15-17). 462 tests pass.
Ruling 8 (plan 2): view lane V (wt-p2v, p2v off b503877) runs T19→T20→T21→T22.
Agents: T7 a41a47dd702b5d134 (p2r3 BASE 0a199cd), T9 a8d8554eb9ca39fee (p2g BASE 0a199cd), T19 a52d512dafba1bae7 (p2v BASE b503877), T17 implementer ab00e5251a9aeca04; T17 review running.
Task 17: complete (46e7424..90ef13f, review clean)
Task 17: minor (deferred): replaced-image close branch unreachable+untested; failed-clear untested; onLoad throw counts as failed; failed map never pruned; maxImages<=0 unguarded (negative loops forever — FIX IN FINAL WAVE: clamp); corrupt cached blob never falls back to source; eviction test doesn't assert survivor not closed. Contract for painter (T19): don't hold get() results across frames.
Task 7: implementer done 6ed1275 on p2r3 (DONE_WITH_CONCERNS: store write errors -> failed w/ last-good; subset devices drop other renders)
Ruling 9 (plan 2): renderDoc with a device subset carries prev renders of the other devices over unchanged (pages that still exist), so the manifest never loses a device's render. — reasonable-person expectation (Design area shows device toggles) — cost if wrong: stale renders kept for hidden devices, refreshed on next full render.
Task 9: implementer done ede500b on p2g (DONE)
Ruling 10 (plan 2): T10 on lane H (wt-p2h, p2h = p2g + p2r3 merge). T7 fix round (Ruling 9) merges in later.
Task 19: implementer done 7d5c0dc on p2v (DONE; viewport field unused; dpr-only change no full repaint)
Agents: T10 a4921a7abe6b7f195 (p2h BASE: p2h merge HEAD), T20 acb8bf7b200a526dd (p2v BASE 7d5c0dc), T19 impl a52d512dafba1bae7, T7 impl a41a47dd702b5d134, T9 impl a8d8554eb9ca39fee. Reviews running: T7, T9, T19.
Task 7: review ❌ Important: Ruling 9 absent. Fix round 1 sent (Ruling 9 + hasLevel throw = miss + levels copy + tests for failure fallback, hasLevel false, concurrency cap, no error key). Accepted: store write error = per-entry failure. Minors deferred: default sort vs code-point; sequential hasLevel.
Task 20: implementer done dba695d on p2v (DONE)
Task 9: complete (0a199cd..ede500b, review clean)
Task 9: minor (deferred): seq test should assert meta.seq === nextSeq(doc); prefix test only gen-02; no mulberry32 reference vector; seed>>>0 aliases.
Task 21: dispatched a9a3026370f19cc7f on p2v (BASE dba695d). Task 20 review running.
Task 20: complete (7d5c0dc..dba695d, review clean)
Task 20: minor (deferred): frame offset untested (frame at origin); box fill/order + multi-box untested; no save/restore; marquee not snapped.
Task 10: implementer done 4bd069c on p2h (DONE; parseArgs validation beyond brief)
Task 19: review ❌ Important: (1) dpr-only change leaves stale frame; (2) label wider than frame truncated by strip/dirty repaints.
Ruling 11 (plan 2): painter stores dpr in Last and forces full on dpr change; label cull rect ignores the frame's right bound (x from label start to canvas width W). — brief's label rect is a plan defect — cost: small over-redraw of labels.
Task 19: fix round 1 runs in wt-p2vf (branch p2vf off dba695d) because T21 is committing in wt-p2v; p2vf merges into p2v after T21. T21 reviewer must check resize() calls painter.invalidate().
Task 7: fix round 1 committed 7bfeb45; re-review dispatched.
Task 7: complete (0a199cd..7bfeb45, re-review: all addressed)
Task 7: minor (deferred): renderDoc doc comment should mention subset carry-over; default sort vs code-point; sequential hasLevel.
Task 10: complete (6f64b42..4bd069c, review clean)
Task 10: minor (deferred): serve-renders test doesn't pin 404-vs-index fallback nor traversal; parseArgs validation untested; .dev-renders path duplicated; sirv serves dotfiles.
Checkpoint merge 35e7c4c: + p2h (T9, T10) + p2r3 (T7 fixed). 490 tests pass, typecheck clean. Remaining: T19 fix (p2vf), T21 (p2v), T22, T23, T24.
Task 19: fix round 1 committed 5475c36 on p2vf; re-review dispatched.
Task 21: implementer done 29b4ba1 on p2v (DONE_WITH_CONCERNS: resize invalidates painter; tile index rebuilt per relayout; left stray /controller.bak at filesystem root — subagent's delete was blocked; not deleted by controller (agent-requested action after a block), surfaced to user instead)
p2vf (T19 fix) merged into p2v.
Agents: T22 af24f9dde74c577d9 (p2v BASE 6a72c5e); T21 impl a9a3026370f19cc7f; T21 review running; T19 re-review running.
Task 19: re-review 1: findings 1,2,4,5 addressed; 3 NOT (save/clip leak on throw). Fix round 2 sent (try/finally restore + fakeCtx save depth), in p2vf.
Task 21: review ❌ Important: stale hitMaps.load rejection can clear selection under newer manifest. Fix round 1 in wt-p2vc (p2vc off 6a72c5e) since T22 commits in wt-p2v.
Task 19: fix round 2 2163f6d (try/finally restore; fakeCtx save depth; RED shown). Controller verified diff directly (body wrapped, restore in finally).
Task 19: complete (b503877..2163f6d across p2v+p2vf)
Task 19: minor (deferred): viewport field unused; diagonal pan repaints corner twice; fakeCtx has no clip state; LABEL_MIN_SCALE, frame culling, dirty-rect clamp untested.
Pending merges into p2v after T22 commits: p2vf (2163f6d), p2vc (T21 fix).
Task 22: implementer done ed757f6 on p2v (DONE; no unit test per brief; headless smoke 16/16; mount order manifest-then-subscribe race noted for plan 3)
Task 22: complete (6a72c5e..ed757f6, review clean)
Task 22: minor (FIX IN FINAL WAVE): disposed check inside requestFrame/onLoad wrappers; .then(ok).catch(err) so a bad manifest shows canvas-error. Plan 3 carry: route initial + subscribed manifests through one function (setManifest + gc + ordering guard), clear canvas-error on success.
Task 21: fix round 1 b734940 on p2vc (manifestGen guard + tests); merged p2vc->p2v; p2v merged into feat/renderer-canvas.
- Task 21 re-review (fix b734940, manifestGen): all findings addressed. Task 21: complete
Task 23: implementer done 29be7df on p2e (DONE_WITH_CONCERNS: reuseExistingServer local; added images>0 guard + expect.poll)
Task 23: review ✅ Approved (minors: no positive control on cold-load tile filter; setCamera+idle before paint; reuseExistingServer local; local page-API types). Task 23: complete (b848da1..29be7df)
Task 24: implementer done f06e698 on p2e (DONE_WITH_CONCERNS: CI not run remotely; perf measured only here; no RED). Merged p2e → feat/renderer-canvas.
Task 24: review ✅ Approved. Task 24: complete (29be7df..f06e698). All 24 tasks complete; final whole-branch review (opus, a62ae0d831596ef11) running on 2903d08..5dd6c25.
Task 24 minors (FIX IN FINAL WAVE): perf test should assert camera advanced and framesPainted increased during the pan; first remote CI run is the real perf check.
Final review (a62ae0d831596ef11): With fixes — Important I1 (tile LRU thrash when wanted > 128), I2 (unmount frees nothing), I3 (perf gate not tablet-sized); Minors M1–M8. Report: final-review-report.md.
Ruling 12: the final fix wave runs as three lanes by file area — G1 client canvas core (loader, controller, CanvasView, gestures, hitmap), G2 perf gate + pan path (e2e, playwright config, painter/pan), G3 renderer package — for speed; overlap only in controller.ts, resolved at merge. — cost if wrong: one merge conflict.
Ruling 13: M3 accepted: tileKey mixes in RENDER_VERSION = '1' (exported from renderer keys.ts) ahead of html; architecture contract tile-key line amended. — renderer changes must invalidate cached tiles on server and tablet — cost if wrong: one re-render of every page (no production tiles exist).
Ruling 14: M1 is fixed renderer-side in plan 2 (CSP meta, deterministic failure on main-frame navigation, tests incl. file://). Rejecting meta/base/link/script/iframe/frame/object/embed in design-model validation and in the sync extractor is carried to plan 5. — plan 1 is closing — cost if wrong: such a page fails deterministically with a badge until plan 5.
Ruling 15: M2 (Chromium OS sandbox) deferred to plan 6 and promoted to Important there (renderer moves onto the hub). Tests here run as root, where the Chromium sandbox cannot start. — cost if wrong: none before plan 6.
Ruling 16: I3: perf gate models the Tab S6 Lite (1333×800, deviceScaleFactor 1.5), adds a ctrl-wheel zoom phase, asserts median and p90 frame time, camera advanced and framesPainted increased (T24 parked). If the tablet profile misses the plan's thresholds, G2 reduces per-frame full-canvas copies (CSS-transform pan during drag, repaint on settle) and reports numbers; the controller rules if software raster still can't meet it. — CI is the only perf gate before hardware — cost if wrong: a stricter test.
Parked items in the wave: T6 putTiles swallow + parseManifest pages check (G3); T14 boxSelect descending + edge tests (G1); T17 maxImages clamp (G1); T22 disposed guard, manifest .catch → canvas-error, one manifest path with ordering guard (G1); T24 camera advanced/framesPainted (G2). M6 → document one-manifest-per-cache in canvas/index.ts (plan 3 Task 26 already uses per-app caches).
- G3: done 4793304..37dc652 on p2-g3 (94 renderer tests; iframe chrome-error blank in this Chromium — regression guard only; any meta refresh fails the render deterministically; FsTileStore takes optional injectable StoreFs). Merged into feat/renderer-canvas. Contract amended (plan doc in repo + shared plan + architecture.md).
- G1: done 8a4a4b8..c38ed82 on p2-g1 (177 client tests; extracted createCanvasRuntime in runtime.ts for DOM-free dispose tests; lostpointercapture cancels that pointer id (blanket reset would kill the remaining pan after a pinch); setManifest doesn't re-arm the fit after setCamera; M6 docs only). Merged into feat/renderer-canvas.
- G2: done af05e4e..25d2797 on p2-g2 (tablet profile perf: before pan 30/66.7, zoom 30/66.6; after 3 runs pan 60/33.4, zoom 60/16.7; 1 of 20 pan phases p90 49.9 under full-suite load; e2e 11/11; unit 197).
Ruling 17: pan uses ping-pong base canvases instead of the brief's preferred CSS-transform pan — measured cause was the self-blit; exact pixels, no hit-test change — cost: two 9.6 MB canvases on the tablet.
Ruling 18: zoom gestures preview by CSS transform of the last frame and repaint ~150 ms after the last event (or when the ratio leaves 0.5–2) — full repaint per frame measured 30 fps — cost: blurry mid-gesture; confirm on hardware in plan 8. Pan p90 ≤ 34 ms threshold kept; revisit only if CI flakes.
Merged p2-g2 → 9acdb10. Fix wave complete; scoped re-review of 5dd6c25..9acdb10 dispatched.
Final fix wave re-review (a5945a097536e73d9, 5dd6c25..9acdb10): All findings addressed. I1 verified (144 tile calls flat over 4000 ticks vs 88,144 before); I2 across 60 seeds; M1, M3, M4, M5, M7, M8 verified; parked T6/T14/T17/T22/T24 addressed. Gates: typecheck clean, client 197, renderer 94, e2e 11/11.
Residual minors (parked): N1 pan perf is load-sensitive (first remote CI run is the real check); N2 zoom phase asserts only the median; N3 tiles beyond 128 never load at MIN_SCALE; N4 stale tile-key formula at plan doc lines 7, 188, 206 (fixed in docs commit below if trivial); N5 duplicate canvas-base testid.
Plan 2: final review clean. Next: finishing-a-development-branch (PR stacks on plan 1's feat/design-engine).
Merged feat/design-engine (F5, F6) → 8bf248c; typecheck clean; protocol 2, design-model 811, renderer 94, client 197; e2e 11/11 (CI=1). Pushed; PR #2 (base feat/design-engine, stacked on PR #1). Subscribed.
CI green on GitHub for PR #1 (526d001) and PR #2 (8bf248c), incl. the tablet perf gate. Waiting on the user to merge.
Merged to main at the user's request: PR #1 → 8ed60ff, PR #2 (retargeted to main) → 23f2b92; main tree = 8bf248c tree.
