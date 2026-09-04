# Kevin — B42 jar audits (RCON commands, PanelBridge Lua calls, response-shape classifier)

Three passes against the real B42 dedicated server jar (`D:/Zomboid_dev_panel/ServerB42Files/java/projectzomboid.jar` in this floor's environment — path varies by machine, see `scripts/jar-audit/README.md`), read-only both sides throughout. The operator's ask: verify what this panel sends against ground truth instead of the wiki (lags patches) or our own comments (already wrong twice the same night). Tooling built along the way is committed at `scripts/jar-audit/` — this doc is the worked example the README points readers at.

---

## Pass 1 — every RCON command `server/services/rcon.js` sends

Technique: `zombie/commands/serverCommands/*.class` carries `@CommandName`/`@CommandArgs`/`@AltCommandArgs`/`@DisabledCommand`/`@RequiredCapability` as real bytecode annotations — no decompiler needed, just a structural class-file parser (`scripts/jar-audit/classfile-parser.mjs`) reading the constant pool and annotation attributes directly. Checked all ~44 commands this panel sends against all ~68 real command classes in the jar.

> **RECONCILED 2026-08-24 (fork):** FIXED, all three, confirmed against current `server/services/rcon.js`
> rather than trusting the doc's own "fixed same night" claim. `kickPlayer()` (line 1265-1271) sends
> `-r "<reason>"` when a reason is given. `releaseSafehouse()` (line 1611) and the broadened
> `execute()` failure-detection denylist (lines 101-128, including the exact "can be executed only
> from the game" / "Wrong arguments!" / "Not enough rights" patterns this doc names) are both live.
> `setGodMode`/`setInvisible` (lines 1463-1482) send `godmodplayer`/`invisibleplayer` with a username
> when targeting another player. All four commits (`f5f334a`, `effab99`, `fcc61a9`, `4e7933b`) exist
> in history and their diffs match what's live today.

**status: FIXED (all 3)** — re-verified 2026-09-02, HEAD `5f913567`; all 4 cited commits confirmed still ancestors of HEAD.

**3 confirmed defects, fixed same night** (commits `f5f334a`, `effab99`, `fcc61a9`, `4e7933b` in this repo):

1. `kickPlayer()`'s `reason` argument was accepted and logged by `server/routes/players.js` but never sent — the code's own comment claimed `kickuser` has "no reason flag supported." `KickUserCommand.class`'s real `@AltCommandArgs` declares a `-r` argName, the same shape `BanUserCommand`'s already correctly-used `-r` flag has. Comment was simply wrong.
2. `releaseSafehouse()` sent `releasesafehouse` over RCON unconditionally. `ReleaseSafehouseCommand.class` calls `isCommandComeFromServerConsole()` and refuses with "...can be executed only from the game" for ANY console/RCON caller — this command can never succeed over RCON, full stop. `execute()`'s failure detection (`/^Unknown command/i` only) didn't recognize that rejection text, so every call silently reported success while doing nothing.
3. `setGodMode()`/`setInvisible()` always sent the self-only command (`godmod`/`invisible`, capability `...Himself`, no username argument declared) even when targeting a specific player — B42 has separate `godmodplayer`/`invisibleplayer` commands (capability `...Everyone`, required username) for that. The panel's own code already half-knew this via a warning string in `players.js`.

Also broadened `execute()`'s failure detection with 3 more VERBATIM-confirmed rejection texts ("Wrong arguments!" — `GodModePlayerCommand`/`InvisiblePlayerCommand`; "Not enough rights" — `NoClipCommand`; "...can be executed only from the game" — `ReleaseSafehouseCommand`) as a denylist, deliberately not inverted to a success allowlist (can't enumerate ~44 real success shapes from bytecode with confidence).

**Checked and confirmed fine** (majority of the ~44): `save`, `quit`, `servermsg`, `players`, `banuser` (`-ip`/`-r` both real), `unbanuser`, `setaccesslevel`, `adduser` (the real, non-disabled whitelist-add path — `AddUserToWhiteListCommand` carries `@DisabledCommand`, `AddUserCommand` doesn't), `removeuserfromwhitelist`, `teleportto`, `additem`, `addxp`, `addvehicle` (both variants), `stoprain`, `stopweather`, `chopper`, `gunshot`, `lightning`, `thunder`, `createhorde`, `noclip`, `showoptions`, `reloadoptions`, `changeoption`, `banid`, `unbanid`, `voiceban`, `alarm`, `reloadlua`, `stats`, `removezombies`, `addAllToWhitelist()`'s own refusal (`AddAllToWhiteListCommand` genuinely carries `@DisabledCommand` — the code is right to refuse, not a bug).

**Lower-confidence, flagged not asserted, needs a live B42 server this floor doesn't have**: fractional `startrain`/`startstorm` intensity vs. the real arg regex being digit-only; `addSteamID`/`removeSteamID` sent in mixed case vs. the real lowercase name (case-sensitivity of PZ's dispatch unconfirmed); `checkModsNeedUpdate`'s literal command-name string never appeared in its own annotation bytecode window, unlike every other command checked; `log(type, level)`'s real annotation shows one `required=(.+)` group where the code sends two separately-quoted args.

---

## Pass 2 — every Java API call PanelBridge.lua makes into the game

Angela established PanelBridge.lua has zero automated coverage — the jar is the only oracle this layer has. Harder than Pass 1: no annotations on arbitrary Lua-callable API surface, so this needed the class parser's `methods`/`superClass`/`interfaces` fields directly, walked by hand per call site.

Nearly every Java call in `pz-mod/PanelBridge/media/lua/server/PanelBridge.lua` funnels through 5 wrapper functions — `PanelBridge.invoke/tryGet/safeGet/safeCall/hasMethod(obj, "methodName", ...)` — so every method name is a literal string, extractable by regex against those 5 names specifically rather than parsing arbitrary Lua syntax. 147 distinct (receiver-variable, method-name) pairs across ~29 receiver kinds, each receiver resolved to its real Java class by reading the Lua variable's own assignment site.

**Honesty checkpoint, the important part**: first pass checking one class per receiver came back 47/147 "not found" — a headline that would read as "a third of the bridge is broken," and it was wrong. Root cause nearly every time: checking only one link in the inheritance/interface chain.

- `SandboxOption` is an *interface* (metadata: name/tooltip/page) implemented by 5 concrete option classes, each of which ALSO extends a same-named `zombie.config.*ConfigOption` class (value/min/max/default) — the runtime object needs both halves checked, not either alone.
- `player` receivers needed walking `IsoPlayer → IsoGameCharacter → IsoMovingObject → IsoObject → GameEntity → Object` — `setX`/`setY`/`setZ`/`sendObjectChange` all live several levels up from `IsoPlayer` itself.

After walking full chains: 47 false-not-founds became 14 genuine gaps, 4 of which turned out to be real defects and 6 dead-but-harmless (already-acknowledged fallback attempts after a working primary path), plus 4 correctly left `UNRESOLVED` (a square's content object is one of many `IsoObject` subclasses knowable only at runtime — the code's own defensive `invoke()` wrapping already acknowledges this; a guess here would have been indistinguishable from the confirmed findings in the same list, so none was made).

**4 findings, reported to Angela (owns the Lua, not fixed by me)**:

**status: FIXED** (item 1, re-verified 2026-09-02, HEAD `5f913567`, commit `9991b34` confirmed still an ancestor of HEAD)

1. **HIGH** — `getPlayerTraits()` (~line 3112) tries `desc:getTraitList()`, `desc:getTraits()`, `player:getTraits()` in sequence. None exist anywhere in the real B42 hierarchy. The real method is `getCharacterTraits()` on `IsoGameCharacter` (returns `zombie.characters.traits.CharacterTraits`), never attempted. Every player-trait lookup returns empty on B42, always.

   > **RECONCILED 2026-08-24 (fork):** FIXED at `9991b34` ("getPlayerTraits actually reaches B42's
   > real trait list"). Current `PanelBridge.lua:3180-3214` calls `getCharacterTraits()` first, exactly
   > the method this finding named, with a comment explicitly tracing why the three old attempts never
   > existed. Changelog (line 336) confirms: "Fixed B42 compatibility for getPlayerTraits."

**status: PARTIALLY FIXED** (item 2, re-verified 2026-09-02, HEAD `5f913567` — see the RECONCILED note below for the exact split: the named symptom is fixed, a sibling dead-fallback call is not)

2. **MEDIUM** — `opt:getIntValue()`/`targetOpt:getIntValue()` (`getAllSandboxOptions`, ~3627/3705) doesn't exist anywhere in the `SandboxOption`/`ConfigOption` hierarchy. Mostly harmless as a fallback (`getValue()` already works), but it's the *sole* mechanism for `info.selectedIndex` on enum-type options — always nil for every enum sandbox option this handler returns.

   > **RECONCILED 2026-08-24 (fork):** PARTIALLY FIXED. The specific symptom named — `info.selectedIndex`
   > always nil for enum options — is fixed: current `PanelBridge.lua:3870-3880` now calls plain
   > `getValue()` for the selected index, with a comment tracing the real hierarchy
   > (`EnumSandboxOption → EnumConfigOption → IntegerConfigOption`, and `IntegerConfigOption` is what
   > actually declares `getValue() -> int`). But the sibling call this finding also named,
   > `getOptionValue()`'s own `getIntValue()` fallback (now at line 3793, used for the general
   > `info.value` field, a different purpose than `selectedIndex`), is still present and still dead —
   > harmless today only because it's a fallback that never fires (`getValue()` already succeeds first
   > for every case observed), not because it was removed or fixed. Worth a one-line cleanup, not a
   > live functional bug.

**status: RESOLVED DIFFERENTLY THAN THE NAIVE FIX (not a live bug, not a clean FIXED either)** (item 3, re-verified 2026-09-02, HEAD `5f913567` — see the RECONCILED note below)

3. **MEDIUM** — `setNetworkTeleportEnabled` (`teleportPlayer`, ~3496/3525) confirmed absent across the entire `IsoPlayer` chain to `Object`. `teleportTo`+`setX`/`Y`/`Z` (both confirmed real) still physically move the player, but the anti-cheat "authorized teleport" flag and network broadcast step this specifically existed for never fires.

   > **RECONCILED 2026-08-24 (fork):** PARTIALLY FIXED / RESOLVED DIFFERENTLY THAN THE NAIVE FIX WOULD
   > BE. Commit `613702b` re-confirmed (jar-grepped again, zero hits for "NetworkTeleport" across every
   > .class file) that `setNetworkTeleportEnabled` is genuinely absent from B42 and has "no known direct
   > replacement" — the dead calls (`PanelBridge.lua:3611`, `:3641`) are deliberately LEFT IN as
   > harmless no-ops rather than removed, per the current comment, "in case a future PZ build re-adds
   > it." The actual symptom this finding cared about — the network-broadcast step never firing — is
   > separately addressed: Step 4 (line ~3645) now uses `sendPlayerExtraInfo`, described in the current
   > comment as "the one broadcast mechanism here actually confirmed to exist," so the position sync
   > this finding was worried about does have a real, working mechanism today. What remains explicitly
   > UNRESOLVED (the code's own comment says so, not my inference): whether an "authorized teleport"
   > anti-cheat flag equivalent exists at all in B42, or whether that responsibility moved inside
   > `teleportTo` itself. Not a live bug in the sense of "still broken as described," but not a clean
   > FIXED either — the honest verdict is that the code now matches its own (accurate) comments about
   > what is and isn't known.

**status: FIXED** (item 4, re-verified 2026-09-02, HEAD `5f913567`)

4. **LOW** — `item:getDelta()` (inventory serialization, ~3063) doesn't exist — real methods are `getJobDelta`/`getUseDelta`. `data.delta` is always nil in serialized item data.

   > **RECONCILED 2026-08-24 (fork):** FIXED. Current `PanelBridge.lua:3119-3131` sets
   > `data.jobDelta`/`data.useDelta` via the two real methods this finding named, with a comment
   > explicitly citing the jar-confirmed absence of `getDelta()`. The old `data.delta = tryGet(item,
   > "getDelta")` line is still present alongside (harmless — `tryGet` degrades to nil, and the real
   > fields now carry the actual data), so nothing consuming `data.delta` specifically is fixed by
   > this, but the finding's actual claim ("no real delta data is ever serialized") no longer holds.

Dead-but-harmless (confirmed nonexistent, but a working primary/earlier attempt already covers the feature — no live functional loss): `setGodMode` (comment literally says "not a typo," `setGodMod` already works), `setLx`/`setLy`/`setLz` (redundant after working `teleportTo`+`setX/Y/Z`), `sm.getAllVehicles` (fallback after working `getAllVehicleScripts`), vehicle/cell `removeVehicle` (fallback after working `permanentlyRemove`/`removeFromWorld`), `setRemainingFuelPercentage`/`setBatteryCharge` (explicit "B41 fallback" comments, real B42 primary paths confirmed working), `transmitVehicle`/`updateFlags` (extra sync attempts after working `transmitEngine`).

---

**status: NOT APPLICABLE — methodology conclusion, not a defect finding.** No fix verdict needed.

## Pass 3 — can the jar settle which RCON responses are informative vs. bare acks?

Follow-up to Pass 1's `execute()` fix: I'd declined to build a keyword-based "drift detector" for unrecognized RCON responses because there was no way to statically tell "novel rejection we haven't catalogued" apart from "novel-but-legitimate informative success text" (players list, showoptions dump, etc.) without either a forbidden success-allowlist or an unproven heuristic. Asked to check whether the jar could answer that properly instead of by guesswork.

Built `scripts/jar-audit/classify-response-shapes.mjs`: flags a command class as likely informative if its constant pool references `java.util.Iterator`/`List`/`Map` enumeration methods (`hasNext`/`next`/`entrySet`/etc.) — the theory being a tiny, single-purpose command class referencing collection-iteration is very likely looping over data to build its reply.

**Result: confirms what was already known, does not extend it, and demonstrates its own unreliability on the one new case it flagged.** Ran against all ~44 commands. Loop-evidence fired for exactly 4: `players`, `showoptions`, `stats` (all three already manually confirmed informative tonight) and `reloadlua` (new). Manually inspected `reloadlua`'s bytecode-call evidence: its only two methods are `<init>` and `Command()`, and the loop pairs `ArrayList.iterator()`/`hasNext()`/`next()` with `ArrayList.remove(Object)` — the classic "find and remove a matching entry from a list" idiom, i.e. plausible internal script-list housekeeping, not reply-building. A single manually-checked false positive on the ONE new flag this pass produced is reason enough not to trust the signal at scale without hand-verifying every hit, which defeats the purpose of an automated catalogue.

The remaining 40 commands all showed "no loop evidence, double-digit incidental string constants" — not discriminating at all, since every class carries that many strings from logging and exception-handling regardless of whether its actual RCON reply is empty or not.

**Verdict, closing the question rather than leaving it open**: still no, and now for a demonstrated reason rather than an assumption. Constant-pool-level analysis (annotations, method names, cross-references) can reliably answer *what a command is called and what arguments it takes* — that's a real, provable question the jar settles cleanly (Pass 1). It cannot reliably answer *what a command's reply actually contains* without decoding the method's bytecode instructions — tracing which local variable an `areturn` actually returns, through `invokedynamic` string-concatenation and loop bodies. That is a full bytecode control-flow reader, a materially bigger build than annotation/constant-pool reading, and this pass does not attempt it. `classify-response-shapes.mjs` is committed anyway, with this limitation written directly into its own header comment, because a 3-command confirmation plus one clearly-explained false positive is still real, useful, honestly-bounded information — just not a catalogue.

---

## Pass 4 — the jar-audit access, lost and recovered, and the ban/whitelist rejection-string gap (hunt-wave11, 2026-08-29)

**Provenance for this pass, stated up front per the operator's own bar ("a finding from a jar of unknown build is a finding with an invisible expiry date")**: `D:/SteamLibrary/steamapps/common/ProjectZomboid/projectzomboid.jar` (this machine's real Steam-installed copy, which also ships `ProjectZomboidServer.bat` alongside the client — same jar serves both), confirmed via `appmanifest_108600.acf` sitting next to it: **Steam buildid `24909800`**, same exact build the 2026-08-27 RCON-rejection fixture (`server/__fixtures__/pzRconRejectionStrings.json`) was already extracted from — this pass extends that SAME fixture rather than starting a second one at a different build. A human-readable "42.x.y" version string could not be found via a bounded search (jar `META-INF/MANIFEST.MF` has no version field; no `version.txt`/similar in the install directory; no class path containing "version" under `zombie/`) — the file itself is dated 2026-08-26. Per the operator's instruction, stamping with the buildid (precise, Steam-verified) and file date since a human label wasn't findable within a reasonable search.

**Access-recovery note, since the access itself was reported lost earlier tonight**: the original hardcoded example path in `scripts/jar-audit/README.md` (`D:/Zomboid_dev_panel/ServerB42Files/java/projectzomboid.jar`) is genuinely gone from this machine. What actually unblocked this pass was checking the extraction script's own DEFAULT fallback path (`D:/SteamLibrary/steamapps/common/ProjectZomboid/projectzomboid.jar`, `scripts/jar-audit/extract-rcon-rejection-strings.mjs`'s `process.argv[2] ||` fallback) — it was there all along, newer than either of the two paths reported earlier tonight, and required zero backup-directory archaeology. Worth remembering: when a tool has a hardcoded default/fallback, check whether the default itself still resolves before treating a documented example path's absence as "access is gone."

**status: FIXED** (re-verified 2026-09-02, HEAD `5f913567` — this Pass-4 material is dated 2026-08-29, AFTER the 2026-08-24 reconciliation sweep, so it had never been checked before this pass). Read `server/services/rcon.js`'s `KNOWN_RCON_REJECTIONS` array directly: all of the HIGH-confidence literals named below are present — both Steam-Relay ban-IP patterns, and `"A user with this name already exists"` — and both MEDIUM-confidence literals are also present: the distinct `"...is not in the whitelist, use /adduser first"` pattern (kept separate from the pre-existing longer variant, as recommended) and `"User {name} not found"`, plus `"You don't have capability to ban/unban users."` as a backstop pattern. All of Priority 1's recommended additions were applied.

### Priority 1 — banuser / unbanuser / adduser / removeuserfromwhitelist rejection text

Confirmed the operator's premise precisely: none of `BanUserCommand`, `UnbanUserCommand`, `AddUserCommand`, `RemoveUserFromWhiteList` carry any rejection-text literal of their own — each just returns whatever String `zombie.network.BanSystem`'s or `zombie.network.ServerWorldDatabase`'s own methods hand back (`BanSystem.BanUser`/`BanUserByIP`/`BanUserBySteamID`/`BanIP`; `ServerWorldDatabase.banUser`/`addUser`/`removeUser`). Traced this via each command class's own `Methodref` constant-pool entries (which class/method it calls out to), not guessed. Both classes are now added to the extraction script's scope and the committed fixture permanently (72 classes, up from 69 — `server/tests/rconRejectionGroundTruth.test.js`'s `EXPECTED_CLASS_COUNT` updated with a comment explaining the deliberate widening, not a silent bump).

**Confidence tiers below matter — this is constant-pool string presence, not bytecode-traced return values (the same limitation Pass 3 already named). A literal being IN a class is not proof of which exact call site returns it; where the attribution is solid (a class with only one relevant caller, or a self-evidently-scoped literal like a Steam-Relay-specific ban message), it's called out as such.**

**HIGH confidence — clean literal, narrow/obvious attribution:**
- `BanSystem.class`: **`"This user can't be banned."`** (paired with the constant `CantBeBannedByUser`, the exact same shape as `KickUserCommand`'s already-recognized `CantBeKickedByUser` → "This user can't be kicked." pair) — target holds a ban-immune capability. Applies to `banuser`.
- `BanSystem.class`, `BanUserByIP` specifically (the `-ip` flag path): **`"Cannot ban IP {ip} (Steam Relay shared address). Use bansteamid or banuser instead."`** and **`"Cannot ban IP for player '{name}' (Steam Relay, real IP unavailable). Use bansteamid or banuser without -ip."`** — two distinct, fully-formed, mostly-literal rejections for attempting an IP ban against a Steam Relay connection (no real IP available to ban). Both are new — nothing in `KNOWN_RCON_REJECTIONS` today would catch either.
- `ServerWorldDatabase.class`, `addUser` path: **`"A user with this name already exists"`** — a clean, unambiguous literal for `adduser` against a username that's already whitelisted. New; not covered today.

**MEDIUM confidence — real literal in the right class, attribution to one specific command inferred from context rather than bytecode-traced:**
- `ServerWorldDatabase.class`: **`"User \"{name}\" is not in the whitelist, use /adduser first"`** — note this is a DIFFERENT, shorter string than the one already in `KNOWN_RCON_REJECTIONS` (`"...is not in the whitelist nor the server, use /adduser first"`, confirmed still present verbatim in `GameServer.class`, used by `setaccesslevel`). Two distinct literals, two distinct sources — this one is ServerWorldDatabase's own, most plausibly returned by `banUser`/`removeUser` when the target isn't whitelisted at all. Worth a pattern of its own, not folded into the existing one (the wording differs enough that the existing regex will not match it).
- `ServerWorldDatabase.class`: **`"User {name} not found"`** — distinct from both existing patterns (`"...doesn't exist."` requires a trailing period and different wording; `"No such user"` is a completely different literal). A genuinely new rejection shape.
- `BanSystem.class`: **`"You don't have capability to ban/unban users."`** — appears to be a second, redundant capability check inside `BanUser` itself, on top of whatever the RCON `@RequiredCapability` annotation already gates — worth having as a backstop pattern even if it's not expected to normally fire.

**LOW confidence / not attributed with enough confidence to hand off as-is:** `"Connection not found"`, `"Player not found"` — bare literals in `BanSystem.class`, plausible RCON-reply shape but could equally be internal-console-only text; not asserted as real findings, just noted as present.

**For completeness, the SUCCESS shape (not a rejection, but useful context for whoever integrates this)**: ban/unban's success reply appears to be built from `"User {name} is now {status}"` (bootstrap template) with `" banned"`/`" unbanned"` as the interpolated status — i.e. `"User X is now banned"` / `"User X is now unbanned"`. `adduser`'s success shape looks like `"User {name} created with password"` / `"...created without password"`. `removeuserfromwhitelist`'s success shape looks like `"User {name} removed from white list"`. None of these should ever match a rejection pattern, but naming them here means whoever writes the new `KNOWN_RCON_REJECTIONS` entries can sanity-check a new pattern against them directly instead of re-deriving the success shapes from scratch.

**Not applied to `server/services/rcon.js`** — Pam owns that file and the `KNOWN_RCON_REJECTIONS` anchoring convention; these are handed off as raw findings for her/the operator to sequence, per this pass's explicit instruction.

**status: CANNOT TELL (structural limit of the technique, not an open action item)** — this Priority explicitly could not be settled by static jar analysis (runtime/content data, not fixed engine structure); the original write-up already names this as the honest stopping point, not a pending fix. Nothing to re-verify against code — no claim was made that current code needs to change.

### Priority 2 — do real PZ saves ever contain negative-numbered map/X/Y.bin chunks?

**Genuinely could not be settled by static analysis, and for the same structural reason the operator already ruled out boot-vs-live settings and the storm mechanism tonight: it's runtime/content data, not fixed engine structure.** Traced `zombie.iso.IsoChunk`'s own disk I/O (`Save`/`SafeWrite`/`SafeRead`/`LoadFromDisk`) far enough to find its filename-building bootstrap templates (`"\u0001.bin"`, `"\u0001\u0001\u0001.bin"`, `"\u0001\u0001\u0001\u0001\u0001.bin"` — string-concatenation of `Integer`-typed coordinate values into a filename) — these use ordinary signed-integer `String` formatting with **no offset, clamp, or `Math.abs()`-style normalization found anywhere in the chain**. Followed the actual coordinate-RANGE question one level further, to `zombie.worldMap.MapDefinitions` (the class that registers every installed map's playable coordinate bounds): its own constant pool is essentially empty of literals — bounds come from `initDefinitionsFromLua()`, i.e. each map (vanilla or modded) declares its own coordinate range via Lua data at load time, not a fixed Java constant this jar bakes in.

**Net**: the engine's own chunk-file-naming code has nothing in it that would prevent a negative coordinate from being written as a real, valid filename (e.g. `-5.bin`) if a map's Lua-declared bounds ever produced one — this doesn't contradict my earlier finding (the panel's own `\d+`-only regexes would silently exclude such a file). But whether any REAL installed map (vanilla or the specific modded maps this operator runs) actually HAS negative-coordinate chunks is fixed at map-generation time by that Lua data, which this static jar read cannot see — same class of unresolvable-by-jar-alone question as the storm mechanism and boot-vs-live settings, for the identical reason (runtime/content configuration, not compiled structure). Reporting this as the honest limit reached, not pushing further per the operator's own "if not, say so and stop" instruction for exactly this kind of open-ended question.

**status: FIXED** (re-verified 2026-09-02, HEAD `5f913567`). `server/utils/commands.js`'s `ACCESS_LEVELS` no longer contains `"overseer"` and now contains `"priority"` — fixed by commits `9f2bc9f1`/`5d174d32` ("fix(players): drop dead 'overseer' access level, add missing 'priority', cite jar evidence not a wiki"), both confirmed ancestors of HEAD. A dedicated drift-gate test now exists and pins the exact list: `server/tests/accessLevelsListParity.test.js` asserts `ACCESS_LEVELS` equals `["admin", "moderator", "gm", "observer", "priority", "user", "none"]` and explicitly asserts `.not.toContain("overseer")` / `.toContain("priority")`, citing this exact finding ("hunt-wave13-2026-08-30") in its own header comment.

### Priority 3 — does setaccesslevel's real accepted set match commands.js's ACCESS_LEVELS?

Cheap check, stopped once it stopped being cheap. `SetAccessLevelCommand.class` special-cases only the literal `"none"` directly (a plain `String.equals` check) — everything else is delegated to `GameServer.changeRole(...)`, which resolves the typed argument against `Roles.getRoles()` (the server's live, DB-backed role list — see `ServerWorldDatabase.class`'s own `CREATE TABLE [role] (...)` schema found in Pass 1's extraction). **This means the true accepted set is a per-server RUNTIME property (admins can rename/add/remove roles via that table), not a fixed list the jar alone can enumerate** — the same "runtime, not static" shape as Priority 2, found independently.

What the jar CAN settle: `zombie.characters.Roles` (the class that seeds the game's OWN built-in default roles via `setupRole(name, ...)` calls in `init()`) uses these literal name strings: **`banned`, `user`, `priority`, `observer`, `gm`, `moderator`, `admin`** — seven built-in defaults. `commands.js`'s `ACCESS_LEVELS` has `admin, moderator, overseer, gm, observer, user, none` (its own comment cites "official PZ Admin Commands wiki, Build 42.17.0"). Comparing: **`"overseer"` does not appear as a literal string anywhere in `Roles.class`, nor anywhere across the full 72-class fixture** (grepped both explicitly). `"priority"` is a real built-in default role name in the CURRENT build (24909800) that does NOT appear in `commands.js`'s list at all.

**Calibrated, not overclaimed**: `Roles.class` still DECLARES a method named `getDefaultForOverseer()` — the concept hasn't been fully removed from the API surface — but I could not find the literal string that would be its role's actual configurable `name` field anywhere this scan covers. This could mean the build 42.17.0 wiki's "overseer" was renamed to something this jar resolves by POSITION rather than a matching literal (plausible, since B42's role/permission system visibly changed shape across its build cycle — the `priority` role plus the `position`/DB-backed role table are both new-shaped concepts relative to a simple fixed enum), or it could mean something this static read genuinely can't see. **Not asserting "overseer is dead" as a confirmed fact — asserting "no literal evidence for it was found despite a real, bounded search, while a literal FOR `priority` was found and `commands.js` doesn't have it."** Stopping here per the explicit "do not turn this into a campaign" instruction — a live B42 server test (typing `setaccesslevel <user> overseer` and `setaccesslevel <user> priority` against a real running instance) is what would actually resolve this, and this floor doesn't have one tonight.
