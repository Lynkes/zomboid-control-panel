# Kevin's Adversarial Findings — Scheduler, Chat, Players

Assigned by god to pick up where Toby ran out of budget: adversarial input on the three screens
nobody had attacked yet. Toby's starting examples (negative countdowns, broadcast length, ban
reasons) are covered below, alongside what they led to. Tested against a throwaway server
directory only, per the standing boundary — no real Zomboid install touched. Every finding below
is proven by tracing the actual code path end to end and, where the claim is about behaviour
rather than just code shape, forcing it to happen (a real function call against a real mocked
dependency, not a read-through guess).

Priority order follows god's brief: (1) input reaching the game server, (2) accepted input that
silently misbehaves, (3) whether refusals are honest, (4) non-ASCII/long input a French operator
would actually type.

---

> **RECONCILED 2026-08-24 (fork):** FIXED at `4a7dc86` ("fix(scheduler): require rcon.execute for
> raw scheduled commands; label manual restarts"). All three paths that can produce or trigger a
> raw-classified command (`POST /tasks` create, `PUT /tasks/:id` update, `POST /tasks/:id/run`
> manual trigger) now call `requireCapabilityInline('rcon.execute', req, res)` when
> `classifyScheduledCommand(command) === 'raw'` (confirmed at `scheduler.js:174-175, 253-254,
> 368-369`). Also independently confirmed live tonight by a separate hunt-fork, which specifically
> re-checked the edge case this finding implies is hardest — a task created by someone who HAD
> rcon.execute, later run by someone who no longer does — and found the run-time check re-verifies
> the CALLER's current capability, not whoever created the task. Verified by reading current source.

## FINDING 1 (High): `automation.manage` silently grants full raw-RCON execution — a capability the Roles screen presents as a separate, unrelated toggle — WHERE: `server/routes/scheduler.js:26` (router-level gate) + `server/services/scheduler.js:266-274` (`executeTask`'s fallback branch)

**WHAT HAPPENS:** A custom role holding `automation.manage` ("Create and edit automated restarts,
backups and other scheduled jobs" per its own label/description in `services/permissions.js:202-206`)
and explicitly **not** `rcon.execute` ("Connect to RCON and execute arbitrary console commands",
`permissions.js:122-126`) can still run any raw RCON command it wants, unaudited, via the
scheduler.

**HOW:** `scheduler.js` gates its entire router on one capability only:
```js
router.use(requirePermission('automation.manage'));
```
`POST /tasks` accepts a `command` string validated only for type and length (≤2000 chars, plus a
cron-expression sanity/frequency check that has nothing to do with the command's content). When
that task fires — either on its cron schedule, or immediately via `POST /tasks/:id/run` (same
`automation.manage` gate, no extra check) — `Scheduler.executeTask()` special-cases exactly four
prefixes (`restart`, `save`, `servermsg `, `bridge:`) and falls through to:
```js
// Execute as raw RCON command - skip logging for scheduled tasks
const result = await rconService.execute(task.command, { skipLog: true });
```
This is the *exact same primitive* `routes/rcon.js`'s `POST /execute` uses — which that file's own
header comment identifies as "meaningfully more powerful than the specific, validated actions in
players.js... includes things like `quit` that can shut the server down" — and deliberately gates
behind `rcon.execute`, admin+technician only, explicitly excluding moderator. The scheduler path
reaches the identical primitive while checking a capability whose own description never mentions
RCON or a console at all.

**HOW I KNOW (forced, not read-through):** Wrote a standalone vitest file, ran it, watched it pass,
then deleted it (not shipped — I don't own `scheduler.js`/`services/rcon.js`/`permissions.js`, so
this is a report, not a fix). Two things it proved directly:
1. A real `Scheduler` instance, given a task `{ command: 'godmod "attacker" true' }` with no
   special-case prefix, calls a mocked `rconService.execute()` with that string **verbatim** and
   `{ skipLog: true }`.
2. A regex sweep of `scheduler.js`'s source finds exactly one `requirePermission(...)` call in the
   whole file — `'automation.manage'` — and it is never paired with `'rcon.execute'` anywhere.

**WHY THIS MATTERS BEYOND "technically true":** the Roles & Permissions screen (confirmed a real,
supported feature — Toby created a custom role there, and I built and tested custom-role deletion
against it this session) lets an admin build fine-grained roles from the capability matrix. Someone
building, say, a "Backup Operator" role who ticks "Manage scheduled tasks" to let that person
configure backup/restart automation, while deliberately leaving "Run RCON commands" unticked, gets
a role that can still shut the server down (`quit`), ban anyone, or run any GM command — by
creating one scheduled task per command and clicking "Run now". Nothing in the UI's own capability
description would tell them that. It's also invisible after the fact: the raw-command path passes
`skipLog: true`, so it never appears in `routes/rcon.js`'s command history (`GET /rcon/history`) the
way the audited `/execute` route always does — only in Schedule History, under the task's own name,
not flagged as "ran an unrestricted console command."

**WHAT SHOULD HAPPEN:** either (a) `executeTask`'s raw-command fallback should require the acting
task's `automation.manage` grant to ALSO carry `rcon.execute` — checked at task-creation and/or
task-run time, not just automation.manage — or (b) the raw-fallback branch should be removed
entirely and unrecognised commands rejected, with `bridge:`/`servermsg `/`restart`/`save` as the
complete, closed set `automation.manage` alone is meant to reach. (b) is probably cleaner: nothing
in the feature's description implies "run arbitrary console commands" was ever the intent.

**Severity: High.** This is a real privilege-escalation path reachable by any role an admin builds
with only `automation.manage`, with a working exploit two clicks deep in the UI (create task, run
now), and it's silent to both the operator granting the role and the RCON audit trail.

---

> **RECONCILED 2026-08-24 (fork):** FIXED at `dff7dd2` ("fix(rcon): unify ban-reason and broadcast
> text folding, transliterate accents"). A shared `foldToRconAscii()` helper now normalizes curly
> quotes/dashes/ellipsis AND transliterates the full accented-Latin range via
> `LATIN_TRANSLITERATION_MAP` (confirmed é→e, à→a, ç→c, œ→oe, etc. — real French coverage, not a
> partial table) BEFORE `sanitizeForBanReason()` applies its punctuation whitelist
> (`rcon.js:1273-1283`). Re-ran the exact repro from this finding by hand against the current
> mapping: "répété" → "repete" (not silently dropped to "rpt"), "à" → "a" (not vanished), the curly
> apostrophe in "d'autres" now folds to a straight `'` before the whitelist (survives) instead of
> being silently dropped. `serverMessage()` and `sanitizeForBanReason()` now share the same folding
> logic, closing the inconsistency this finding specifically called out. Verified by reading current
> source.

## FINDING 2 (Medium): Ban reasons the panel accepts and logs as-typed get their accented characters silently deleted before reaching RCON — a curly-quote/accent handling gap `serverMessage()` in the SAME file already solved — WHERE: `server/services/rcon.js:1166-1180` (`sanitizeForBanReason` / `banPlayer`), contrast with `:1092-1104` (`serverMessage`)

**WHAT HAPPENS:** `POST /players/ban` validates the `reason` field with `players.js`'s
`SAFE_TEXT_REGEX`, which explicitly includes `À-ɏ` (Latin-1 Supplement + Latin Extended-A
— exactly the accented range a French operator's ban reason needs). A French reason is accepted,
no rejection, and `logPlayerAction(username, 'ban', 'IP: ..., Reason: ' + reason)` writes the
**original, accented** text to the panel's own persistent activity log. But the string that
actually reaches the game server via `banuser "..." -r "..."` goes through a *second*, different
sanitizer — `rcon.js`'s own `sanitizeForBanReason()` — which is a bare allow-list with no accented
range and no smart-quote normalization:
```js
sanitizeForBanReason(input) {
  return String(input).replace(/[^a-zA-Z0-9\s.,!?'-]/g, "").substring(0, 100);
}
```

**HOW I KNOW (forced, not read-through):** ran the actual function against real French input:
```
INPUT:          Comportement toxique répété, insultes à d'autres joueurs
SENT TO RCON:   Comportement toxique rpt, insultes  dautres joueurs
```
("répété" → "rpt", "à" silently vanishes leaving a double space, the curly apostrophe in "d'autres"
— a real French keyboard/autocorrect produces U+2019, not `'` — also vanishes since it isn't in the
allow-list either, unlike straight `'` which is.)

**WHY THIS IS THE INTERESTING CASE, not a duplicate of the admin-username ASCII rule Toby already
ruled out:** that field is a login credential, correctly ASCII-only by design, and I'm not
re-filing it. This is different: it's a genuine **free-text, display-facing field** (exactly what
Toby's own coverage notes flagged as still open), it's **accepted with no warning**, and the panel's
own audit log then disagrees with what the game server actually received — the operator has no way
to know, from anything the panel tells them, that the ban reason in-game doesn't match what they
typed and what the panel claims it logged. This is priority #2 from the brief almost exactly:
accepted input that behaves differently than the operator expects, silently.

**Notable inconsistency within the same file:** `serverMessage()` (used for broadcasts/chat) already
solves this correctly two ways `sanitizeForBanReason()` doesn't: it normalizes curly quotes/dashes/
ellipsis to ASCII equivalents *before* dropping non-ASCII, and it's the sanitizer this codebase
clearly considers the right pattern for user-typed broadcast text. `sanitizeForBanReason()` predates
that pattern or was never brought in line with it.

**WHAT SHOULD HAPPEN:** either reuse `serverMessage()`'s ASCII-folding approach (normalize curly
quotes/dashes, transliterate or at minimum warn about dropped accents) in `sanitizeForBanReason()`
too, or — if PZ's ban-reason field genuinely can't carry non-ASCII any better than `servermsg`
can — do the same thing `serverMessage()` does when the result is empty: tell the caller, so
`players.js` can surface *that specific* fact rather than silently succeeding with a different
string than what was typed and than what the activity log now claims happened.

**Severity: Medium.** Doesn't destroy or expose anything, but it's a trust bug in exactly the two
places (moderation record-keeping, the ban itself) where an operator most needs the panel's own
account of what happened to be literally true.

---

> **RECONCILED 2026-08-24 (fork):** FIXED at `4a7dc86` (same commit as Finding 1). `performRestart()`
> now takes an optional `label` option (defaulting to `"Auto Restart"`, unchanged behavior for the
> cron job and other internal callers), threaded into every `logScheduleExecution()` call inside it
> (`scheduler.js:663-672`). `POST /restart-now` now explicitly passes
> `scheduler.performRestart(parsedWarningMinutes, { label: 'Manual restart' })`
> (`routes/scheduler.js:410`) — confirmed directly, not inferred from the commit message. The
> "immediate unconditional success response" half of this finding (the UI can't distinguish
> "genuinely under way" from "about to fail") is unchanged — this fix addresses the mislabeling half
> specifically, which is what the finding's own "WHAT SHOULD HAPPEN" asked for.

## FINDING 3 (Low): manually-triggered `Restart Now` always reports success immediately, and any later failure is recorded in Schedule History mislabeled "Auto Restart" — WHERE: `server/services/scheduler.js:636-651` (`performRestart`) called from `server/routes/scheduler.js:325-354` (`POST /restart-now`)

**WHAT HAPPENS:** `POST /restart-now` fires `scheduler.performRestart(parsedWarningMinutes)` in the
background (`.catch(err => log.error(...))`, not awaited) and responds
`{ success: true, message: 'Restart initiated' }` unconditionally, before the countdown or even the
RCON connectivity check has run. If the restart later fails for a real, surfaced-elsewhere reason
(RCON unreachable, server wasn't actually running, etc.), `performRestart()` does record it — but
every single `logScheduleExecution()` call inside `performRestart()`, regardless of caller, is
hardcoded to the task name `"Auto Restart"`:
```js
await logScheduleExecution(null, "Auto Restart", "restart", false, errorMsg, restartDuration);
```
So a restart an operator explicitly clicked "Restart Now" for shows up in Schedule History
attributed to automatic scheduling, not to them.

**WHY IT'S REAL BUT LOW:** the failure isn't hidden — it's genuinely recorded in Schedule History,
and Toby already confirmed the panel doesn't fabricate false "boot" cases from mocked data (a
different concern, ruled out in his own earlier find). This is a narrower issue: the *immediate*
UI response can never distinguish "restart genuinely under way" from "restart about to fail," and
the after-the-fact record, if the operator does check it, misattributes a manual action to the
auto-restart system, which could send someone debugging "why did my server auto-restart" down the
wrong path.

**WHAT SHOULD HAPPEN:** thread a caller label ("Manual restart" vs "Auto Restart") into
`performRestart()`'s logging calls instead of hardcoding one string for both callers. Lower priority
than Findings 1–2; noting it because it's a real, reproducible "the panel's own record of what
happened is wrong" case, which is squarely priority #3 from the brief even though nothing about it
is a security boundary.

---

## Chased and ruled out (recording so nobody re-spends time on these)

- **Negative countdown values (Toby's own example):** every warning-minutes input path I could find
  (`scheduler.js` `/restart-now`, `server.js` `/restart`, `mods.js`'s mod-triggered restart) clamps
  or range-checks explicitly — negative values fall back to a sane default (5) rather than
  producing an immediate/broken countdown, and all three independently cap at a sane upper bound
  (60 or 1440 depending on the field). `warningMinutes === 0` is treated as "restart with no
  countdown," which is a deliberate, documented choice (`if (warningMinutes > 0)`), not a bug — 0 is
  a legitimate "skip the warning" value, not a malformed negative one slipping through.
- **Broadcast/chat message length:** `POST /server/message` caps at 1000 chars server-side with a
  named error code (`SERVER_MESSAGE_TOO_LONG`); `panelBridge.js`'s three chat routes
  (`/chat/admin`, `/chat/general`, `/chat/alert`) independently cap at 2000 with a plain but
  accurate 400. Neither silently truncates — both refuse outright with a length figure that matches
  the actual limit enforced.
- **RCON command/quote injection via the *validated* helpers:** `sanitize()` and
  `sanitizeQuotedArg()` (both `rcon.js`) strip or reject `"`, `\`, and all control characters
  (`\x00-\x1F`, `\x7F`) including `\r`/`\n`, and every player-moderation/GM-tool RCON call I traced
  in `players.js` routes through one of these two. No route lets a quote or newline reach a
  `servmsg`/`kickuser`/`banuser`/`teleport`/`additem`/etc. command string unescaped. (Finding 2
  above is a *content-fidelity* bug in one of these helpers, not an injection gap in it.)
- **PanelBridge chat transport (JSON, not string concatenation):** `sendCommand()` writes the whole
  `{ id, action, args }` record through `JSON.stringify()` to the bridge's commands file — args
  (including chat `message`/`author`) are never string-concatenated into anything the Lua mod has
  to parse token-by-token, so quotes/backslashes/newlines in a chat message can't break the
  command's own structure at this layer. (What the Lua mod itself does with the decoded string is
  outside this checkout, same boundary god already drew for the `/server-info` finding handed to
  Jim — not re-litigating that scope question here.)
- **French/non-ASCII display-text fields on Players/Chat:** `players.js`'s `SAFE_TEXT_REGEX`
  (`À-ɏ` included) correctly accepts accented kick/ban reasons and player notes at the
  *route validation* layer — the mismatch is downstream in one specific RCON-layer sanitizer
  (Finding 2), not a blanket "French text rejected" bug. Chat's `author` field (`/chat/general`) is
  trimmed/length-capped with no charset restriction at all, and reaches RCON only through
  `serverMessage()`'s already-correct ASCII-folding path — no issue found there.
- **`kickPlayer`'s unused `reason` parameter:** `kickuser` has no reason flag in PZ's RCON syntax
  (correctly commented in `rcon.js`); the reason the operator types is stored in the panel's own
  `logPlayerAction` record only, never claimed to reach the player or the server. Not a false
  claim — the code doesn't pretend otherwise — but flagging in case the Players.tsx UI copy implies
  the kicked player sees it, which would be a client-side (Angela's territory) wording question,
  not something I can confirm from server/ alone.
- **Scheduled-task numeric fields (`add-item` count, `add-xp` amount):** both range-checked
  server-side (1–100, 0–100000) with a rejecting 400, not silent clamping past validation — no
  wraparound or silent-misbehavior case found.

## Not reached

- **Destructive-action confirmation copy** (server wipe, backup prune, chunk deletion) — Jim already
  owns this against his own throwaway server per god's boundary; deliberately did not touch it or
  bind ports that might collide with his instance.
- **Scheduler cron-expression edge cases beyond the 5-minute-frequency guard** — did not fuzz
  malformed-but-`cron.validate()`-passing expressions (e.g. day-of-month/weekday combinations that
  never actually fire), nor DST-transition behavior for the auto-restart job.
- **Players.tsx / Chat.tsx / Scheduler.tsx client-side rendering** of any of the above (e.g. whether
  a mangled ban reason or an emoji-heavy broadcast renders oddly in the UI itself) — server-side
  input/output tracing only, no browser session run this pass.
- **PanelBridge Lua-mod-side parsing** of chat/GM-tool JSON args — out of scope from `server/`
  alone, same boundary god already drew explicitly for the `/server-info` finding.
- **Whitelist SteamID routes, player notes, and player exports** — read through quickly for the
  obvious injection/length gaps (none found) but did not adversarially fuzz them to the same depth
  as ban/kick/scheduler.
