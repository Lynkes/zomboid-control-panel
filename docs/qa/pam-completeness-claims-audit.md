# Pam's Completeness-Claims Audit — bughunt-2026-08-31-b

god generalized a method that had already paid off twice that night (the `mods.js` "three writers"
gap that led to the `templateFiles.js` whitespace-tolerance fix; Kevin's discovery that a
verify-enforcement allowlist's rationale comment was false about the code): grep the codebase for
comments asserting some sweep, fix, or set is *complete* ("every call site", "the three writers",
"brings the other N in line", "no other instance exists"), and check whether the enumeration still
matches current code.

## Method and denominator

Built an independent candidate list (regex on phrasings like "every call site/handler/route/caller",
"the N writers/places", "brings the other N in line", "no other instance", "N of N") across
`server/**/*.js`, excluding test files. That surfaced matches in ~40 files.

**Explicitly excluded: `server/utils/errorCodes.js` and `server/utils/progressCodes.js`.** Both are
wall-to-wall `/** server/routes/X.js (N sites: /route1, /route2, ...) */` doc comments cataloguing
where each error/progress *code* is used — call-site documentation, not a claim that a sweep or fix
is complete. Staleness there yields a stale usage note, not an unguarded path; a different and much
larger (~80 more candidates), lower-stakes category. Pulling them in would have diluted the audit
into a formatting review rather than a safety one.

After that exclusion: **37 real candidates** in non-doc source.

Of those 37:
- **~20 verified by grepping the actual current call sites/routes** (not by re-reading the comment)
  — the rigor level this write-up reports findings from.
- **A handful were self-evidently accurate on inspection** — the enumerated set is a literal array
  or a two-line function right above the comment, low risk of drift, not worth a full independent
  grep.
- **Several matched the regex but were not actually closed-set completeness claims** — generic
  architectural description ("every route below operates on a specific server's config",
  `serverFiles.js:72`) rather than an enumerated, checkable guarantee. Excluded from the finding
  count rather than padded in; a sentence describing what a file does is not the same shape as a
  sentence asserting a sweep found and closed every instance of something (Kevin's refinement:
  untested/non-enumerating has more than one cause, and only "nobody checked" predicts a bug).

**status: FIXED (comment corrected, no behavior change — as this doc's own author intended and applied within the same task)** — re-verified 2026-09-02, HEAD `5f913567`. `server/index.js`'s comment block around `checkServerStatusNow()` still names the `rconService.on("disconnected", ...)` handler as the second, independently-maintained site and states the actual current-vs-future-risk split accurately.

## FINDING (confirmed, fixed as a comment-only change): `server/index.js:2497`, `checkServerStatusNow()`

**Claim:** "Routing every 'did the running state actually change' decision through this ONE
function... means there is no second copy of `lastKnownRunning` anywhere left to drift out of sync
with this one." Added in commit `6a882ea9` (2026-08-26), fixing `POST /stop`'s blind
`server:status` emit (the route asserted a shutdown claim without ever touching `lastKnownRunning`,
so the watchdog's own comparison against its memory correctly saw no change and stayed silent while
clients had already been told something unconfirmed).

**FALSE.** `server/index.js:1219-1244`, the `rconService.on("disconnected", ...)` handler,
independently reads `getObservedServerRunning()`, compares against the *same* module-level
`lastKnownRunning`, and on a mismatch both mutates it and calls
`io.emit("server:status", {running:false})` — entirely outside `checkServerStatusNow()`.

**Wrong when written, not aged into falsehood:** `git log -L` on that handler shows it was last
touched 2026-08-25 — the day *before* the "no second copy" comment was written. The fix's own commit
message describes closing exactly one instance (the `/stop` route) and never mentions this sibling,
which sits in the same file, ~1300 lines away. The author enumerated one site and asserted a set.

**Severity, traced by hand in both directions before reporting it, not assumed:**
- Watchdog resolves first → sets `lastKnownRunning = false` and emits → the RCON-disconnect
  handler's own `lastKnownRunning !== false` guard is now false → it no-ops. No duplicate, no
  divergence.
- RCON-disconnect handler resolves first → sets `lastKnownRunning = false` and emits → the
  watchdog's next tick compares its fresh observation (`false`) against `lastKnownRunning`
  (already `false`) → sees no change → correctly stays silent. No duplicate, no divergence.

So this is **not currently a live defect** — the two sites share one variable and each guards
immediately before acting, so they cannot presently drift. What *is* real, and is the actual
substance of the finding: this is duplicated, independently-maintained logic that will **not**
inherit any future fix to `checkServerStatusNow()` — the exact property the 2026-08-26
centralization was built to guarantee, and the exact property the comment asserted held. It already
uses a different `logServerEvent` message (`"detected after RCON disconnect"` vs `"detected by
watchdog"`) for the identical event class. The next person fixing a status-drift bug will fix it in
one place, believe the comment, and ship half a fix.

**Fixed:** comment corrected in place (`index.js:2497` block) to name the second site and state what
is actually true — they share the variable, each guards before acting, so they don't currently
drift, but a future fix made only in `checkServerStatusNow()` won't reach the handler. **No behaviour
change.**

**status: STILL OPEN — deliberately deferred, not a bug** (re-verified 2026-09-02, HEAD `5f913567`). `server/index.js`'s `rconService.on("disconnected", ...)` handler (still at ~line 1233) remains a separate, independently-maintained implementation — has not been consolidated through `checkServerStatusNow()`. This is exactly as intended: the doc's author explicitly deferred this as a behavior-change item needing its own review, not an oversight or a regression. No live defect (the two sites still share one variable and each guards immediately before acting, so they cannot presently drift — see the FINDING above) — this is a code-quality/future-proofing improvement still awaiting its own review pass.

## CARDED, not fixed tonight: consolidate the RCON-disconnect handler through `checkServerStatusNow()`

**What:** Rewrite `server/index.js`'s `rconService.on("disconnected", ...)` handler
(`:1219-1244`) to call `checkServerStatusNow()` (the same way `POST /stop` was migrated to, in
`6a882ea9`) instead of independently reading `getObservedServerRunning()`, comparing against
`lastKnownRunning`, mutating it, and emitting `server:status` itself.

**Why not tonight:** this is a behaviour change on a live signal path (`server:status` emission
timing/dedup logic), and the tree is frozen to gate an 18-commit batch tonight. It deserves its own
review, not a tail-end addition to a batch already in flight (god's call).

**Why it's worth doing:** removes the last independently-maintained copy of this decision, so
`checkServerStatusNow()`'s claim becomes true again instead of merely corrected; unifies the two
divergent `logServerEvent` messages for the same event class; means a future improvement to
`checkServerStatusNow()` (e.g. richer Discord notification logic, additional confirmation steps)
reaches both trigger paths for free instead of one.

**Owner:** `server/index.js` is Dwight's file. Not touched beyond the one comment block, per the
explicit one-file, one-comment grant for this task.

## Two more low-severity wording overclaims (verified, not fixed — outside ownership, not worth a separate card)

**status: FIXED** (re-verified 2026-09-02, HEAD `5f913567` — fixed since this doc was written, which described it as "verified, not fixed"). `index.js:2014-2018`'s comment now explicitly names `POST /debug/client-errors` as the one deliberate exception, citing this exact finding ("bughunt-2026-08-31-b, completeness-claims audit") and stating it "was already false the day it was written" instead of claiming universality.

1. **`server/index.js:2014`**, the socket `subscribe:logs` gate comment: *"requires
   diagnostics.manage -- every route in that file [`debug.js`] is admin-only by design."* Literally
   false — `POST /debug/client-errors` is deliberately unauthenticated (its own comment says so
   explicitly, and `auth.js`'s middleware carries a matching dedicated exemption for it, both
   predating this comment). Doesn't undermine the socket gate's actual purpose — `client-errors` is
   write-only crash-report intake, not a log-reading route, so the thing the gate protects stays
   protected — but the literal "every route" is wrong. Recommend naming the one exception instead of
   claiming universality, next time that file is touched.
**status: FIXED** (re-verified 2026-09-02, HEAD `5f913567` — fixed since this doc was written, which described it as "verified, not fixed"). `server.js`'s `saveAndResolveSteamCmdExe` header comment now states "THE RULE, not a count of call sites" instead of the "single point every spawn() goes through" overclaim, explicitly citing this exact finding and its own falseness "the day it was written."

2. **`server/routes/server.js:92`**, `saveAndResolveSteamCmdExe`'s header (the 2026-08-27 CodeQL
   command-injection fix): *"The single point every spawn() of a SteamCMD-family executable in this
   file goes through."* One exception exists, and it's self-documented right at the site:
   `runFirstTimeSetup()` (~`:4185`) calls the lower-level `getSteamCmdExe()` directly, because it's a
   synchronous, fire-and-forget closure invoked from a spawn callback, and the security-relevant
   persist-before-use step already ran earlier in the same request. Safe in effect; "the single
   point every spawn() goes through" isn't literally true. Recommend softening to name the documented
   exception.

**status: NOT APPLICABLE — no defects, listed for coverage record only.** Not re-verified this pass; no code changed in these areas since the original check that would alter these verdicts.

## Cleared (verified against current code, not just re-read)

- `services/permissions.js:748` "the guard belongs here, in the service every caller goes through"
  (`deleteRole`) — exactly one live caller (`routes/permissions.js`).
- `services/auth.js`'s `PUBLIC_AUTH_PATHS` enumeration — cross-checked against every actual route in
  `routes/auth.js` and `routes/oidc.js`. Still accurate: every route is either in the set or
  correctly gated (`users.manage`/`admin`), and `oidc.js`'s own three public routes (status/login/
  callback) match while settings/test-connection correctly don't.
- `routes/oidc.js:4` "every route here degrades to a clear, safe response when OIDC isn't
  configured" — `/login` and `/callback` both check `isOidcConfigured()` first and return
  404/redirect rather than crashing; `/settings` and `/test-connection` are capability-gated
  regardless.
- `services/workshopCollectionSync.js:152` "the only exported reader -- every call site (here and
  routes/mods.js)" — grepped every call of `getSteamSessionCredentials()`; exactly those two files.
- `utils/browseRoots.js:7` "shared by every filesystem browse endpoint" — `confineToRoots()` has
  exactly the two named consumers (`serverFiles.js`, `chunks.js`) plus one unrelated use in
  `server.js` (a data-path-nesting check, not a browse endpoint). The one plausible gap checked —
  `server.js`'s `/list-directory`, an unconfined whole-filesystem picker for choosing a fresh
  install path — is intentionally unconfined by design (no "already-configured root" to confine to),
  not a missed consumer.
- `database/init.js:35` "riding along in every one of those [two db.json backup paths]" — grepped
  every wholesale `db.json` copy in the tree; still exactly two.
- `routes/discord.js:39` and `services/scheduler.js:612` — already directly verified in this same
  bug hunt's earlier rounds (dispatcher-completeness audit and odd-one-out sweep respectively).

Not exhaustive — 17 of the 37 candidates were not individually re-verified this round. The rate
above (1 confirmed wrong-when-written out of ~20 real verifications, plus 2 low-severity wording
overclaims) is the honest number this audit can stand behind; it is not "37 checked, 1 wrong."
