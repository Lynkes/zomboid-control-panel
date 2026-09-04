> **RECONCILED 2026-08-24 (fork):** FIXED — all 29 dead branches across all 9 commits in the table
> below verified against current source. Confirmed all 9 commit hashes exist and match their
> described work exactly (`git show --stat -s <hash>` for each). Spot-checked that the fixes are
> durable (not reverted by a later commit): the most recent commit touching `WorldMap.tsx` is
> `dff85f4`, an unrelated later feature commit, not a revert of `f234e77`. This document is itself a
> completed-work retrospective (every row already names its fixing commit), not an open-findings
> list — nothing here needed re-derivation, only verification that the named commits are real and
> still in effect. No LIVE or INVALID items.

**status: FIXED — all 29 dead branches across all 9 commits, document-level verdict** (re-verified
2026-09-02, HEAD `5f913567`; superseded the per-row status this file otherwise lacks). All 9 commits
(`f234e77`, `99163ea`, `8bee6d8`, `1734625`, `ffb2e4b`, `0206bee`, `29fdcdd`, `247b50b`, `82d8695`)
confirmed still ancestors of current HEAD via `git merge-base --is-ancestor`. This document is itself
a retrospective ledger (every row already names its own fixing commit) rather than a set of open
claims needing individual re-derivation — the 2026-08-24 fork's per-commit `git show` verification
plus this pass's ancestry re-check is the appropriate depth of check for a table of already-landed,
self-citing fixes.

# Jim's Dead-Else-Branch Sweep — full reasoning

Angela found the first instance of this bug class (an OIDC test-connection handler). God gave me
her fix as the reference pattern and ~12 candidate sites from his own grep as a starting list, not
a verdict. This doc is the reasoning that list turned into: why the mechanism is universal, how to
tell a dead branch from a live one without re-deriving it, and the full denominator.

## The mechanism, and why it's universal in this codebase

`client/src/lib/api.ts`'s `handleResponse()` throws in exactly two cases:
1. Any non-2xx HTTP status.
2. An HTTP 200 body whose JSON has `success === false`.

Every `apiGet`/`apiPost`/`apiPut`/`apiDelete` call goes through `handleResponse()`. So a caller
written as:
```js
const result = await someApi.doThing()
if (result.success) { /* A */ } else { /* B */ }
```
can **never** reach branch B through a normal failure — by the time `someApi.doThing()` resolves
without throwing, `result.success` is already guaranteed true, because ANY failure (however the
server produced it) already threw on the `await` line above. B is dead code: syntactically present,
semantically unreachable.

This holds regardless of *how* the server signals failure. I checked ~20 different routes before
trusting the generalization, and found servers fail in two different shapes that both collapse to
the same client-side throw:
- **Non-2xx status** (`res.status(400).json({...})`) — the ordinary REST convention, used by most
  routes. `!response.ok` catches it.
- **200 with `success: false` in the body** — used by routes that relay a service function's own
  result object as-is (`res.json(result)`, no branching on `result.success` at the route level).
  Several service functions genuinely *resolve* `{success: false, error}` rather than rejecting —
  `rconService.execute()`, `PanelBridge.ping()`, `backupService.deleteBackupsOlderThan()` all do
  this for their normal failure paths. Doesn't matter: `handleResponse()`'s `success === false`
  check catches this shape too, so the caller still never sees it.

**The one-line rule for classifying a new call site:** trace the API function backward to its route.
If EVERY failure path in that route either returns non-2xx or relays a body that can contain
`success: false`, the caller's else-branch is dead — full stop, doesn't matter which of the two
shapes, doesn't matter whether the underlying service function throws or resolves with false. You
do not need to trace further than "does this route ever send a failure as a 2xx body with no
`success` field at all" — if the answer is no, you're done, it's dead.

## The three genuinely-alive exceptions, and why

A call site is only genuinely reachable-on-failure if it **bypasses `handleResponse()` entirely**.
Found three:
- `Debug.tsx`'s `authFetch` → `apiFetch` returns the raw `Response`; the caller does
  `res.json()` itself and checks `data.success` manually. Never throws on failure — the else
  branch is the only place failure is ever handled.
- `ServerFinder.tsx` does the same: raw `apiFetch` + manual `.json()`.
- `ServerSetup.tsx`'s `handleInstallComplete` reads `data.success` from a **socket.io event
  payload**, not an HTTP response at all. `handleResponse()` never enters the picture.

If you find a call site like this — raw fetch, or a non-HTTP data source — stop, it's not part of
this bug class, leave it alone. A sweep that "fixed" these by deleting the else would have broken
real, working error handling while reporting a bigger number.

One more shape that looks like it might be an exception but isn't: `if (result.success) { A }` with
**no else at all**. Not dead code in the harmful sense (there's nothing to be unreachable), just an
oddity — skip it, it's not a finding either way.

## The full denominator: 29 dead, 3 alive, N no-else-skipped

Total genuinely dead branches found and fixed across the whole client: **29**, across 8 files, 9
commits. Grepped `\.success\)\s*\{` AND `\.success\s*(===|!==)` app-wide — the first pattern alone
missed several `=== false` / `!== true` style checks (Debug.tsx, Servers.tsx both had these; the
first grep pass would have under-counted).

| File | Count | Commit |
|---|---|---|
| WorldMap.tsx | 9 | f234e77 |
| Settings.tsx | 6 | 99163ea |
| Debug.tsx | 5 (2 first pass + 3 second pass) | 8bee6d8, 1734625 |
| Console.tsx | 2 | ffb2e4b |
| Backups.tsx | 3 | 0206bee |
| Servers.tsx | 2 | 29fdcdd |
| Chat.tsx | 1 | 247b50b |
| Events.tsx | 1 | 82d8695 |

**13 of the 29 were real, user-visible bugs** — the dead branch held meaningfully different or more
useful copy than what the code path that actually runs (the `catch` block) ever showed:
- All 9 in WorldMap.tsx. Worst: the five vehicle context-menu actions (repair/fuel/battery/remove/
  hotwire) had a catch that showed a bare `{title: 'Error'}` toast with **no description at all** —
  every real failure was completely unexplained, while the dead branch had a specific title plus the
  actual error text.
- 2 in Settings.tsx: `handlePingMod` (dead branch had the specific "Mod Did Not Respond" title +
  an "Open Bridge" action button for the two most common real failures; every real failure instead
  showed generic "Ping Failed" with no action button) and the panel-update download handler (dead
  branch called `setPanelUpdatePreflight(...)` to surface blockers in the UI — never happened on a
  real failure).
- 2 in Console.tsx — structurally different from the rest, not just a title mismatch. `executeCommand`
  and `sendAnnouncement` had the ENTIRE post-command handling (live-log entry, command cache/history,
  the connection-status heuristic) gated on the unreachable success path. A failed RCON command
  didn't just show the wrong toast, it vanished from the console entirely instead of appearing like a
  real terminal would. This is the one place I didn't just "delete the else, move the message" —
  I restructured to catch the error and reconstruct the `{success, error}` shape so both paths get
  the same post-processing, and said so explicitly rather than quietly inventing a second pattern.

**16 were dead-but-harmless** — the branch that actually runs (the `catch`) already shows the exact
same title/message the dead branch would have, usually because the dead branch just re-threw into
that same catch (`throw new Error(result.message || fallback)` sitting right above a catch that does
`error.message || fallback`). Still cleaned up: an unreachable branch invites the next person to
"fix" it and believe they achieved something, and it's one extra place a title string can drift out
of sync with the code that actually runs.

## Fix pattern (Angela's, not reinvented)

Delete the dead branch. If it re-threw into the same catch (harmless case): just remove the
`if`/`else`, keep the success path unconditional, done. If the dead branch had better copy (real
bug): move that copy into the `catch`, reading from the caught error's message instead of the
never-populated `result.error`/`result.message`. Add a one-line comment naming which route/service
function makes the branch dead, so nobody re-adds it during a future edit without re-deriving this.
