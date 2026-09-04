# Creed — adversarial findings log

> **RECONCILIATION SUMMARY (2026-09-02, kevin, reconcile-qa-findings-2026-09-02):** All 14 findings
> in this file verified against current source at HEAD `5f913567`. **14 FIXED, 0 LIVE, 0 INVALID.**
> Findings 1-4 and 6-9 already carried "RECONCILED 2026-08-24" notes from an earlier pass — spot-checked
> those against current code (not just trusted) and confirmed the cited constructs are still present
> and the cited commits are still ancestors of HEAD. Findings 5-14 had never been reconciled before
> this pass; all ten were checked fresh against current code and found already fixed by commits
> unrelated to any QA-doc reconciliation effort (backup cron validation, template `iniExclusions`
> union fix, template-apply fail-closed branch, scheduler 6-field cron rejection, and the five
> discovery/serverFinder items). Per-finding evidence inline below.

Read-only bug hunt. Areas assigned: server/routes/{scheduler,discord,backup,serverFiles,servers,discovery,templates,serverFinder,panelBridge,rcon}.js
and their matching server/services/*.js, plus a cross-cutting audit of server/services/permissions.js's capability catalogue.
Findings appended as found, each verified before being listed unless marked UNVERIFIED. Coverage notes at the bottom.

---

> **RECONCILED 2026-08-24 (jim):** FIXED at `0cacaa8` ("fix: three dead isAbsolute(resolve(x))
> checks now check the raw input"). `servers.js:251-256` and `:367-372` now check
> `path.isAbsolute(scanPath)` / `path.isAbsolute(dataPath)` on the RAW input, with an explicit
> comment ("Must check isAbsolute() on the raw input: path.resolve() always...") before resolving.
> Verified directly by reading current source.

**status: FIXED** — re-verified 2026-09-02 at HEAD `5f913567` (commit `0cacaa8` still an ancestor of HEAD, fix construct read directly, not inferred from the commit existing).

## Finding 1 — dead "must be absolute path" check in servers.js /auto-scan and /detect

**WHERE:** `server/routes/servers.js:251-256` (`/auto-scan`) and `server/routes/servers.js:367-370` (`/detect`)

**WHAT HAPPENS:** Both routes do:
```js
const resolvedPath = path.resolve(scanPath);
if (!path.isAbsolute(resolvedPath)) {
  return res.status(400).json({ error: "Must be an absolute path" });
}
```
`path.resolve()` **always** returns an absolute path (it resolves against `process.cwd()` when given a relative input). So `path.isAbsolute(resolvedPath)` is structurally always `true` — the `!...` branch is unreachable dead code. This is the exact "check that cannot fail" shape (`isAbsolute(resolve(x))`) called out as pattern #2 tonight, and it recurs a third time at panelBridge.js:2670 (Finding 2 below).

**WHAT SHOULD HAPPEN:** Either the check should run on the *raw* input (`path.isAbsolute(scanPath)`) before resolving — the way `server/routes/panelBridge.js:228` and `:804` already do it correctly (confirmed by their own comments: "Must check isAbsolute() on the RAW input, not on... path.resolve() always returns...") — or the "must be absolute" requirement should be dropped if a relative path is actually fine to silently resolve against CWD.

**HOW I KNOW:** Read both call sites end to end; confirmed `path.resolve` semantics (Node docs: always returns absolute). Traced a concrete input: POST `/api/servers/auto-scan` with `scanPath: "some/relative/dir"` — `path.resolve("some/relative/dir")` resolves to `<cwd>/some/relative/dir`, which is absolute, so the guard passes and the scan proceeds against a path the caller never intended (server process CWD + their relative fragment) instead of being rejected with the "Must be an absolute path" error the code claims it enforces. Not executed against the live server (read-only hunt), but the logic is deterministic stdlib behavior, not environment-dependent.

**SEVERITY: Low.** This is a validation-message-is-a-lie bug (pattern #1 flavor: an error condition that can never fire), not a privilege escalation — both routes are already gated by `servers.discover` (admin/technician-tier, and the routes intentionally scan arbitrary absolute filesystem paths by design per the comment at servers.js:236 "reads arbitrary local server .ini files and returns their RCON passwords in plaintext... admin-only, same sensitivity tier as chunks delete"). There is no confinement boundary being bypassed — an admin who can already point this at any absolute path can now also point it at a CWD-relative one, which is no more powerful. Fix is one line per site; worth doing for correctness, not urgent for security.

---

> **RECONCILED 2026-08-24 (jim):** FIXED at `0cacaa8` (same commit as Finding 1 — three sites fixed
> together). Was Cosmetic even before the fix (the real containment lived in the downstream suffix +
> realpath check), now also correct at the surface.

**status: FIXED (was cosmetic even before the fix)** — re-verified 2026-09-02 at HEAD `5f913567`.

## Finding 2 — same dead check in panelBridge.js /install-mod, but harmless due to a real check downstream

**WHERE:** `server/routes/panelBridge.js:2662-2672` (`POST /install-mod`)

**WHAT HAPPENS:** Same shape as Finding 1:
```js
const resolvedTarget = path.resolve(targetPath);
if (!path.isAbsolute(resolvedTarget)) {
  return res.status(400).json({ error: "Must be an absolute path" });
}
```
Dead code for the same reason.

**WHAT SHOULD HAPPEN:** Same fix as Finding 1 — check `path.isAbsolute(targetPath)` before resolving.

**HOW I KNOW:** Read the full route body (lines 2650-2730+). Unlike Finding 1, this route has a *second*, real containment check further down: after `fs.realpathSync()`-resolving the target (defeating symlink chains), it requires `realTarget.toLowerCase()` to end with `/media/lua/server` or `/media/lua/server/` (lines 2696-2707) before any write happens. That second check is not structurally always-true — it genuinely rejects most paths.

**SEVERITY: Cosmetic.** The dead `isAbsolute` check is real dead code (same bug class), but the actual traversal protection lives in the suffix check + realpath resolution just below it, which does work. No exploitable gap found here — noting it for completeness/consistency since it's the same bug pattern as Finding 1 and the fix is identical and trivial.

---

## Cross-cutting audit — permissions.js capability catalogue vs. route enforcement

**WHAT I CHECKED:** Every one of the 27 capability keys in `server/services/permissions.js`'s `CAPABILITIES` array, grepped against `server/routes/*.js` for an actual `requirePermission("<key>")` (or `'<key>'`) call site.

**RESULT: Clean.** All 27 capabilities are referenced by at least one route file. (My first pass grep, double-quote-only, showed `rcon.execute` and `automation.manage` at 0 route files — re-checked by hand: false alarm from my own grep, both files use single-quoted strings. `rcon.js` gates `/execute`, `/connect`, `/test`, `/disconnect` with `requirePermission('rcon.execute')`; `scheduler.js` gates its entire router with `router.use(requirePermission('automation.manage'))` at line 26.) No orphaned capability found — i.e., no "a permission you can grant, that saves, that displays as granted, and does nothing" at the route-gating level for these two files. This does not rule out a capability being checked on the wrong subset of routes within a gated file (that's a per-route question, being covered by the assigned sub-hunts of scheduler.js/discord.js/backup.js/etc. separately), only that the capability isn't *entirely* unenforced.

---

## Coverage so far

Directly read/verified myself: `server/services/permissions.js` (full), `server/routes/servers.js` (auto-scan/detect sections), `server/routes/panelBridge.js` (install-mod section + the two correct isAbsolute(raw-input) sites at :228/:804), `server/routes/scheduler.js` (full), `server/routes/rcon.js` (full), `server/routes/server.js` (isValidPath), `server/routes/config.js` (isValidConfigPath), `server/routes/mods.js` (path-traversal check section), `server/routes/chunks.js` (path-traversal check section) — the latter four to confirm they do NOT share the isAbsolute(resolve()) bug (they check `isAbsolute(normalize())`, which is a legitimate, reachable-false check).

Delegated for deep verification (in progress, will append their results): backup.js/backupService.js/backupRecords.js; scheduler.js+discord.js/discordBot.js internals (partial-failure reporting, unbounded growth, secrets); serverFiles.js/remoteConfigFiles.js/servers.js/serverManager.js (path traversal, command injection); discovery.js/mountDiscovery.js/serverFinder.js/templates.js/templateService.js; panelBridge.js (service files)/panelBridgeInstaller.js/panelBridgeSftp.js/rcon.js (service) (credential handling, connection leaks).

Not yet examined: server/services/scheduler.js, server/services/discordBot.js, server/services/backupService.js internals, server/services/remoteConfigFiles.js, server/services/serverManager.js, server/services/mountDiscovery.js, server/services/templateService.js, server/services/panelBridge.js, server/services/panelBridgeInstaller.js, server/services/panelBridgeSftp.js, server/services/rcon.js — these are covered by the delegated sub-hunts above; results pending.

---

## [MERGE NOTE] Two workers appear to be writing this same file concurrently

This file was overwritten (full `Write`, not append) between my read and my next edit, replacing an
earlier version of this doc that already contained two verified backup.js findings. Re-appending
those below rather than re-overwriting the file, to avoid losing either side's work. Flagged to god —
this looks like two "Creed"-named workers independently assigned the identical brief/scope and both
delegating to sub-agents against the same file path, which both duplicates work and risks silently
dropping findings on every overwrite. Recommend whichever of us god did NOT intend to keep stands down,
or we're given non-overlapping file lists.

---

> **RECONCILED 2026-08-24 (jim):** FIXED at `bd1d331`. `backupService.js:611` now reads
> `const prunable = backups.filter((b) => !b.name.startsWith("uploaded-"))`, with a comment
> exempting uploads from the automatic prune "full stop -- never counted toward maxBackups and never
> selected for deletion" because it's unattended, while `deleteBackupsOlderThan` deliberately does
> the opposite since it's operator-initiated ("delete everything older than X days" means what it
> says). Verified directly, not just from a claim — I initially escalated this as still-live before
> checking, corrected within minutes. See the RESUMED section below for the full correction record.

**status: FIXED** — re-verified 2026-09-02 at HEAD `5f913567`. `backupService.js`'s `cleanupOldBackups()` still excludes `uploaded-*` explicitly; `deleteBackupsOlderThan()` still deliberately does not (documented, correct asymmetry).

## Finding 3 — cleanupOldBackups()/deleteBackupsOlderThan() delete uploaded backups despite a comment saying they won't

**WHERE:** `server/services/backupService.js:557-581` (`cleanupOldBackups`), also
`server/services/backupService.js:586-632` (`deleteBackupsOlderThan`), both driven by
`listBackups()` at `server/services/backupService.js:450-485`.

**WHAT HAPPENS:** `server/routes/backup.js:257-262` documents the upload feature's `uploaded-`
filename prefix with: *"external archives are visually separated from the panel's own scheduled
backups, and **never collide with them when the auto-prune logic looks for the oldest
panel-created backup to drop**."* That's not what the code does. `listBackups()` returns every
`*.zip` in the backups folder with no prefix filtering, sorted newest-first. `cleanupOldBackups()`
keeps the newest `maxBackups` (default 10, configurable 1-100) and deletes everything past that
cutoff — **including `uploaded-*.zip` files** — purely by recency, with no awareness of the
`uploaded-` prefix. `deleteBackupsOlderThan()` has the identical gap (age cutoff over the
unfiltered list).

**HOW I KNOW:** Read both functions end to end — neither contains any `startsWith("uploaded-")`
or equivalent check; `listBackups()` (the single source both draw from) filters only on
`f.endsWith(".zip")`. Concrete scenario: operator uploads a backup they specifically want kept
(e.g. before a risky mod install), `maxBackups` is at its default of 10, and the panel's own
6-hourly scheduled backups (`0 */6 * * *` default) produce 10 newer backups within 60 hours (2.5
days) — the very next scheduled backup after that pushes the uploaded one past the cutoff and
`cleanupOldBackups()` silently deletes it with only a `log.info` line, no user-facing warning.
Same outcome from `deleteBackupsOlderThan` if the uploaded backup is simply old enough.

**WHAT SHOULD HAPPEN:** Either the prune functions should exclude `uploaded-*` files (matching
what the comment already claims), or the comment should be corrected so operators don't rely on a
guarantee the code doesn't provide. The comment frames this as a deliberate design decision — this
reads as the accident-described-as-a-decision pattern: intent was written down, but the pruning
code doesn't implement it (or was written first and the comment added later without checking it).

**SEVERITY: High.** "Deleting a backup destroys the operator's safety net" — except here it's not
the operator doing the deleting, it's auto-prune silently doing it to the backup the operator
manually preserved, while a written comment tells them it can't happen.

---

> **RECONCILED 2026-08-24 (jim):** FIXED at `4d29744` ("fix(security): GET
> /api/backup/download/:name now requires its own capability"). `backup.js:171` now reads
> `requirePermission("backups.download")`, its own dedicated capability rather than reusing
> `backups.manage` — the better fix, since a capability should only be reused when its grant set
> actually matches. A comment above the route documents the exposure path.

**status: FIXED** — re-verified 2026-09-02 at HEAD `5f913567`.

## Finding 4 — GET /api/backup/download/:name has no backups.manage permission gate

**WHERE:** `server/routes/backup.js:159-185`.

**WHAT HAPPENS:** Every other mutating or content-revealing backup route requires
`requirePermission("backups.manage")` or `("backups.restore")`: `/:name/snapshot` (line 63),
`POST /settings` (76), `POST /create` (110), `DELETE /:name` (141), `POST /restore/:name` (192,
`backups.restore`), `POST /delete-older-than` (237), `POST /upload` (264). `GET /download/:name`
(159) has no `requirePermission(...)` at all — only the blanket `authService.middleware()` applied
to all of `/api/` in `server/index.js:639`, i.e. any authenticated user of any role can hit it.
Permissions here are capability-based per role (`server/services/permissions.js`), so a role can
legitimately be created that omits `backups.manage` — that role's users can still download the
full world-save archive, and if the operator ever created a backup with `includeDb` on, the
archive contains `db.json` (bcrypt password hashes and other settings — `server/database/init.js:
291-294` confirms JWT secret/RCON password/Discord+Steam credentials were moved to sibling files
specifically to keep them out of backups, but db.json itself "still holds bcrypt password hashes
and other settings that don't warrant world-readability").

**HOW I KNOW:** Read `server/routes/backup.js` top to bottom, diffed which routes carry
`requirePermission`; confirmed the mount point and global auth middleware in
`server/index.js:629-639`. Sharpest asymmetry: `/:name/snapshot` gates a much smaller disclosure
(just the JSON server-config snapshot) behind `backups.manage`, while `/download/:name` gates
nothing and hands out the entire archive.

**WHAT SHOULD HAPPEN:** `router.get("/download/:name", ...)` should require
`requirePermission("backups.manage")` like its siblings; nothing in the file suggests the gap is
intentional.

**SEVERITY: Medium-High.** Still requires a valid login, but it's a real break in the app's own
capability model: a role explicitly denied `backups.manage` can still exfiltrate full backup
contents, including bcrypt hashes when `includeDb` was ever used.

---

## Areas I checked clean (backup.js area)

- `server/services/backupRecords.js` — bounded (`MAX_RECORDS = 500`, sliced on every save), no
  unbounded-growth issue. Serialized mutation queue (`mutationChain`) looks race-safe for
  concurrent add/remove.
- `server/services/backupService.js` restore path (zip-slip protection, staging-then-rename swap,
  pre-restore backup, mutex via `restoreInProgress`/`backupInProgress`, rollback-on-swap-failure) —
  already heavily hardened per its own inline comments referencing a prior "backend audit" (B28).
  Traced the zip-slip check (`resolvedEntry.startsWith(resolvedParent)` with a trailing
  `path.sep` on the base) and it holds against both `../` traversal and embedded-drive-letter
  tricks on Windows path.join semantics. Did not find a bug in this path.

---

# RESUMED — jim, 2026-08-24, `hunt-code-patterns`

God resumed the hunt with a sharper five-pattern brief (the sibling gap, the second door, silent
substitution, description stronger than mechanism, a check that cannot see the thing) and fresh
territory: the routes/services above with no owner tonight, backup/restore first. Verified every
finding below against the CURRENT tree myself before listing it — including two I initially
mis-escalated from this very file (Findings 3 and 4 above) before checking live source first. Both
are **already fixed** — see the correction note right below. Everything after that is new.

## Findings 3 and 4 above: fixed, not live

Read the current source before starting fresh work, per the discipline the floor's been rebuilding
all night. Both are resolved:
- Finding 3 (uploaded-backup auto-prune collision): `backupService.js:593-611`, `cleanupOldBackups()`
  now excludes `uploaded-*` explicitly (`prunable = backups.filter(b => !b.name.startsWith("uploaded-"))`),
  with a comment explaining the exemption is deliberate and permanent. `deleteBackupsOlderThan()`
  deliberately does NOT exempt uploads — also fully commented, coherent design (operator-initiated
  bulk delete means what it says; unattended scheduled prune must never surprise).
- Finding 4 (`GET /download/:name` ungated): `backup.js:171` now gates on a dedicated
  `requirePermission("backups.download")` capability, distinct from `backups.manage`.

**status: FIXED** (verified fresh 2026-09-02, HEAD `5f913567` — no prior reconciliation note existed for this finding). `server/routes/backup.js`'s `POST /settings` now rejects `req.body.schedule` with a 400 unless it passes both `isSupportedFiveFieldCron()` and `!isCronTooFrequent()` (lines ~131-142) before ever assigning `allowed.schedule` — the "accepted with zero validation" gap this finding described no longer exists.

## Finding 5 — POST /api/backup/settings accepts an invalid cron schedule with zero validation; failure is silent

**WHERE:** `server/routes/backup.js:77-108` (`POST /settings`), `server/services/backupService.js:168-183`
(`updateSettings`), `server/services/scheduler.js:466-491` (`setupBackupSchedule`).

**PATTERN:** #5 (a check that cannot see the thing) and #3 (silent substitution) together.

**WHAT HAPPENS:** `POST /settings` does `allowed.schedule = String(req.body.schedule)` with no
cron validation at all, and `updateSettings()` persists it unconditionally
(`await setSetting("backupSchedule", settings.schedule)`). The route responds
`{ success: true, settings }` regardless of whether the string is a valid cron expression. The
*only* validation anywhere in this chain is inside `scheduler.setupBackupSchedule()` — called right
after, but from a different service — which does `if (!cron.validate(settings.schedule)) { log.error(...); return; }`
and silently returns without ever creating `this.backupJob`. The `POST /settings` response the
caller actually sees carries no trace of this failure; only a server-log line does.

**CONCRETE SCENARIO:** an API-direct caller (script, future UI change, malformed value) submits
`schedule: "not a cron"` (or any invalid string). Response: `200 {success:true, settings:{schedule:"not a cron", enabled:true, ...}}`
— everything reads as configured and enabled. No backup job is actually scheduled. Nothing fires,
silently, until either someone reads the server log or the operator notices the backup list stopped
growing — by which point `enabled: true` has been actively lying about the safety net's existence for
however long that takes to notice.

**TEMPERING FACTOR, checked before reporting:** the shipped UI (`client/src/pages/Backups.tsx:712-729`)
only offers a fixed `<Select>` dropdown of 12 known-valid cron presets — no free-text schedule input
exists today, so this isn't reachable through normal UI use. It's a real server-side contract gap
(the API should never trust "the current UI happens to only send good values"), not a
currently-exploitable-by-a-normal-operator bug. Same asymmetry exists for `maxBackups`: invalid input
is silently clamped/defaulted (`isNaN(parsed) ? 5 : Math.min(Math.max(parsed, 1), 100)`) rather than
refused — inconsistent with this same file's `/delete-older-than`, which correctly rejects a bad
`days` value with a 400 (`typeof days !== "number" || days < 1`). The UI also happens to
client-side-validate `maxBackups` before it's ever sent, for the same reason.

**WHAT SHOULD HAPPEN:** `POST /settings` should call `cron.validate()` itself (or import
`isCronTooFrequent`-style validation from scheduler.js) and reject an invalid `schedule` with a 400,
the same way `/delete-older-than` already rejects a bad `days`. `maxBackups` should likewise reject
non-numeric/out-of-range input rather than silently substituting a default.

**SEVERITY: Medium.** Not currently reachable through the shipped UI, but a real API-contract gap
in backup/restore-adjacent territory (an incorrectly-"enabled" backup schedule is exactly the kind of
silent wrong answer that costs the most, per this dispatch's own framing) — worth closing before any
future UI change adds a custom-schedule input.

---

**status: FIXED** (verified fresh 2026-09-02, HEAD `5f913567` — no prior reconciliation note existed for this finding). `backupService.js`'s `restoreBackup()` (~line 1139 onward) no longer calls `checkServerRunning()`; it now calls `getServerProcessDetails()` and explicitly refuses (`success:false`) when `!processDetails || processDetails.scanFailed`, matching the route's own fail-closed check. Comment cites "bug-hunt-2026-08-27, backup-restore hunt" as the fixing pass — the landmine this finding warned about (a future direct caller inheriting a fail-open guard) is closed.

## Finding 6 — backupService.js's own internal restore guard still uses the pre-fix fail-open pattern; currently masked, a landmine for any future caller

**WHERE:** `server/services/backupService.js:741-770` (`restoreBackup`), contrasted with
`server/routes/backup.js:226-241` (the route calling it).

**PATTERN:** #1 (the sibling gap) — this exact fail-open-on-scanFailed bug was found and fixed
across chunks.js's delete-chunks/delete-region, configMutationGuard.js, and this very file's OWN
route layer tonight. The fix never reached this file's *service*-layer sibling doing the identical
check for the identical operation.

**WHAT HAPPENS:** `backup.js`'s route (lines 226-241) correctly calls `serverManager.getServerProcessDetails()`
and fails closed (503 `SERVER_STATE_UNKNOWN`) when `processDetails.scanFailed` — exactly the fix
applied everywhere else. But `backupService.js`'s `restoreBackup()` has its OWN, separate,
independent check three lines later in the call chain:
```js
if (this.serverManager && options.force !== true) {
  const running = await this.serverManager.checkServerRunning();
  if (running) { return { success: false, message: "Server is still running..." }; }
}
```
`checkServerRunning()` is the exact function this whole bug class exists to avoid — it collapses a
FAILED detection scan into a plain `false`, indistinguishable from confirmed-stopped, per its own
usage elsewhere in this codebase before being replaced. If the scan fails here, `running` is `false`,
the `if` doesn't fire, and the restore proceeds — silently overwriting a save file a server that
might still be running holds open.

**WHY IT'S NOT LIVE TODAY:** the only caller of `restoreBackup()` is the route (confirmed by
grepping every `.restoreBackup(` call site in `server/routes/*.js` and `server/services/*.js` —
exactly one, `backup.js:253`), and the route's own check runs first, unconditionally, with no way
for a request to skip it. So today, this internal check is dead weight — always reached only after
the route already verified the server is genuinely stopped.

**THE LANDMINE:** `options.force !== true` — and the route passes `{ ...req.body, io }` straight
into `restoreBackup()`, meaning `req.body.force` flows through unfiltered. If the client sends
`force: true`, this WHOLE internal block is skipped outright (on top of already being fail-open on
scan failure). Currently harmless only because the route's own check can't be bypassed the same way.
The moment ANY other caller reaches `restoreBackup()` directly — a future internal API, a script, a
different route reusing the service — it inherits a fail-open guard with no defense-in-depth, in the
one function in this app that rolls back live world data.

**WHAT SHOULD HAPPEN:** replace `checkServerRunning()` with `getServerProcessDetails()` +
`scanFailed` handling here too, matching the route (and every other sibling fixed tonight) — belt
and suspenders is the right posture for the one operation that overwrites live player data
irreversibly, not "the caller already checked."

**SEVERITY: Medium** as currently shipped (masked by the route), but this is exactly the shape of
defect that survives by luck-of-call-order rather than by design, in the highest-consequence
function in the file. Worth fixing on the same pass as Finding 5, not urgent enough to block
anything tonight.

---

**status: FIXED** (verified fresh 2026-09-02, HEAD `5f913567` — no prior reconciliation note existed for this finding). `server/utils/templateSchema.js` now exports `resolveIniExclusions(template)`, which unions `DEFAULT_INI_EXCLUSIONS` with any template-supplied `iniExclusions` (a template may only ADD to the excluded set, never remove from it). Both `validateTemplate()` and `templateService.js`'s `prepareIniChange()` (the actual apply-time write path) call this shared function instead of reading `template.iniExclusions` directly — confirmed by reading both call sites, not by trusting a comment. Code comments in both files explicitly cite "2026-08-24 conv-template-privesc" as the incident this closed. The `"iniExclusions": []` bypass this finding demonstrated no longer works at either the validate or apply site.

## Finding 7 (SECURITY, already flagged separately and immediately) — template `iniExclusions` self-referential bypass lets `templates.manage` rewrite RCON password/ports/ServerName

**WHERE:** `server/utils/templateSchema.js:22-34,124-126`, `server/services/templateService.js:92-104,124-133,191-192`.

**PATTERN:** #4 (description stronger than mechanism) + #2 (the second door).

Full detail already sent to god directly (2026-08-24T00:55Z) given the severity; summarizing for the
record. `DEFAULT_INI_EXCLUSIONS`'s own comment claims "Enforced by validateTemplate regardless of
what a caller passes" — false. Both `validateTemplate()` and the apply-time write path
(`prepareIniChange`) read the exclusion list FROM THE TEMPLATE ITSELF when it's supplied as an
array, so a template shipping `"iniExclusions": []` sails through validation and gets its
`RCONPassword`/`ServerName`/port fields written straight into the live server `.ini`. Reachable via
`POST /api/templates/import` or `POST /api/templates` (when the caller supplies `meta.id` +
`schemaVersion`, bypassing `createTemplate`'s safe default), both gated only by
`requirePermission("templates.manage")` — a capability the app's own design intent (per this exact
exclusion list's purpose) scopes to gameplay rulesets, not server identity/networking/secrets.
**SEVERITY: High — real capability-boundary violation, live and exploitable today.**

**status: FIXED (fail-closed, not the full cross-server check)** (verified fresh 2026-09-02, HEAD `5f913567`). `server/routes/templates.js`'s `POST /:id/apply` (~line 114) still only runs the real running-state check `if (String(activeServer?.id) === String(serverId))`, but the `else` branch — previously nothing — now explicitly refuses with 409 `SIM_TEMPLATE_APPLY_INACTIVE_SERVER_UNVERIFIABLE` rather than silently skipping the guard. Comment cites "2026-08-24 conv-template-privesc" and explains the design choice: real cross-server process detection wasn't built, but "can't check" now fails the same way it does everywhere else in this codebase instead of applying unchecked. Closes the exploitable gap this finding described; the underlying feature limitation (no way to check a non-active server's process state) is unchanged but is no longer a silent bypass.

## Finding 8 (already flagged separately and immediately) — template apply's stopped-server guard only checks the *active* server, not the target

**WHERE:** `server/routes/templates.js:89-128`.

**PATTERN:** #1 (the sibling gap).

The fail-closed stopped-server check (correctly modeled on the same `scanFailed`-aware pattern used
everywhere else tonight) only runs `if (String(activeServer?.id) === String(serverId))`. Template
apply is explicitly parameterized by `serverId`, a real supported multi-server feature — applying a
template to any locally-configured server OTHER than the currently-active one skips the guard
entirely, regardless of whether that server is actually running. `serverManager` is bound to a
single server by name, so there's no existing mechanism to check a non-active server's state even if
the `if` were removed — this needs a small design change, not a one-line fix.
**SEVERITY: High — the same "wholesale config overwrite against a live process's open files" class
backup/restore correctness is prioritized for.**

**status: FIXED** (verified fresh 2026-09-02, HEAD `5f913567` — no prior reconciliation note existed for this finding). `server/routes/scheduler.js` now imports and calls `hasUnsupportedCronFieldCount()` (from `utils/cronValidation.js`) BEFORE `isCronTooFrequent()`, at both `POST /tasks` (create, ~line 285) and `PUT /tasks/:id` (update, ~line 392) — a 6-field seconds-precision expression is now rejected outright with `SCHEDULER_CRON_SECONDS_UNSUPPORTED` rather than falling through the minutes-only frequency check. The exact `"*/5 * * * * *"` bypass this finding demonstrated is closed at both mutation sites.

## Finding 9 (SECURITY, already flagged separately and immediately) — scheduler's DoS frequency guard is bypassed by 6-field (seconds-precision) cron expressions

**WHERE:** `server/routes/scheduler.js:65-105` (`isCronTooFrequent`).

**PATTERN:** #5 (a check that cannot see the thing) + #4 (description stronger than mechanism —
the call site's comment reads "Security: Reject tasks that run more frequently than every 5 minutes
to prevent DoS").

`isCronTooFrequent()` always treats `parts[0]` as minutes. The installed `node-cron@4.6.0` accepts
6-field expressions with a leading seconds field (confirmed empirically: `cron.validate('*/5 * * * * *')`
returns `true`). Traced by hand and confirmed empirically: for `"*/5 * * * * *"`, `parts.length` is 6
(passes the `<5` malformed-input guard), `minute` becomes `"*/5"` — which the every-minute check only
matches for `*/1` through `*/4` — so every branch falls through to the final `return false`. A caller
holding only `automation.manage` can schedule a task with `cronExpression: "*/5 * * * * *"` that
passes both `cron.validate` and this frequency guard, then fires every 5 seconds indefinitely —
exactly the DoS this check exists to prevent, with the check itself silently reporting all clear.
**SEVERITY: High — real, live, empirically confirmed DoS vector against RCON/the game server.**

## Findings 10-14 — from the discovery/templates/serverFinder sub-hunt, non-security, not independently re-verified line-by-line by me (fork's write-up read and judged sound; territory/severity framing consistent with everything else verified in this pass)

**status: ALL FIVE FIXED** (verified fresh 2026-09-02, HEAD `5f913567` — no prior reconciliation note existed for any of these). Per-item evidence below.

- **`queryServerInfo` (serverFinder.js:64-101) collapses three distinct failure modes (timeout,
  socket error, unparseable response) into the same `null`.** Pattern #5. `GET /ping` reports
  "offline" for a response it simply couldn't parse; `GET /query` says "did not respond" when it
  did. Medium — a future A2S protocol bump would silently misreport every server as offline with no
  diagnostic trail. serverFinder.js:577-583, :521-526.
  **FIXED** — `queryServerInfo()` now takes an optional `onFailureReason` callback invoked with `'timeout' | 'socket-error' | 'unparseable-response'`, and a shared `QUERY_FAILURE_MESSAGES` map gives `GET /query`/`GET /ping` distinct wording for each.
- **`GET /` (serverFinder.js:364-485) can report "0 servers found" identically whether nothing is
  listed or every lookup path (Steam API + master-server fallback) errored.** Pattern #5. Medium —
  misleading exactly when an operator most needs a real signal (broken egress/API key).
  **FIXED** — `deriveSteamApiFailureReason({steamApiError, serversFound})` now surfaces the real API error when `serversFound === 0`, alongside `masterDiscovery` stats in the response.
- **`discoverMounts()` (mountDiscovery.js:18-32) can't distinguish "mount not present" from
  "couldn't check it" (permission denied, I/O error) — same shape, no logging on the caught-error
  path.** Pattern #5. Low-Medium, onboarding-only, but a realistic failure mode for exactly the
  Docker bind-mount deployment this feature targets.
  **FIXED** — `classifyDir()` now returns `"missing"` (ENOENT) vs `"inaccessible"` (any other error, e.g. EACCES) distinctly; comment explicitly names this exact finding's misdiagnosis risk as the reason.
- **`GET /discover-mounts` (discovery.js:29-36) is ungated while its sibling `POST /create-from-discovery`
  requires `servers.discover`.** Pattern #1. Low confidence on severity — discloses filesystem
  paths/candidate server names to any authenticated role, not secrets, but worth a deliberate
  decision rather than a silent asymmetry.
  **FIXED** — `GET /discover-mounts` now requires `requirePermission("servers.discover")`, matching its sibling.
- **`readServerIniSettings`'s port fields (mountDiscovery.js:180,182) silently default
  (`parseInt(...) || 27015`) on a malformed value instead of erroring, unlike the sibling
  `rconPassword` field the caller does check-and-refuse.** Pattern #3 + #1. Low-Medium — a corrupted
  source ini could silently populate a new server profile with the wrong RCON port.
  **FIXED** — ports now go through `parsePort(value, default, max?)`, which returns `null` on a malformed value; `readServerIniSettings()` returns `null` for the whole result if either port is `null`, refusing rather than silently defaulting.

## Areas the discovery/templates/serverFinder sub-hunt checked clean

SSRF blocklist (`isPrivateIp`/`validateQueryIp`) thorough and applied uniformly to both `/query` and
`/ping`; `serverFinder.js`'s router-level `requirePermission('server.install')` applies to all 4
routes including `/debug`; `validateTemplate`'s type/shape checks for `serverIni`/`sandboxVars` are
real (the gap is specifically the self-referential `iniExclusions`, not the rest of the schema);
`resolveServerPaths` validates `serverName` against the identity-safe regex before building file
paths (no traversal surface); `applyTemplate` correctly refuses remote servers outright;
`importTemplate` always mints a fresh UUID (can't collide with/overwrite an existing template). All
5 files (discovery.js, templates.js, serverFinder.js, mountDiscovery.js, templateService.js) read
end to end, not sampled.

---

## panelBridge.js / rcon.js (routes + services): no new findings, prior-hunt fixes verified live

This territory turned out to have been very thoroughly hunted already tonight by Kevin
(`docs/qa/kevin-route-hunt.md`, `kevin-adversarial-findings.md`) — checked his prior findings
against current source rather than re-mining the same ground blind:

- **Verified fixed:** Kevin's HIGH finding (`automation.manage` alone letting a scheduled task run
  raw RCON commands without `rcon.execute`) is closed — `scheduler.js` gates all three paths that
  can produce/trigger a raw-command task (create, update, manual-run) via
  `classifyScheduledCommand(command) === 'raw'` + an explicit `rcon.execute` check, and specifically
  re-checks the CALLER's current capability at run-time rather than trusting whoever created the
  task. The dead `isAbsolute(resolve(x))` pattern (this file's own Finding 1/2, panelBridge.js
  `/install-mod`) is fixed at all sites.
- **Fresh ground, read in full, clean:** `panelBridgeInstaller.js` (source is always the panel's own
  bundled file, never user/network-supplied; atomic write + write-then-verify). `panelBridgeSftp.js`
  (credential masking consistent across all three config-resolution sites incl. one inline
  duplicate; path-traversal guards reject `..`/backslash/absolute-root; size caps enforced). `rcon.js`
  service's ~50-method action surface — sibling-consistent argument sanitization throughout
  (`sanitizeQuotedArg`/`Number.isFinite`), one intentional, commented deviation (`addXp`'s
  non-quoted `perk`, a PZ tokenization requirement).
- **Two low-confidence candidates traced and excluded, not filed:** a mid-session RCON error
  classification whose string-match list omits `ENETUNREACH`/`ENOTFOUND` — traced and confirmed
  those are connect-time-only error classes already handled unconditionally elsewhere, not reachable
  on an established session. `reloadLua()`'s use of the lenient `sanitize()` instead of every
  sibling's throwing `sanitizeQuotedArg()` — traced its only caller (`server.js:2627`) and found the
  dangerous input already rejected upstream by a stricter filename regex before `reloadLua()` is
  ever reached. Worth a one-line consistency fix if anyone's already in the file; not independently
  exploitable.

**Coverage note:** `panelBridge.js` route (4241 lines) — did not re-read the ~60 near-identical
world-events/player-command routes Kevin already sampled and confirmed uniform; read budget spent on
the SFTP/credential-adjacent sections instead, which were genuinely unexamined. `panelBridge.js`
*service* (1669 lines) not read in full — Kevin's hunt already covered its two highest-priority
questions (no credential leak in `getStatus()`, `start()` throws rather than silently returning
false).
