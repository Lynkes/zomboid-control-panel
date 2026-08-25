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

1. **HIGH** — `getPlayerTraits()` (~line 3112) tries `desc:getTraitList()`, `desc:getTraits()`, `player:getTraits()` in sequence. None exist anywhere in the real B42 hierarchy. The real method is `getCharacterTraits()` on `IsoGameCharacter` (returns `zombie.characters.traits.CharacterTraits`), never attempted. Every player-trait lookup returns empty on B42, always.

   > **RECONCILED 2026-08-24 (fork):** FIXED at `9991b34` ("getPlayerTraits actually reaches B42's
   > real trait list"). Current `PanelBridge.lua:3180-3214` calls `getCharacterTraits()` first, exactly
   > the method this finding named, with a comment explicitly tracing why the three old attempts never
   > existed. Changelog (line 336) confirms: "Fixed B42 compatibility for getPlayerTraits."

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

4. **LOW** — `item:getDelta()` (inventory serialization, ~3063) doesn't exist — real methods are `getJobDelta`/`getUseDelta`. `data.delta` is always nil in serialized item data.

   > **RECONCILED 2026-08-24 (fork):** FIXED. Current `PanelBridge.lua:3119-3131` sets
   > `data.jobDelta`/`data.useDelta` via the two real methods this finding named, with a comment
   > explicitly citing the jar-confirmed absence of `getDelta()`. The old `data.delta = tryGet(item,
   > "getDelta")` line is still present alongside (harmless — `tryGet` degrades to nil, and the real
   > fields now carry the actual data), so nothing consuming `data.delta` specifically is fixed by
   > this, but the finding's actual claim ("no real delta data is ever serialized") no longer holds.

Dead-but-harmless (confirmed nonexistent, but a working primary/earlier attempt already covers the feature — no live functional loss): `setGodMode` (comment literally says "not a typo," `setGodMod` already works), `setLx`/`setLy`/`setLz` (redundant after working `teleportTo`+`setX/Y/Z`), `sm.getAllVehicles` (fallback after working `getAllVehicleScripts`), vehicle/cell `removeVehicle` (fallback after working `permanentlyRemove`/`removeFromWorld`), `setRemainingFuelPercentage`/`setBatteryCharge` (explicit "B41 fallback" comments, real B42 primary paths confirmed working), `transmitVehicle`/`updateFlags` (extra sync attempts after working `transmitEngine`).

---

## Pass 3 — can the jar settle which RCON responses are informative vs. bare acks?

Follow-up to Pass 1's `execute()` fix: I'd declined to build a keyword-based "drift detector" for unrecognized RCON responses because there was no way to statically tell "novel rejection we haven't catalogued" apart from "novel-but-legitimate informative success text" (players list, showoptions dump, etc.) without either a forbidden success-allowlist or an unproven heuristic. Asked to check whether the jar could answer that properly instead of by guesswork.

Built `scripts/jar-audit/classify-response-shapes.mjs`: flags a command class as likely informative if its constant pool references `java.util.Iterator`/`List`/`Map` enumeration methods (`hasNext`/`next`/`entrySet`/etc.) — the theory being a tiny, single-purpose command class referencing collection-iteration is very likely looping over data to build its reply.

**Result: confirms what was already known, does not extend it, and demonstrates its own unreliability on the one new case it flagged.** Ran against all ~44 commands. Loop-evidence fired for exactly 4: `players`, `showoptions`, `stats` (all three already manually confirmed informative tonight) and `reloadlua` (new). Manually inspected `reloadlua`'s bytecode-call evidence: its only two methods are `<init>` and `Command()`, and the loop pairs `ArrayList.iterator()`/`hasNext()`/`next()` with `ArrayList.remove(Object)` — the classic "find and remove a matching entry from a list" idiom, i.e. plausible internal script-list housekeeping, not reply-building. A single manually-checked false positive on the ONE new flag this pass produced is reason enough not to trust the signal at scale without hand-verifying every hit, which defeats the purpose of an automated catalogue.

The remaining 40 commands all showed "no loop evidence, double-digit incidental string constants" — not discriminating at all, since every class carries that many strings from logging and exception-handling regardless of whether its actual RCON reply is empty or not.

**Verdict, closing the question rather than leaving it open**: still no, and now for a demonstrated reason rather than an assumption. Constant-pool-level analysis (annotations, method names, cross-references) can reliably answer *what a command is called and what arguments it takes* — that's a real, provable question the jar settles cleanly (Pass 1). It cannot reliably answer *what a command's reply actually contains* without decoding the method's bytecode instructions — tracing which local variable an `areturn` actually returns, through `invokedynamic` string-concatenation and loop bodies. That is a full bytecode control-flow reader, a materially bigger build than annotation/constant-pool reading, and this pass does not attempt it. `classify-response-shapes.mjs` is committed anyway, with this limitation written directly into its own header comment, because a 3-command confirmation plus one clearly-explained false positive is still real, useful, honestly-bounded information — just not a catalogue.
