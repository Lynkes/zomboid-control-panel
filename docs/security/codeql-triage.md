# CodeQL alert triage — 2026-08-31

First full triage of the repository's CodeQL backlog, and the justification record for a
future bulk dismissal. Covers all 214 alerts open as of 2026-08-31 (commit `59bc9bc5`). A
prior partial pass on 2026-08-29 dismissed 116 alerts directly in the GitHub UI, with
reasoning recorded only in the GitHub dismissal comments (not the repo, which is why it
looked like no triage record existed) — that pass is cross-referenced below wherever an
open alert shares a root cause with a dismissed one, rather than re-deriving a second
verdict in different words. The intent is that a bulk dismissal of the 214 covered here can
cite a section of this doc per alert instead of re-arguing each one in the UI, the way the
2026-08-29 pass had to.

**Discriminator used throughout: who can reach it beats how bad it sounds.** This panel is
an admin/operator tool with a real capability system (`server/services/permissions.js`,
`requirePermission(capability)`, fails closed). Three roles: `admin` (all capabilities),
`technician` (a broad but real subset), `moderator` (narrow). A finding reachable only by a
role that already holds equal-or-greater capability elsewhere is **accepted-risk**, not a
gap — exploiting it grants nothing the role doesn't already have another way to get. Two
threat classes fall outside that single axis and needed a second question each — both real
findings below come from asking it: a **shared-resource TOCTOU** (is the resource itself
attacker-writable independent of any panel capability, e.g. a world-shared temp directory)
and an **algorithmic-complexity DoS** (does exploiting this cost the attacker's own
privilege, or does it cost *everyone's* availability regardless of the attacker's
privilege — a hung single-threaded Node event loop is everyone's outage, not just the
caller's).

## Counts

| | Alerts |
|---|---|
| Total triaged (open, 2026-08-31) | **214** |
| Real | **3** |
| False-positive | **109** |
| Accepted-risk | **102** |
| Fixed | **3** (all 3 real findings) |

Plus, from the prior pass: **116 alerts dismissed 2026-08-29** (all filed as "false
positive" in GitHub's own dismissal reason field; 104 of those cite an in-source
`codeql[...]` suppression comment as the basis, 12 cite individually-verified reasoning).
**330 alerts have been created against this repository in total** (214 + 116); none from
either pass have been closed or dismissed as part of this triage — that stays with the
operator, taken as one batch (see "What was and wasn't done" below).

## Method

- Pulled all 214 open alerts via `gh api 'repos/fpsacha/zomboid-control-panel/code-scanning/alerts?state=open&per_page=100' --paginate`, plus the 116 dismissed alerts and their `dismissed_comment` text the same way with `state=dismissed`.
- Grouped into 15 file/rule clusters (the two largest — `server.js` path-injection at 62 and `servers.js` at 23 — split further by line range so no single reviewer got an unmanageable batch) and triaged each with an independent, read-only pass: read the actual flagged code, trace the value to its source, find the capability gate on the containing route, and rule based on real reachability rather than the alert's rule-name severity.
- Cross-checked the two pre-flagged criticals (`js/command-line-injection` #297, `js/request-forgery` #333) independently against the initial hypothesis, verifying rather than assuming.
- Settled a standing open question about whether CodeQL's in-source suppression comments are actually honored by this repo's CI pipeline, by downloading the raw SARIF for the latest clean analysis and checking it directly (see below) — read-only, no GitHub UI action.

## Top finding: alert #289 is the only one NOT gated behind technician/admin

Every other real, false-positive, or accepted-risk verdict in this triage rests on the
"who can reach it" test *lowering* severity — a finding gated behind `server.install`,
`servers.manage`, `bridge.setup`, etc. is accepted-risk because only a role that already
has broad trust can reach it. **Alert #289 is the one case where that same test *raises*
the severity instead: the reachable set is "any authenticated panel user," not a
privileged role.**

**`server/services/panelUpdateChecker.js`**, `readMostRecentApplyLog()`'s legacy
`os.tmpdir()` fallback (this method backs `GET /api/panel/update-apply-log`, which requires
login but has **no specific capability gate** — every authenticated role, including
`moderator`, can call it). The fallback used `fs.statSync`/`fs.readFileSync`/`fs.openSync`
(all symlink-following) on files matched only by a predictable name pattern
(`zomboid-panel-update-<digits>.log`) inside the shared, world-writable system temp
directory, with no check for whether a matched entry was a symlink.

**Impact:** on a shared host where the panel process doesn't run under systemd's
`PrivateTmp=true` (bare-metal/manual installs, `docker-compose.install.yml` deployments —
`PrivateTmp` only protects the *recommended* systemd-unit deployment, and the code needs its
own defense regardless of deployment shape), a lower-privileged local OS user could plant a
symlink named to match the pattern, pointing at any file the panel process can read. **Any
logged-in panel user's session — not a privileged one — is then the vehicle**: pulling up
to 8KB of that file's content back through this endpoint.

**Fix — the stronger option, not a patch around the symlink:** searched for any current
writer to this location (`grep -rn "zomboid-panel-update-" server/`) and found none. The
only other reference is in `cleanupOldHelperArtifacts()`, whose own doc comment calls this
pattern **"legacy, pre-v1.0.21"** and only *prunes* matching files — it doesn't write them
either. Nothing in the current codebase still produces files here; the write path moved to
`<exeDir>/.panel-helpers/*.cmd` and `logsDir`-based logs long ago. Since there's no live
caller left to justify keeping a read path into a world-shared directory, **the entire
`os.tmpdir()` fallback branch was removed** rather than defended with an `lstatSync` check —
removing the vulnerability class outright, not leaving a predictable-name path in `/tmp`
that a future change could re-expose. The two `logsDir`-based fallbacks
(`supervisor.log`, `panel-update-last.log`, and timestamped `panel-update-*.log` under
`logsDir`) are untouched and still work — `logsDir` is the panel's own private directory,
not a location shared with other OS users, so those don't carry the same exposure.

## The two polynomial-ReDoS findings — a different risk shape from the rest of this triage

**`server/services/remoteConfigFiles.js:33`** (`safeRemoteDir`) and
**`server/services/panelBridgeSftp.js:15`** (`safeRemotePath`) both ran
`value.replace(/\/+$/, "")` — quadratic on a crafted input (many trailing slashes) — on a
value (`configPath` / `bridgePath`) that had no length cap before reaching the regex. Both
are reachable via `bridge.setup`-gated routes (`/sftp/test`, `/sftp/configure`, and the
remote-config-transport setup routes) — alerts #3 and #1.

**These are technician-gated to *trigger*, but the damage crosses every user of the panel —
that's a different risk shape from every accepted-risk verdict elsewhere in this doc, and
shouldn't be filed next to them as if the reasoning were the same.** Everywhere else,
"only a technician/admin can reach it" ends the analysis, because the role already holds
equivalent-or-greater capability, so exploiting the finding gains that role nothing new.
That reasoning doesn't apply to a denial-of-service: Node is single-threaded, so a
technician sending one oversized `configPath`/`bridgePath` (well under Express's 1MB JSON
body limit) hangs the event loop for **every concurrent user of the panel**, including users
with capabilities the attacker doesn't have. The privilege needed to *trigger* the bug says
nothing about who *suffers* from it — a privilege-crossing DoS is real regardless of the
gate in front of it, which is exactly the second question the "who can reach it" framework
needs for this rule class.

**Fix:** reject the value outright (same "must be an absolute POSIX path" error) if its
length exceeds 500 characters, before the regex ever runs. This number isn't invented: `500`
is an established convention already used for the same kind of path-length cap in at least
ten other places in this codebase (`server/routes/panelBridge.js:3242`,
`server/routes/servers.js:353,475,508,988`, `server/routes/debug.js:1721,1724`,
`server/utils/paths.js:177`, and others) — matched verbatim rather than picking an eleventh
number. *Considered going further and extracting a single shared helper, since
`safeRemoteDir`/`safeRemotePath` are near-identical — but found no existing shared
`MAX_PATH_LENGTH` constant to consolidate onto (all ten existing sites independently declare
their own `500`), so unifying them would be a repo-wide refactor unrelated to this fix's
blast radius, not a two-function change. Left as two independent, numerically-consistent
implementations rather than mixing an unrelated refactor into a security patch.*

**Tests added** (`server/tests/codeqlReDoSPathLengthCap.test.js`,
`server/tests/panelUpdateApplyLogSymlinkSkip.test.js`): length-cap rejection/acceptance for
both validators; for #289, that the `logsDir` fallbacks still work, that a *real* file
sitting in the shared temp dir is now ignored entirely (not just its symlink variant), and
a platform-skipped symlink case (matching this repo's existing pattern, e.g.
`linuxBackupSymlinkSkipVisibility.test.js`). Full server suite re-run clean after all three
fixes: 391 files / 3516 tests passed, 18 files / 91 skipped (expected platform skips), 0
failures.

## The suppression-pipeline question, settled

`.github/workflows/codeql.yml` carried a comment recording two attempts to make CodeQL
honor the ~105 in-source `// codeql[js/path-injection]`-style justification comments
already written across the codebase: attempt 1 (a query in `queries:`) was rejected at
database init; attempt 2 (`44d04efa`, moving it to `packs:`) was believed to have fixed it
but the comment claimed, in capitals, that suppression **"never engages in this repo
pipeline, for anyone, ever"** and was **still unverified** — with an explicit instruction to
check a subsequent run's raw SARIF for a non-empty `suppressions[]` on a known-annotated
result. Three clean runs had since happened (`1818924c`, `b6f95a5d`, `59bc9bc5`) with
nobody checking. Checked directly, read-only, via `gh api .../code-scanning/analyses/{id}
-H "Accept: application/sarif+json"` against the `59bc9bc5` analysis:

- **109 of 330 results in the SARIF carry `suppressions: [{"state": "accepted"}]`**,
  confirmed against a known-annotated site (`server/routes/players.js:55`, which carries a
  `// codeql[js/path-injection]` justification). **Attempt 2 worked — the claim in
  `codeql.yml` was stale, not correct, and has been corrected in this commit's sibling
  workflow-comment fix.** CodeQL's own analysis is now correctly recognizing and accepting
  the in-source suppression comments.
- **But 5 of the currently-open 214 alerts also carry an accepted suppression** —
  `server/services/panelBridge.js:897, 902, 925, 967, 974` (alerts #417, #418, #419, #414,
  #415; see the panelBridge.js section below). These have valid, CodeQL-accepted
  suppression comments and are still sitting open.

**Conclusion: suppression being "accepted" by CodeQL's own analysis does not cause GitHub
to auto-dismiss the alert — annotation is documentation, not dismissal.** The two are
independent systems: an accepted in-source suppression makes GitHub's UI *show* the
comment as an annotation on the alert, but changing the alert's `state` to `dismissed`
still requires a separate, explicit action (the 2026-08-29 pass did this by hand/API for
104 alerts; nobody has done it for these 5). So the 2026-08-29 dismissal comments' own claim
("the suppression is now honoured by the pipeline") was half-right: the *recognition* works,
but the implied conclusion — that the backlog would now stay self-clearing — does not hold.
**Every future alert whose location matches an existing suppression comment will still need
the exact same manual/API dismissal the 2026-08-29 pass did, every time a new alert number
is created for it.** This is the single highest-value finding from this triage: it explains
why the backlog wasn't smaller despite ~105 comments already being written, and it will
keep recurring until either (a) every new suppressed-but-undismissed alert gets a dismissal
pass like this one, or (b) the project decides accepted-suppression alerts should be
dismissed programmatically (e.g. a scheduled `gh api` sweep matching accepted-suppression
SARIF entries to open alert numbers) rather than manually. **Practical corollary: writing
more `codeql[...]` comments (e.g. on `embeddedLua.js`'s 3 new sink lines, noted below) is
still worth doing for a human reviewer's benefit, but it will not by itself close an alert
— so it wasn't done as part of this triage, to avoid implying it would.**

## The two pre-flagged criticals

**#297 `js/command-line-injection`, `server/routes/server.js:4167`** — `spawn(steamcmdExe,
["+quit"], firstRunOpts)` inside `runFirstTimeSetup()` (`POST /steamcmd/download`,
`requirePermission("server.install")`). Argv array, no `shell: true` — not classic shell
injection. The real question is whether `installPath` → `steamcmdExe` can be pointed at an
arbitrary binary, and by whom: `installPath` is validated only by `isValidPath()` (absolute
+ no `..`, **no directory allowlist**), so yes — a `server.install` holder can make this
spawn an arbitrary binary at an arbitrary absolute host path. **Verdict: accepted-risk.**
`server.install` is technician/admin-only, and that role already holds `rcon.execute` (full
in-game console) and other capabilities of equal-or-greater blast radius, so this grants no
new privilege. The same 5 command-line-injection alerts share this exact root cause
(`server.js:253, 2098, 2465, 3728, 4167`) and get the same verdict — see the server.js
section.

**#333 `js/request-forgery`, `server/services/rcon.js:134`** (`checkTcpReachable`, a raw
TCP-connect reachability probe) and its sibling **#26 `js/request-forgery`,
`server/utils/sourceRcon.js:140`** (the RCON-auth handshake half of the same call chain) —
both reached from exactly one route, `POST /api/rcon/test`, which is **already
double-gated**: `requirePermission('rcon.execute')` **and** `requirePermission('servers.manage')`.
An inline comment dated 2026-08-27 cites this exact alert pair as the reason the second
gate was added. Both capabilities are technician/admin-only. Connecting to an
operator-named RCON server is the feature's entire point, so this isn't SSRF in the usual
sense — it is a working internal-reachability probe, but a technician already has
equivalent-or-greater probing ability via `servers.manage` (add a remote server with an
arbitrary `rconHost`), `bridge.setup` (browse arbitrary SFTP paths/hosts), and
`servers.discover` (scan arbitrary host filesystem paths). **Verdict: accepted-risk** for
both #333 and #26 — a redundant path to existing power, not a new exposure.

## Findings by cluster

### `server/routes/server.js` — path-injection (62 alerts, split A/B by line)

All 62 collapse into ~10 route/helper groups. Every one sits behind `isValidPath()`
(absolute + no `..`) and/or `isValidServerName()` (alphanumeric/space/`_`/`-` only, blocks
traversal entirely) before the flagged fs sink. Calling routes require `server.install`
(technician+admin). No traversal is mechanically possible in any of the 62 lines; the only
live question per group was whether the resulting "operator-arbitrary-absolute-path"
behavior is a bug or the documented feature (it's the feature — `server.install`'s whole
job is letting the operator point installs anywhere on the host).

- **`getSteamCmdExe`, `hasPzInstallMarker`, `ensureSteamCmdLinux`, `recoverMismatchedSteamBranchManifest`, `recoverBlockedSteamManifest`, `ensureWritableDirectory`, `buildClasspathEntries`** (lines 76-819, alerts 57,58,340,354,60-76,304-306,81,82) — **false-positive**: every call site is either DB-sourced (no request taint at all) or validated + `server.install`-gated before the helper is ever reached.
- **`/install` ini existence check** (2676-2677, alerts 344,345) — **false-positive**: `serverName` regex blocks traversal regardless of `installPath` breadth.
- **`/branches`, `/install` steamcmdExe checks** (2065-2453, alerts 355,102,356,104) — **accepted-risk**: `isValidPath()` blocks traversal but not directory scope; `server.install` already implies full filesystem trust.
- **`/install`, `/quick-setup`, `/steam-update`, `/steamcmd/download`, `/steamcmd/check`** (2678-4225, alerts 346,121-134,347,348,135-145) — **accepted-risk**: same `isValidPath`/`isValidServerName` gate pattern, `server.install`-only, arbitrary-absolute-path is the documented install-anywhere feature.
- **`/delete-files`** (4308, 4401, alerts 307, 148) — **false-positive**: `deletePath` is validated, marker-checked, **and matched exactly against a configured server's stored `installPath` from the DB** (`matchesConfiguredServer`, lines 4342-4353) before the destructive `rmSync` at 4401 — CodeQL doesn't model the DB-equality check as a sanitizer, but it fully confines the real sink. *`permissions.js`'s `server.wipe` capability description was stale describing this route's pre-fix behavior — corrected in a separate commit, see "Secondary findings."*
- **`/list-directory`** (4472-4484, alerts 309,308,150) — **accepted-risk**: `isValidPath()`-gated, but this route is an explicit in-app filesystem browser (folder names only) — enumerating the host is the point.

**Cluster total: 62, real 0, false-positive 30, accepted-risk 32.**

### `server/routes/server.js` — command-line-injection, file-system-race, insufficient-password-hash (13 alerts)

- **Command-line-injection cluster incl. #297** (lines 253, 2098, 2465, 3728, 4167, alerts 10,11,12,13,297) — **accepted-risk**, see criticals section above. File already carries inline comments (dated 2026-08-27) documenting a prior remediation (`saveAndResolveSteamCmdExe`, persist-before-spawn) that closes the TOCTOU/divergence angle; verified present at every site.
- **`hashScriptContent`** (996, alert 334) — **false-positive**: SHA-256 content-drift fingerprint of the panel's own generated startup script (detects whether to back up before overwrite), not credential storage. The admin password that flows into the hash is *also* written in cleartext in the same script file at the identical trust boundary — the hash adds no exploitable exposure.
- **Console-log read/write TOCTOU** (4779-5013, alerts 246-252) — **false-positive**: all operate on the same fixed, non-attacker-controlled `server-console.txt` path; worst case is a caught `ENOENT` or stale read.

**Cluster total: 13, real 0, false-positive 8, accepted-risk 5.**

### `server/routes/servers.js` — path-injection (23 alerts)

Collapses into 4 route handlers (`/auto-scan`, `/detect`, `POST /`, `PUT /:id`). Same
`isValidPath()`/`isValidServerName()` pattern as server.js, all gated `servers.discover` or
`servers.manage` (technician/admin, whose documented job is host-filesystem
scan/browse/install).

- **`/auto-scan`, `/detect`** (alerts 83-99, 331, 550) — **accepted-risk**: `servers.discover`'s catalogue description explicitly documents "scan any path on the host filesystem you specify" as the feature.
- **`POST /` create-server, `importServerName` branch** (alerts 341,342,343) — **false-positive**: `importServerName` validated against `SERVER_NAME_REGEX` before interpolation — traversal characters rejected outright, and the branch requires `servers.discover` on top of `servers.manage`.
- **`POST /`, `PUT /:id` install-path shape check** (alerts 352, 353) — **accepted-risk**: config fields, existence-check only, no read/write of contents.

**Cluster total: 23, real 0, false-positive 3, accepted-risk 20.**

### `server/utils/fileWriteQueue.js` + `pidLock.js` + `database/init.js` (13 alerts)

`fileWriteQueue.js` is a leaf atomic-write utility (`writeFileAtomic`,
`sweepOrphanWriteTemps`) — every fs call derives from whatever `filePath`/`dir` its caller
passes. Traced all ~40 call sites: `serverFiles.js` (`serverName` hard-sanitized via
`path.basename`, throws on traversal), `mods.js` (`sanitizedServerName`), `server.js`
(install-path values the admin explicitly configured), `serverManager.js`/
`templateFiles.js`/`configBackup.js` (same DB-derived `configPath` shape). The only
non-hardcoded input is the server profile itself, settable only via a
`servers.manage`-gated endpoint.

- **`writeFileAtomic`, `sweepOrphanWriteTemps`, mode-preservation stat/chmod, atomic rename, tmp cleanup** (alerts 394,398,408,409,393,395,396,311,312,313) — **accepted-risk**: `filePath` traces to a DB-stored install/config path settable only via `servers.manage`; content is admin-authored config by design.
- **`pidLock.js` TOCTOU** (alert 265) — **false-positive**: `acquireLock(dataDir)` runs once at process boot, before any HTTP route exists — not request-derived at all.
- **`database/init.js` `normalizeServerMemory`** (alerts 36, 37) — **accepted-risk**: read-only `existsSync` boolean check on `servers.manage`-gated fields.

**Cluster total: 13, real 0, false-positive 1, accepted-risk 12.**

### `server/services/panelBridge.js` + `server/routes/panelBridge.js` (10 alerts)

`bridge.setup`'s capability description explicitly documents "pointing the local bridge at
any absolute host path outside a small blocked-directory list" as intended —
technician/admin only, never moderator. `bridge.command` (unrestricted game-command
passthrough) is admin-only.

- **`recoverSkippedResults`, `tryResyncInboxCommandCursor`** (897, 902, 925, 967, 974 — alerts 417,418,419,414,415) — **accepted-risk**. *(These 5 already carry CodeQL-accepted in-source suppression comments per the SARIF check above but were never manually dismissed — see "the suppression-pipeline question" section. Flagging here rather than reclassifying: the underlying reasoning is sound either way — `bridgePath` traces to a `bridge.setup`-gated, validated+blocklisted value.)*
- **`_enqueueCommand`** (774, alert 390) — **accepted-risk**: request-body `args` genuinely reach the IPC command file, but that's this route's documented job; every caller path requires a moderator-tier-or-above capability.
- **Result-file TOCTOU, status-poll TOCTOU, `/scan-paths`** (925, 1066, 1350, routes/panelBridge.js:1216 — alerts 420,258,259,242) — **false-positive**: only racing party is the trusted Lua mod or another bridge instance on the same folder; all caught/logged.

**Cluster total: 10, real 0, false-positive 4, accepted-risk 6.**

### `server/services/panelUpdateChecker.js` + `updateChecker.js` + `server/utils/certs.js` (12 alerts)

- **`certs.js` startup TOCTOU** (alerts 319,320,397) — **false-positive**: `loadOrCreateCerts()` runs once at boot (`index.js:617`), no HTTP route reaches it; failure is non-fatal.
- **`readMostRecentApplyLog` — supervisor.log/panel-update-last.log TOCTOU** (alerts 260,261,329,330) — **accepted-risk**: race only affects a debug/log display value in the panel's own private data directory; `GET /api/panel/update-apply-log` requires login but has no specific capability gate — narrower than ideal, but the raced content is informational only and `logsDir` isn't shared with other OS users the way `os.tmpdir()` is (contrast with #289 above).
- **`readMostRecentApplyLog` — legacy `os.tmpdir()` fallback** (alert 289) — **REAL, fixed. See "Top finding" above — led this doc, not buried in this cluster.**
- **GitHub release-check `https.get`** (alert 268) — **false-positive**: the "file" is the panel's own `package.json` version read once at boot, echoed into a request header to GitHub's API — not request-driven, not attacker-influenced.
- **`updateChecker.js` version/build-info TOCTOU** (alerts 262, 263) — **accepted-risk**: paths from operator-configured settings, `server.world_events`-gated; race only degrades parsed version info (caught, returns null).
- **`spawnWindowsApplyHelper`** (alert 5) — **false-positive (dead code)**: function has no caller anywhere in the codebase; the live Windows apply path hard-refuses (409) this legacy branch.

**Cluster total: 12, real 1, false-positive 8, accepted-risk 3.**

### `server/routes/mapProxy.js` + `server/routes/serverFinder.js` (9 alerts)

- **Tile cache read/write** (alerts 38-43, 274) — **false-positive**: `level`/`floor`/`tile` are strictly validated (bounded-integer parse + a regex permitting only digits, one underscore, and a fixed extension) before `path.join` — no traversal character can survive. Routes are intentionally ungated (loaded via `<img>` tags pre-auth), which is moot since the input is safe regardless of caller.
- **Steam API key usage** (alerts 266, 267) — **false-positive**: the flagged "file access" is reading the Steam API key from a Docker/K8s secret file, sent only to the hardcoded `api.steampowered.com` — the intended credential use, not exfiltration. Router gated `server.install`.

**Cluster total: 9, real 0, false-positive 9, accepted-risk 0.**

### `server/routes/mods.js` + `client/src/pages/Mods.tsx` (8 alerts)

- **`GET /api/mods/conflicts/diff` stat-then-read** (alerts 253-257) — **accepted-risk**: genuine TOCTOU, read-only, `mods.manage`-gated (admin/technician, who already hold `server.control`/`serverfiles.manage`/`rcon.execute`).
- **`GET /thumbnail/:workshopId`** (alert 328) — **false-positive**: the one intentionally-unauthenticated carve-out (loaded via `<img>` tags); `downloadThumbnail()` re-validates the fetch target against a hardcoded Steam-CDN allowlist, checks content-type, caps size, and path-contains the destination.
- **`Mods.tsx` substring checks (client)** (alerts 20, 298) — **false-positive**: neither substring check gates a security boundary — one is a UX auto-discover heuristic, the other a cosmetic pre-submit validation toast; the real validation happens server-side with a proper regex and a hardcoded fetch target.

**Cluster total: 8, real 0, false-positive 6, accepted-risk 2.**

### `server/routes/auth.js` + `server/services/auth.js` + `server/index.js` + docker updater (12 alerts)

Given this is the authentication layer itself, each finding was traced through real control
flow rather than pattern-matched. **No auth-bypass condition was found.**

- **CSRF token validation** (alert 335) — **accepted-risk**: refresh cookie is `httpOnly`, `sameSite: "strict"`, path-scoped; all state-changing routes require an `Authorization: Bearer` header a pure cross-site request can't set. CodeQL's CSRF query doesn't model `SameSite=Strict` as sufficient on its own.
- **Public-route exemptions** (`/api/debug/client-errors`, `/api/health`, docker updater's `/status`) (alerts 318, 235, 230) — **false-positive**: each is an intentional, narrow, hardcoded-path exemption with no privileged action reachable (rate-limited crash reporting; version-only health check; token-gated internal-network-only updater).
- **Login/setup presence checks** (alerts 317, 316, 315, 314) — **false-positive**: these only decide whether to *attempt* the real credential check; the actual decision is `bcrypt.compare` deep in `services/auth.js`, with dummy-hash timing mitigation.
- **Bearer-header enforcement branch** (alert 236) — **false-positive**: this *is* the fail-closed auth check (401 on missing/malformed header) — CodeQL is flagging the origin of the check as if it were a bypass of one.
- **Reset-token file TOCTOU** (alerts 238, 237) — **accepted-risk**: only a party with local write access to `data/` could race it, and that party could already overwrite the token file directly for the same result; comparison uses `timingSafeEqual` regardless.
- **`ComSpec` env var in Windows supervisor bootstrap** (alert 4) — **false-positive**: `ComSpec` is a standard OS-set variable, not request-influenced; `spawn` uses an args array, no shell interpolation.

**Cluster total: 12, real 0, false-positive 8, accepted-risk 4.**

### `server/routes/serverFiles.js` + `uiSecretFile.js` + `chunks.js` + `backup.js` + `paths.js` (10 alerts)

- **`PUT /ini` prototype-pollution shape** (alert 351) — **false-positive**: lines 1348-1358 already reject any `settings` object with an own `__proto__`/`constructor`/`prototype` key before the flagged loop runs.
- **`uiSecretFile.js` internal helper** (alerts 391, 322) — **false-positive**: the filename component is always a hardcoded literal from ~8 call sites; only the secret *content* is request-derived, which is the intended "save credential from Settings" feature.
- **Template save/list, `/delete-region`, backup `/upload`, `/debug/paths`** (alerts 275, 276, 244, 245, 273, 272, 288) — **accepted-risk**: each writes to a sanitized/fixed-directory filename or the panel's own fixed config path, all gated `serverfiles.manage`/`chunks.manage`/`backups.manage`/`diagnostics.manage` (admin/technician-exclusive; `diagnostics.manage` is admin-only). *`paths.js`'s `setDataPaths()` (alert 288) already carries inline `codeql[js/path-injection]` suppression comments at lines 221-266 — same undismissed-despite-accepted-suppression pattern as panelBridge.js above.*

**Cluster total: 10, real 0, false-positive 3, accepted-risk 7.**

### `server/services/serverManager.js` + `rcon.js` + `sourceRcon.js` + `embeddedLua.js` + `panelBridgeSftp.js` + `remoteConfigFiles.js` (12 alerts, incl. critical #333)

- **`checkTcpReachable`, `SourceRconClient.authenticate`** (alerts 333, 26) — **accepted-risk**, see criticals section above.
- **`ensureReadableDirTree`** (embeddedLua.js:65,68,70 — alerts 399,400,401) — **false-positive**: `dir` traces to `destPath`, already validated (4 sibling `codeql[...]` suppressions at lines 98/103/110/114 in the same file, enforced by `panelBridge.js:3254-3300`) — required-absolute + realpath'd + must end in `/media/lua/server(/)`. These 3 new sink lines don't yet carry their own matching suppression comment; **deliberately not added** — see "The suppression-pipeline question" above for why a comment alone wouldn't close these anyway.
- **`serverBat`/custom-launcher spawn** (alerts 271, 270, 6) — **accepted-risk**: values are never request-controlled at request time (DB row or deploy-time env var only), `startCommand` additionally passes `validateStartCommand()` (blocks shell metacharacters), is extension-allowlisted, and `spawn()` uses an argv array with no `shell:true`. Documented as an intentional, supported feature (commit `df0ff31`).
- **`getSftpCachePath`, `getMirrorPath` hash inputs** (alerts 403, 299) — **false-positive**: both `sha256` calls hash only `host:port:username:...` — `password` is never part of the hashed string; CodeQL's field-insensitive taint over-attributes because the same config object also carries a `.password` property elsewhere.
- **`safeRemoteDir`, `safeRemotePath` — polynomial ReDoS** (alerts 3, 1) — **REAL, fixed. See "The two polynomial-ReDoS findings" above.**

**Cluster total: 12, real 2, false-positive 5, accepted-risk 5.**

### `server/tests/*.test.js` (15 alerts)

All 15 are test-only code, checked individually against the rule "noise unless the pattern
also appears in shipped code" — for each, grepped the corresponding production file to
confirm the pattern doesn't leak. **None do**, with one exception that's a confirmed
cross-batch consistency check, not a new finding: `cspScriptHash.test.js`'s alert (#300)
and `cspScriptHash.js`'s own alert (#301, in the misc-small cluster below) independently
reached the same false-positive verdict from two reviewers who hadn't seen each other's
work — both concluded the case-sensitive `<script>` regex only ever parses the panel's own
trusted build artifact and fails closed.

**Cluster total: 15, real 0, false-positive 15, accepted-risk 0.**

### Misc small: `cspScriptHash.js`, `routes/players.js`, `routes/debug.js`, `scripts/ui-shot-tour.mjs` (7 alerts)

- **`ui-shot-tour.mjs`** (alerts 412, 411) — **false-positive**: dev/CI tooling script, not shipped; writes a manifest from a throwaway local dev server it spawns itself.
- **`cspScriptHash.js`** (alert 301) — **false-positive**: see above.
- **`GET /diagnostics` log read** (alerts 240, 241) — **false-positive**: hardcoded filename, `diagnostics.manage`-gated (admin-only); only PZ's own log writer could race it.
- **`GET /crash-logs/:filename`, `GET /exports/:username/:filename`** (alerts 243, 239) — **accepted-risk**: genuine check-then-use TOCTOU, but both validate the filename against traversal and resolve under a small fixed directory set first; exploiting the race needs local filesystem write access nobody without host access already has. *`players.js`'s `players.gm_tools` gate is the one alert in the entire triage reachable by the moderator role — still accepted-risk since the exploit path requires local host filesystem access moderator doesn't have.*

**Cluster total: 7, real 0, false-positive 5, accepted-risk 2.**

### Client-only: `Events.tsx`, `Console.tsx`, `vite.config.ts`, `modSettingsLabels.ts` (8 alerts)

Read-only triage; client/ is owned by other agents on this project, so nothing here was
edited even where a fix was warranted.

- **`pickStrikeTarget()` `Math.random()`** (alerts 35,34,324,323,413) — **false-positive**: randomness only selects which already-online player an already-authorized admin's command targets — no token/session/credential decision involved.
- **`sendAnnouncement()` quote-escaping** (alert 27) — **accepted-risk**: mechanically real (backslash left unescaped before embedding into an RCON `servermsg` string could break quoting), but the route is gated behind `canExecuteRcon` — the only actor who could exploit it already has direct arbitrary-RCON-execute access via the same page's command bar.
- **`vite.config.ts` chunk-naming check** (alert 22) — **false-positive**: build-time only, never ships to the browser, `id` is a bundler-resolved filesystem path not attacker input.
- **`modSettingsLabels.ts` regex escape** (alert 19) — **false-positive**: inside a character class, `\.` and `.` are behaviorally identical — a style nit with zero effect on matching or security.

**Cluster total: 8, real 0, false-positive 7, accepted-risk 1.**

## Secondary findings

1. **Suppression-accepted-but-undismissed alerts exist beyond the 5 already noted above.**
   Any future CodeQL run may surface more of these as new alert numbers even where the
   underlying code is unchanged and already has an accepted in-source suppression. See "The
   suppression-pipeline question, settled" above — this is the top recommendation from this
   triage.
2. **`server/services/permissions.js`'s `server.wipe` capability description was stale —
   fixed, own commit.** It described `/delete-files`'s behavior *before* the 2026-08-27 fix
   that added the `matchesConfiguredServer` DB-equality whitelist (server.js:4342-4353),
   overstating the route's current reach to a future reader of the capability catalogue.
3. **`.github/workflows/codeql.yml`'s own suppression-status comment was stale — fixed, own
   commit.** It asserted suppression "never engages... for anyone, ever" and "STILL
   UNVERIFIED" — both were true when written but are now false per the SARIF check above;
   corrected in place so the next reader doesn't redo this exact investigation.
4. **`server/utils/embeddedLua.js:65,68,70`** don't carry their own `codeql[...]`
   suppression comment, unlike 4 sibling sinks in the same file. **Deliberately not added**:
   per finding above, an accepted suppression doesn't dismiss an alert on its own, so adding
   three more comments to the ~105 already written wouldn't close these — it would be
   documentation value only, and this triage doc already records the same reasoning in one
   place.

## What was and wasn't done

- **Nothing was dismissed in the GitHub UI or via the API.** Per the task brief, dismissals
  go to the operator as one batch from `god`, citing sections of this doc.
- **The 3 real findings were fixed** with the smallest change that closes each (in #289's
  case, the smallest change that removes the vulnerable code path entirely rather than
  patching around it), tests included, entirely within `server/` — no `client/` files were
  touched anywhere in this triage, even where a fix was identified (see the client-only
  cluster).
- **The `server.wipe` catalogue-text fix and the `codeql.yml` comment fix are each their own
  commit**, separate from the 3 security fixes, per instruction.
- **`CHANGELOG.md` and `package.json` were not touched**, per standing instruction.
