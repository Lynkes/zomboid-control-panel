# Kevin — adversarial route hunt (Creed's unfinished list)

Read-only bug hunt, continuing where Creed was archived mid-sweep. Scope: `server/routes/{scheduler,rcon,discord,serverFiles,discovery,templates,serverFinder,panelBridge}.js` and the rest of `server/routes/servers.js` not already covered by Creed's Finding 1.

Order (by who gets hurt): scheduler.js (runs unattended) → rcon.js (live wire to the running server) → discord.js (holds credentials) → serverFiles.js (writes to disk) → the rest.

Hunting for, per god's brief (each pattern found at least once in this codebase already tonight):
1. A comment that states a guarantee the code does not implement.
2. A check that cannot fail (`isAbsolute(resolve(x))` and friends).
3. Success reported regardless of outcome.
4. A route with no gate where every sibling has one.
5. Partial failure in a multi-step operation reported as success.

Note on Creed's own coverage doc (`docs/qa/creed-findings.md`): he says he already read `scheduler.js` (full) and `rcon.js` (full) himself, but only to confirm they don't share the `isAbsolute(resolve())` bug — not a full sweep for all five patterns above. Treating both as unread for patterns 1/3/4/5 and re-reading in full regardless, rather than trusting a partial note.

Findings appended as found and verified. Clean areas logged explicitly too — a silent area should read as "checked, clean," not as "not looked at."

---

## Area checked clean — scheduler.js (route + core dispatch in services/scheduler.js)

**READ:** `server/routes/scheduler.js` (full, 399 lines) and the dispatch path it calls into: `services/scheduler.js`'s `runTaskNow`, `executeTask`, `executeBridgeAction`, `_resolveServicesForTask` (~lines 100-390).

- **Gate (pattern 4):** entire router gated at the top with `router.use(requirePermission('automation.manage'))` — no per-route gaps, nothing to slip through.
- **Success-regardless-of-outcome (pattern 3):** `/tasks/:id/run` and `/restart-now` both fire their real work in the background and respond immediately ("Task triggered" / "Restart initiated") — looks like the bug pattern at first glance, but it isn't: both response strings describe *acceptance*, not *completion*, and both are true regardless of what happens next. The actual outcome is written to a queryable audit trail either way: `runTaskNow`'s try/catch calls `logScheduleExecution(..., success, ...)` (surfaced via `GET /history`) and `logServerEvent(...)` on BOTH the success and failure path, not just success. Traced every command branch inside `executeTask` (`restart`, `save`, `servermsg `, `bridge:`, raw RCON) — every one checks `result.success` and throws on failure rather than assuming success; `executeBridgeAction` does the same (`result.success === false` → throw). Nothing here reports success it didn't earn.
- **One minor, non-blocking note, not filed as a Finding:** `/restart-now`'s failure path is recorded via `logServerEvent("auto_restart_error", ...)`, which is only readable through `GET /api/debug/activity`, gated on `diagnostics.manage` — a *different* capability than the `automation.manage` this whole router requires to trigger the restart in the first place. An operator holding only `automation.manage` (not `diagnostics.manage`) can trigger a restart and has no in-app way to discover it silently failed. Not filing this as a Finding on its own — it's a capability-boundary gap, not a false guarantee or a missing gate, and admin holds both by definition — but worth someone's attention if `automation.manage` is ever delegated on its own to a role that doesn't also hold diagnostics access.
- **Comment-guarantee check (pattern 1):** grepped for never/always/cannot/guarantee — the only hits (`'Tasks cannot run more frequently than every 5 minutes'`, `'Cannot restart a remote server'`) are literal user-facing error strings describing an enforced check right above them, not aspirational comments. `isCronTooFrequent()`'s own logic was read end to end (comma-separated minute lists, range-step forms, wrap-around) — it's conservative by design (documented explicitly: "Conservatively gate this on hour === '*'"), not a check that's silently always-true or always-false.
- **Dead check (pattern 2):** none — no `isAbsolute(resolve())`-shaped code in this file at all (it doesn't touch the filesystem).

No findings here. Confirms Creed's own note that he'd already read this file, extended now to all five patterns rather than just the one he was checking for.

---

## Area checked clean — rcon.js

**READ:** `server/routes/rcon.js` (full, 209 lines) plus `services/rcon.js`'s `getConfig()`, `execute()`, `healthCheck()`.

- **Gate (pattern 4):** the file's OWN header comment documents a genuine mixed-gating design — `/execute`, `/connect`, `/disconnect`, `/test` require `rcon.execute` (admin+technician), while `/status`, `/health`, `/history`, `/commands`, `/commands/:category` stay open to every logged-in role, with the comment's stated reason: "nothing sensitive is returned." Did not take that on trust — checked the one field that could actually break the claim: `getConfig()` (backs the fully-open `GET /status`) explicitly returns `{host, port, connected, lastSuccessfulCommand, reconnectAttempts, autoReconnectEnabled}` — the RCON **password is deliberately excluded** from the object, not merely absent by oversight (nothing else in the class exposes it either). `/history` returns raw RCON command text via `getCommandHistory()` — real disclosure of what commands were run, but not a credential leak, and the file's comment already reasons about this tradeoff rather than asserting it blindly. Judged genuinely deliberate, not the accident-described-as-decision pattern.
- **Success-regardless-of-outcome (pattern 3):** `execute()` in the service is the strongest-hardened thing found in this hunt so far — it explicitly pattern-matches the RCON server's own "Unknown command" reply text and converts it to `success: false`, with a comment explaining why: *"The server answers an unrecognised command with a normal RCON reply, so without this check a command removed by a game update looks like it succeeded."* That is exactly pattern 3, already caught and fixed by whoever wrote this. `/execute` the route passes the service's result straight through (`res.json(result)`) without re-wrapping or losing the `success` field.
- **Dead check (pattern 2):** none — no `isAbsolute`/`resolve` anywhere in this file (no filesystem access at all).
- **Comment-guarantee (pattern 1):** the one guarantee claim in the file ("nothing sensitive is returned") was checked against the actual code, not assumed — holds up.

No findings.

---

> **RECONCILED 2026-08-24 (fork):** FIXED at `4e2f0c5` ("fix(discord): PUT /config reports
> whether the post-save reconnect worked"). `discord.js` now captures `discordBot.start()`'s
> return value; on `false` it responds `{success:true, message:"...but the bot failed to
> reconnect.", botStarted:false, botStartError:...}` instead of a flat `success:true` — exactly
> the fix shape recommended below.

## Finding 1 — PUT /api/discord/config reports success even when the reconnect it just triggered failed

**WHERE:** `server/routes/discord.js:139-185` (`PUT /config`), the exact contrast is `server/routes/discord.js:193-218` (`POST /start`) 30 lines below it.

**WHAT HAPPENS:** When an operator changes the bot token/guild ID while the bot is running, the route does:
```js
if (discordBot.isRunning && credentialsChanged) {
  await discordBot.stop();
  await discordBot.start();
}
res.json({ success: true, message: "Discord bot configuration updated" });
```
`discordBot.start()`'s return value is discarded. `services/discordBot.js:1391-1603` shows `start()` genuinely returns `false` (not a throw) on several real, reachable failure paths — no token, and, more relevantly here, a login failure or a 30-second ready-timeout (`services/discordBot.js:1555-1601`, `catch (error) { log.error(...); ...; return false; }`). The dedicated `POST /start` route 30 lines below checks this exact return value correctly (`if (started) {success:true} else {400, "Failed to start bot - check configuration"}`) — proving the codebase already knows `start()` can fail without throwing; `PUT /config` just doesn't apply the same check to its own call to the same function.

**CONCRETE SCENARIO:** Operator pastes a new (typo'd, expired, or revoked) bot token into Settings and saves. The route validates the Snowflake-shaped IDs (fine), saves the new token to disk, stops the old connection, calls `start()` — which fails to log in and returns `false` — and still responds `{success: true, message: "Discord bot configuration updated"}`. The UI has no reason to show anything but success. The bot is now not running, and the only way to discover that is to separately check `GET /status` or notice no Discord messages ever arrive.

**WHAT SHOULD HAPPEN:** Check the return value the same way `POST /start` already does — e.g. respond with `success: true` but a `botStarted: false` / warning field (config was saved correctly; only the reconnect failed) rather than a single flat `success: true` that conflates "your settings were saved" with "the bot is now running."

**SEVERITY: Low-medium.** Not security-relevant, not data-destroying — the saved config itself is correct and nothing is lost; a re-save or a manual `POST /start` recovers it. This is squarely pattern 5 (partial failure in a multi-step operation reported as plain success), the same shape god named for delete-region before tonight.

---

## Rest of discord.js checked clean

**READ:** full file, 478 lines, plus `resetConfig()`/`updateConfig()`/`getStatus()` in `services/discordBot.js`.

- **Gate (pattern 4):** entire router gated at the top (`router.use(requirePermission("integrations.manage"))`) — uniform, no per-route gaps.
- **Credential handling:** `GET /config` masks the token (`"••••••••" + token.slice(-4)`), matches the established masked-secret convention used elsewhere tonight. `POST /test` validates a CALLER-SUPPLIED token against Discord's API before it's ever saved — doesn't touch the stored token, doesn't leak it back (response is bot username/id/discriminator/avatar only).
- **`resetConfig()`'s own partial-failure shape, NOT filed as a finding:** it best-effort-clears Discord-side slash commands first (swallows that specific failure into a `log.warn`, doesn't rethrow) then unconditionally proceeds to stop the bot and wipe local settings. Judged intentional graceful degradation, not a false claim — the *local* reset (the part the response's "success" actually describes) really does complete either way; a failed remote slash-command clear is a cosmetic Discord-side leftover, not something the panel claims it fixed.
- **Dead check (pattern 2):** none — no path/filesystem handling in this file.
- **`PUT /webhook-events` / `PUT /permissions`:** both echo back exactly what was persisted rather than blindly claiming success; both whitelist keys before merge (prevents arbitrary-key injection into stored config).

---

> **RECONCILED 2026-08-24 (fork):** FIXED at `494de7a` ("fix(security): createBackup()
> distinguishes 'nothing to back up' from 'the backup failed' -- no response may claim a backup
> exists unless it does"). `createBackup()` now returns a structured `{backedUp, name, error}`
> object instead of silently returning `null`. `POST /sandbox/repair` (the sharpest case cited
> below) now checks `!backup.backedUp` and REFUSES to write and repair, returning
> `SANDBOX_REPAIR_BACKUP_FAILED` with the underlying reason — stronger than the minimum fix
> suggested (check-and-warn); it check-and-refuses. `backupWarningFor()` now wraps every other
> call site too (grepped: `createBackup(` appears at 11 sites, all now routed through it).

## Finding 2 — DATA-DESTROYING: createBackup()'s return value is silently discarded at all 11 call sites in serverFiles.js; POST /sandbox/repair explicitly tells the operator a backup exists when it may not

**WHERE:** `server/routes/serverFiles.js:308-358` (`createBackup()`), called at lines 1071, 1170, 1227, 1318, 1384, 1455, 1507, 1587, 1686, 1912, 1928 — every one of them `await createBackup(...)` with the return value discarded. Sharpest instance: `POST /sandbox/repair`, lines 1352-1413.

**WHAT HAPPENS:** `createBackup()` wraps its ENTIRE body (existence check, mkdir, the actual `fs.promises.copyFile`, old-backup cleanup) in one try/catch that returns `null` on ANY failure — disk full, backup directory unwritable, a copy that fails partway — logging only `log.error(...)`. It never throws. Every call site in this file does `await createBackup(...)` as a bare statement, immediately followed by `writeFileAtomic(filePath, newContent, ...)` unconditionally — the code cannot tell, and does not check, whether the backup it just "created" actually landed on disk.

The sharpest case is `POST /sandbox/repair`: it repairs a corrupted `SandboxVars.lua`, and its success response literally says **"A backup of the broken file was saved first."** That sentence is asserted regardless of whether `createBackup()` returned a real filename or silently swallowed a failure and returned `null`. This is a comment/message stating a guarantee the code does not implement (pattern 1) directly enabling a data-destroying outcome (pattern 5): if the backup silently failed AND the repair heuristic (`repairSandboxSyntax`, pattern-based, not guaranteed-correct — the route's own error path already admits *"the corruption doesn't match a known pattern"* is a real possibility) produces content that's wrong in some way the brace-balance check doesn't catch, the operator has no recovery path and has just been told, in the response, that they do.

**HOW I KNOW:** Read `createBackup()` end to end (lines 308-358) — the outer `try { ... } catch (error) { log.error(...); return null; }` covers everything including the actual `copyFile`. Read `writeFileAtomic()` in `utils/fileWriteQueue.js:48-68` to rule out a hidden safety net there — it's a plain write-to-tmp-then-rename, no backup behavior of its own. Grepped every `createBackup(` call site in this file (11 total) and spot-checked three (`/sandbox/repair`, `PUT /ini`, and the pattern repeats identically) — none capture or branch on the return value.

**WHAT SHOULD HAPPEN:** At minimum, `/sandbox/repair` (and ideally every call site) should check `createBackup()`'s return value and refuse to write — or write but tell the truth in the response — when it's `null`. The function already distinguishes its failure case cleanly (`return null`); the call sites just never look.

**SEVERITY: Data-destroying — reporting this one separately and immediately, per your instruction, rather than batching it.** Same shape and same real-world consequence as the backup-prune bug you already closed tonight: a written guarantee about data safety that the code doesn't actually enforce, on the exact file an operator is trying to recover.

---

> **RECONCILED 2026-08-24 (fork):** FIXED at `9305865` ("fix(serverFiles): save-and-reload
> reports what RCON actually returned"). The route now checks `result?.success` from
> `reloadOptions()` and responds `{success:false, error, result}` on a real RCON failure instead
> of a hardcoded `success:true`.

## Finding 3 — POST /save-and-reload hardcodes success:true regardless of whether RCON actually reloaded anything

**WHERE:** `server/routes/serverFiles.js:1703-1720`.

**WHAT HAPPENS:**
```js
const result = await rconService.reloadOptions();
res.json({ success: true, message: "Options reloaded", result });
```
`reloadOptions()` (`services/rcon.js:1383-1385`) is a thin wrapper over the already-hardened `execute()` (see the rcon.js clean-area note above — it correctly returns `{success: false, error, ...}` on a failed/unknown-command RCON reply). This route receives that result, nests it under `result`, but the TOP-LEVEL `success` field is a literal `true`, not `result.success`. If the live RCON `reloadoptions` command fails for any reason the response still says `success: true, message: "Options reloaded"`.

**CONCRETE SCENARIO:** Operator edits sandbox/INI settings, then hits "Save & Reload" to push them onto the live server without a restart. If the RCON command times out or the connection drops mid-command, the panel reports success; the running server is still on the OLD settings, and the operator has no reason to check.

**SEVERITY: Low-medium**, same class as Finding 1 (discord.js) — not security, not data-destroying (the file on disk was already saved by a separate prior request; this route only relays the config into the running process). Batching with Finding 1 rather than sending separately.

---

> **RECONCILED 2026-08-24 (fork):** FIXED at `913fc3a` ("fix(serverFiles): template apply
> reports a partial write, not a flat failure") — a DIFFERENT fix shape than the
> `writeFilesTransaction()`-style rollback suggested below, and a legitimate alternative: `applied`
> is now declared outside the try block and pushed to as each write actually lands, so the catch
> block can see and report `partiallyApplied: applied` alongside the 500 instead of a bare error
> that reads as "nothing happened." No rollback was added — this is honest reporting of what
> landed, not prevention of the partial state — but it fully closes the "total-failure-claimed-
> on-partial-success" defect described below.

## Finding 4 — POST /templates/:id/apply: a real partial-apply (INI write succeeds, Sandbox write fails) is reported as a total failure, hiding that half the template already landed

**WHERE:** `server/routes/serverFiles.js:1883-1951`.

**WHAT HAPPENS:** Applies a saved template's INI and Sandbox settings as two SEPARATE, non-transactional `fs.writeFileSync` calls inside one try block: INI backup+write (1911-1917), then Sandbox backup+write (1927-1933). If the INI write succeeds and the Sandbox write then throws (disk fills up between the two writes, permissions change, anything), the whole handler falls into the outer `catch` and returns a flat `500 { error: ... }` — which reads as "nothing happened," but the INI file was in fact already overwritten with the template's values. This is the mirror image of the pattern named in the brief: not success-claimed-on-failure, but total-failure-claimed-on-partial-success. Same family of bug as the `Mods.tsx` "preset may have partially applied" comment investigated earlier tonight — except there, the backend write turned out to be genuinely atomic (one write) and the comment was simply wrong; HERE the backend write is genuinely NOT atomic, so the equivalent worry would be justified if this route had a similar comment (it doesn't currently claim anything either way, so this isn't a pattern-1 case, purely pattern 5).

**HOW I KNOW:** Read the full route body; confirmed the two writes are independent `fs.writeFileSync` calls with no shared transaction/lock across both (each has its own `createBackup()` call, already flagged under Finding 2), and that the `applied` array (which WOULD have told the truth) is only ever read on the success path — the catch block doesn't reference it at all.

**SEVERITY: Low.** Narrow failure window (two synchronous writes back to back), and retrying the same apply is idempotent/safe (it would just reapply both again) — no data is lost, just a misleading error message on an already-rare failure. Batching with Findings 1 and 3, not urgent.

**UPDATE while reading templates.js next: there is already a correct reference implementation of this exact problem in the same codebase.** `server/utils/templateFiles.js:177-198`'s `writeFilesTransaction()` (used by the OTHER, separate template system — see below) writes each file in sequence but on any failure rolls every already-written file back to its original content (or deletes it if it didn't exist before), then re-throws. Fixing Finding 4 is a matter of routing `serverFiles.js`'s two `fs.writeFileSync` calls through the equivalent of this function, not inventing a new mechanism — same shape as Creed's isAbsolute(raw-input) cross-reference between panelBridge.js's correct sites and servers.js's broken ones.

---

## Rest of serverFiles.js checked

**READ:** entire route map (24 routes, all gated uniformly by `router.use(requirePermission("serverfiles.manage"))` at line 33 — no pattern-4 gaps in this file), `checkSandboxBraceBalance`/`repairSandboxSyntax` (lines 676-758, genuinely correct — the "always"/"never" claims in their comments were checked against the code and hold), `confineToRoots` (shared `utils/browseRoots.js`, a real reachable-false containment check, not the dead `isAbsolute(resolve())` shape — used correctly by `/browse-files` and `/image-preview`), `PUT /sandbox-option` and the PanelBridge-facing `persistSandboxValues`/`writeSandboxValues` (lines 1192-1324) — both honestly report a real `persisted` boolean rather than a blind `success: true`, and `writeSandboxValues` explicitly detects "key not present in file" before writing rather than silently no-op-ing and calling it done.

Findings 2, 3, 4 above are everything found in this file. Everything else checked (INI/spawnpoints/spawnregions GET+PUT, `/raw/:type`, `/backups`, templates list/get/create/update/delete) follows the same honest-result-reporting shape as `/sandbox-option`.

---

## Area checked clean — discovery.js

**READ:** full file, 125 lines. One mutating route (`POST /create-from-discovery`, gated `servers.discover`); `GET /discover-mounts` is an ungated read-only probe of standard bind-mount locations — returns candidate paths only, no credentials, same shape as the other deliberately-open read-only routes found tonight. Not filing. No dead checks, no false guarantees, no partial-failure masking — every validation step (`installResult.valid`, `dataResult.valid`, `SERVER_NAME_RE`, `iniSettings?.rconPassword`) is checked and returns a specific 400 before the server gets created.

---

> **CORRECTION 2026-08-24 (fork), NOT a clean area — this "checked clean" verdict was wrong.**
> The `DEFAULT_INI_EXCLUSIONS` claim below ("A template can structurally never contain a
> credential... enforced at validateTemplate()") does not hold. Found and confirmed the same
> night, by a separate hunt: `validateTemplate()` (utils/templateSchema.js:124-126) and the
> apply-time write path `prepareIniChange()` (templateService.js:192) both read the exclusion
> list FROM THE TEMPLATE ITSELF when supplied as an array, so a template shipping
> `"iniExclusions": []` bypasses the check entirely and its `serverIni.RCONPassword`/etc. gets
> written to the live `.ini`. This is a real capability-boundary violation — `templates.manage`
> alone can rewrite credentials that should require `serverfiles.manage`. HIGH severity,
> CONFIRMED LIVE, fix already dispatched to Kevin as of this reconciliation — see
> `docs/qa/creed-findings.md` Finding 7 for full detail. The original check here likely tested
> "does validateTemplate refuse a template with excluded keys and no custom iniExclusions" and
> didn't try supplying a competing `iniExclusions` alongside the excluded key — an easy case to
> miss precisely because the function's own comment asserts it's unconditional.

## Area checked clean — templates.js + services/templateService.js (a SEPARATE, more sophisticated system from serverFiles.js's own embedded `/templates` routes above — worth knowing both exist)

**READ:** `server/routes/templates.js` (full, 137 lines), `services/templateService.js` (full), `utils/templateSchema.js`'s validation/exclusion logic, `utils/templateFiles.js`'s file-writing helpers.

- **Gate (pattern 4), noted but not filed:** `POST /`, `POST /import`, `POST /:id/apply`, `DELETE /:id` require `templates.manage`; `GET /`, `GET /:id`, `GET /:id/export`, `POST /:id/preview` do not. Checked whether this is the backup-download shape (real secret exposure) before deciding: it isn't. `utils/templateSchema.js`'s `DEFAULT_INI_EXCLUSIONS` (`RCONPassword`, `Password`, `ServerName`, `PublicName`, ports) is enforced at `validateTemplate()` — both `saveTemplate()` and `importTemplate()` call it and REFUSE to persist a template whose `serverIni` contains an excluded key. A template can structurally never contain a credential, so reading one (export or preview) has nothing sensitive to leak — this read/write split looks like a genuine, reasonable design choice, not an oversight.
- **Success-regardless-of-outcome / partial failure (patterns 3/5):** clean, and better than clean — `applyTemplate()` → `applyTemplateLocked()` writes the INI and Sandbox changes through `writeFilesTransaction()` (`utils/templateFiles.js:177-198`), which is a REAL transaction: if the second file's write throws, every already-written file in the batch is rolled back to its original content (or deleted if it didn't exist before) before the error propagates. This is the exact mechanism Finding 4 (serverFiles.js's parallel, cruder template system) is missing — see the note added there.
- **Backup-before-write, contrasted with Finding 2:** `backupFile()` (`templateFiles.js:163-171`) does NOT swallow a failed copy — no try/catch around `fs.copyFileSync`, so a failed backup throws and aborts the whole apply before `writeFilesTransaction()` ever runs. Fail loud and don't write, rather than serverFiles.js's `createBackup()` silently returning `null` and letting the write proceed anyway. Better design, worth pointing at as the fix pattern for Finding 2 as well as Finding 4.
- **Dead check (pattern 2):** none.

No findings — if anything, this file is the "restore path is genuinely solid" of this hunt: a second, harder-to-get-right multi-file write problem, done correctly right next to two files that got it wrong.

---

> **RECONCILED 2026-08-24 (fork):** FIXED at `7ff8763` ("fix(security): serverFinder's SSRF
> deny-list now blocks 100.64.0.0/10"). `isPrivateIp()` now includes
> `if (a === 100 && b >= 64 && b <= 127) return true;` — the exact fix suggested below, verbatim.

## Finding 5 — serverFinder.js's SSRF deny-list misses 100.64.0.0/10 (Carrier-Grade NAT / shared address space)

**WHERE:** `server/routes/serverFinder.js:19-35` (`isPrivateIp`), consumed by `validateQueryIp` and gating both `GET /query` and `GET /ping` — the only two routes in this file that take a caller-supplied IP and make the server itself send a UDP packet to it.

**WHAT HAPPENS:** `isPrivateIp()` is a deliberate, comment-labeled SSRF guard ("Block private/reserved IP ranges to prevent SSRF") — this whole feature exists to probe ARBITRARY external game servers, so a deny-list (not an allow-list) is the only workable shape here, which makes the deny-list's completeness the entire security boundary. It correctly blocks `0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16` (covers the cloud-metadata IP `169.254.169.254` too), `172.16.0.0/12`, `192.168.0.0/16`, and `224.0.0.0/4`+ (multicast/reserved). It does **not** block `100.64.0.0/10` (RFC 6598, Carrier-Grade NAT / Shared Address Space) — `a === 100` never appears anywhere in the range checks. That block is increasingly used as an internal routing range by cloud providers, some Docker/Kubernetes CNI setups, and CGNAT ISPs — an admin/technician-gated caller could point `/query` or `/ping` at a `100.64.x.x`-`100.127.x.x` address and get a real UDP probe sent from the server's own network position.

**HOW I KNOW:** Read `isPrivateIp()` line by line and checked its range list against the full set of IANA special-purpose IPv4 ranges. Confirmed the protocol surface is narrow either way — `queryServerInfo()` sends one fixed 25-byte A2S_INFO UDP packet and only parses a Source-Engine-shaped reply; it isn't a generic fetch-and-return-body primitive.

**WHAT SHOULD HAPPEN:** Add `if (a === 100 && b >= 64 && b <= 127) return true;` alongside the existing range checks.

**SEVERITY: Low-medium.** Already gated behind `server.install` (admin+technician, not moderator or a bare custom role), and the probe itself is a narrow UDP banner-grab, not arbitrary read/write against an internal service — this is real but wouldn't have made my "report separately and immediately" bar. Batching into the next round.

---

## Rest of servers.js checked clean (beyond Creed's Finding 1)

**READ:** `GET /`, `/status`, `/rcon-status`, `/active`, `/:id` (all ungated but all either route through `sanitizeServerResponse(List)` or return genuinely credential-free status data — `/rcon-status`'s own comment claims "never returns credential material," checked and holds: response is `{id, status}` where status is a short enum-like string, never the password); `POST /` and `PUT /:id` (both `servers.manage`) — whitelisted update fields prevent mass assignment, `isMaskedSecret()` correctly strips a resubmitted masked placeholder before it can overwrite the real stored `rconPassword`/`adminPassword`, every downstream reconnect/reload step (ServerManager, RconService) is independently try/caught with a `log.warn` rather than failing the whole request or silently claiming reconnect succeeded — response text stays honestly scoped to "server updated," not "server updated and reconnected"; `DELETE /:id`; `POST /:id/activate`'s "never let an install failure block activation" comment (verified: `autoInstallBridgeIfNeeded` is synchronous, self-contained try/catch, called unawaited — structurally cannot produce an unhandled rejection or block the response).

---

## Finding 6 — panelBridge.js: dead checks fixed (this hunt), stale comment (not fixed), one item flagged as unverified rather than guessed

> **RECONCILED 2026-08-24 (fork):** Dead checks — FIXED, self-reported and verified: `0cacaa8`
> is a real commit, confirmed via `git show`, and a repo-wide grep for `isAbsolute(resolve` /
> `isAbsolute(path.resolve` now returns zero hits anywhere. Stale comment — ALSO NOW FIXED (was
> open when this file was written): `24f2338` ("docs(security): reword the POST /command comment
> tonight's own work falsified") rewrote it; current text no longer claims the gate "has no
> effect today," instead states plainly it's "live and doing real work today" with the reasoning
> the original comment was missing. The `/server-info` player-data-sensitivity item below is
> Lua-side and out of this reconciliation's reach the same way it was out of the original hunt's
> — no verdict possible without the Lua mod source.

**Dead checks fixed directly, per your instruction ("fix those while you are there"):** `servers.js:254` (`/auto-scan`), `servers.js:368` (`/detect`), `panelBridge.js:2670` (`/install-mod`) — all the same `isAbsolute(resolve(x))` shape Creed already named. Grepped the whole file for every remaining `isAbsolute` occurrence first to confirm these were the only three left (the other two hits, lines 228/800, are Creed's already-correct raw-input checks). Checked for existing tests first — none of the three had any (confirms Creed's read: "invisible to tests and review"). Fixed by moving the `isAbsolute` check to run on the raw input before `path.resolve()`, added `server/tests/deadIsAbsoluteChecksFix.test.js` (3 tests, one per site) proving each now genuinely refuses a relative path. Both gates green, committed as `0cacaa8`.

**Stale comment, NOT fixed — reporting per "anything larger, I route it," and this is a judgment call about intent, not a one-liner:** `panelBridge.js:1104-1109`, above `POST /command` (the generic passthrough for every PanelBridge action — teleport, giveItem, character import/export, horde spawning): *"Every account is currently created as 'admin' (see auth.js), so this has no effect today, but keeps the route safe if a lower-privilege role is ever introduced."* That premise was true when written but isn't anymore — tonight's entire session has been building exactly the lower-privilege-role reality this comment treats as hypothetical (technician/moderator have existed for a while; custom roles via the matrix are brand new). The GATE itself (`requirePermission("bridge.command")`) is correct and unaffected — this is a documentation-staleness issue, not a functional bug, but it undersells the gate's current importance to a future reader ("has no effect today" now reads as false reassurance for code that matters more than ever). Not touching it myself: rewording it correctly means asserting what's now true across the app, which is more than a one-line mechanical fix — your call whether it's worth a pass, possibly alongside Jim's look at the debug.js header comment from earlier tonight (same shape: a comment overtaken by the app's own evolution).

**Flagged as genuinely uncertain, not claimed as a finding:** `GET /server-info` (line 1308, ungated) includes `result.data.players` per its own comment, while `GET /players` (line 1782, gated on `players.gm_tools`) returns a richer `getAllPlayerDetails()`. Both are thin wrappers over `sendCommand()` to the Lua mod side — I could not determine from the JS codebase alone whether `getServerInfo`'s player list is a lightweight roster (name/count — comparable to what any server browser shows) or something closer to `getAllPlayerDetails`'s sensitivity (position, health, inventory), since the actual field shape is decided by the Lua mod handler, which isn't in this repo's `server/` tree. Saying so rather than guessing either way — if you know the Lua side (or can point me at it), I can close this out properly instead of leaving it open.

---

## Rest of panelBridge.js checked

**READ:** the full route map (86 routes) and every route's gate — `requirePermission` covers all but 4 (`/status`, `/ping`, `/server-info`, `/commands`), each checked individually above. Grepped the whole file for `success:\s*true` literals (19 hits) and spot-checked the lifecycle ones (`/start`, `/stop`) against their service methods — `bridge.start()` is synchronous, local `setInterval` scheduling with no async network step, and throws (not a silent `false`) on the one real failure case (`!this.bridgePath`) — genuinely different shape from `discordBot.start()`'s async-login-can-silently-fail case in Finding 1, not the same bug recurring. `GET /status` and the SFTP transport's own `getStatus()` (`services/panelBridgeSftp.js:393`) were checked field-by-field for a credential leak the way `rcon.js`'s `getConfig()` was — neither returns a password/key, only connection metadata (paths, timestamps, latency, diagnostics counters). Did not read all ~60 near-identical `server.world_events`/`players.gm_tools`-gated command routes (weather/climate/zombies/sound/visual/chat) line by line given the volume — every one follows the identical `if (!bridge.isRunning) return 400` → validate → `bridge.<action>()` → `res.json(result)` shape in the ones sampled, with `requirePermission` already confirmed present on every one via the route map grep.

---

## Rest of serverFinder.js checked clean

**READ:** full file, 627 lines. Router-level gate (`requirePermission('server.install')`, all 4 routes) — no pattern-4 gap. `GET /` queries the Steam Web API / Steam master server list, not caller-supplied addresses, so it isn't part of the SSRF surface above. `GET /debug` is the same shape, gated the same way, no new pattern. Everything reports errors as errors (no success-regardless-of-outcome instances beyond `/ping` deliberately treating an unreachable server as a legitimate `{success:true, online:false}` result, which is honest — "ping" against an offline server isn't a panel failure).

---

## RECONCILIATION SUMMARY (2026-08-24, fork)

All 6 findings in this file verified against current source: **6 FIXED, 0 LIVE, 0 INVALID.**
Commits: `4e2f0c5`, `494de7a`, `9305865`, `913fc3a`, `7ff8763`, plus `0cacaa8`/`24f2338` (Finding
6's two parts). One "checked clean" verdict corrected — templates.js's `DEFAULT_INI_EXCLUSIONS`
enforcement is NOT clean; see the correction note above that section and
`docs/qa/creed-findings.md` Finding 7 for the confirmed-live bypass found later the same night.

## Coverage summary

All 9 files in scope read: `scheduler.js`, `rcon.js`, `discord.js`, `serverFiles.js`, `discovery.js`, `templates.js`, `serverFinder.js`, `panelBridge.js` (route map + gate check on all 86 routes, full read on the 4 ungated ones and the lifecycle/status ones; the ~60 near-identical world-events/player command routes were sampled, not individually read line by line), and the remainder of `servers.js` not covered by Creed's Finding 1.

**6 findings.** 1 fixed directly (Finding 6's dead checks — the one-liners this brief authorized fixing on sight). 5 reported, not fixed: Finding 2 (data-destroying, sent immediately/separately as instructed), Findings 1/3/4/5 (batched, lower severity), plus one stale comment (Finding 6) and one genuinely-uncertain item (`/server-info`'s player-data sensitivity, Lua-side, out of this repo's reach) flagged rather than guessed either way.

**Two things worth naming that aren't findings but are worth remembering:** (1) `templateService.js`'s `writeFilesTransaction()` and `DEFAULT_INI_EXCLUSIONS` enforcement are the "restore path is genuinely solid" of this hunt — a harder problem than most of what's in scope, done correctly, sitting right next to two files (serverFiles.js, servers.js) that got adjacent problems wrong. (2) Every credential-adjacent "is this actually safe to leave ungated" question in this hunt (rcon.js's `/status`, discord.js's `/config`, servers.js's `/:id`, panelBridge.js's `/status`) turned out to hold up under direct verification — the codebase's instinct for what's safe to leave open is good; the bugs found were all elsewhere (backup safety nets, result-checking, one SSRF range, one dead check pattern repeating).
