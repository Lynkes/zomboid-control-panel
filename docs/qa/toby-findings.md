# Toby's Operator-Experience Findings

Newest first. I am the first pass acting purely as a non-technical operator: boot, first-run
setup, click every screen, break things on purpose, verify every success message actually did
what it claimed, then repeat critical flows in French.

Build under test: Munder Difflin / Zomboid Control Panel v1.1.55, running from source
(`node server/index.js`, client built via `npm run build` and served statically — not the vite
dev proxy, to avoid the shared dev-server churn described below). Test instance isolated to my
own data directory (see ENVIRONMENT NOTE) so I'm not reading/writing the shared repo's `data/`.

---

## ENVIRONMENT NOTE (for the floor, not a panel bug)

Confirmed a **live, currently-active instance** of the `paths.config.json` race that Dwight is
assigned in board.md, within about 10 minutes of starting: I started `node server/index.js` on a
private port and it refused to boot —
`Refusing to start: another panel instance is already running (pid 49832)` — pointing at
`C:\Users\Sacha\AppData\Local\Temp\zcp-test-fg3EkJ\data\panel.lock`. Some other agent's `vitest`
run had `paths.config.json` at the repo root pointing at its own temp dir at that exact instant;
my boot read it, inherited their (stale) lock, and refused. Confirms the hazard is real and
frequent, not theoretical.

Separately: the shared repo-root `data/db.json` (default data dir, no override) had a working
admin account created by someone/something else between 16:21 and 16:26 today, mid-session —
meaning that shared instance is no longer available for anyone else to test first-run setup
against. If another hunter needs a fresh first-run, they'll hit the same wall I did. I did **not**
touch or reset that shared data — I gave myself an isolated data directory instead (briefly wrote
my own `paths.config.json`, confirmed my process picked it up, then deleted it within ~1.5s so the
shared default is undisturbed for everyone else; same pattern `vitest.globalSetup.mjs` already
uses).

---

## First-run setup wizard (`/` when no admin exists)

**GOOD:** "Create account & continue" stays disabled until the form is genuinely valid — verified
empty form, mismatched passwords, and a 2-character password all keep it disabled with inline
reasons ("Passwords do not match", "Use at least 6 characters"). No way to submit garbage.

**GOOD:** Wrong setup token produces a specific, correct error: *"Invalid or missing setup token.
Check the panel's startup log or console output for the one-time token."* No misleading success
state.

**GOOD:** Pasted a setup token with leading/trailing spaces (the classic copy-paste-from-terminal
mistake) — the server trimmed it and setup succeeded. Nice detail, don't lose it in a refactor.

**OBSERVATION, not filing as a bug:** the admin **Username** field rejects accented characters —
typed `Sébastien Côté`, got *"3-32 chars; letters, numbers, _ or - only"* and the submit button
stayed disabled. This LOOKS like the French-display-name-vs-identifier-regex bug class called out
in my brief, but I don't think it's the real instance of it here: this field is the literal login
credential (used to authenticate, shown in the corner as `toby_admin`), not a display name, and
restricting login usernames to ASCII is a defensible, common choice (same as GitHub, etc.). Flagging
it explicitly so nobody "fixes" this one and declares the bug class handled — I'll keep checking
actual **display-name** fields (player nicknames, template names, server display name, admin
display name if one exists separately from username) for the real occurrence as I go through the
rest of the app.

**Minor / cosmetic, not filing as a bug:** the setup card shows a 3-step stepper (1 Account /
2 Server / 3 Online) with a "PREVIEW" panel describing steps 2 and 3. After account creation, the
app does NOT continue that same wizard — it drops you straight into the normal Dashboard with a
"Not Configured" banner pointing at a separate Server Setup flow. The stepper implies one
continuous wizard; the actual behaviour is account-creation-then-handoff. Not broken, just a
slightly misleading affordance for a brand-new, non-technical operator who just watched a 3-step
progress indicator promise two more steps in the same place.

**Confirmed working:** after successful setup, the panel auto-logs in (`toby_admin` visible in the
bottom-left of the sidebar) and lands on Dashboard, which correctly reads "No active server" / "Not
configured — Open Server Setup" with Install/Add existing/Add remote server actions. Telemetry
(host CPU/memory/disk) is live and populated, which is a good sign the socket connection actually
works and isn't just decorative.

---

> **RECONCILED 2026-08-24 (fork):** FIXED at `a4c3030` ("fix(paths): stop resolving data/log
> locations from process.cwd(), and fix a diagnostic that could never be right"). `crashDirs`
> now uses `getDataPaths().logsDir` instead of `process.cwd()`. Same commit also fixed the "?
> collections, 0 MB" diagnostic below AND found+fixed a third instance of the same bug class in
> `services/panelBridgeSftp.js`'s `getSftpCachePath()`, per the commit message — acting directly
> on your own "someone might grep for siblings" suggestion. Covered by
> `server/tests/dataPathDrift.test.js` (both directions: a configured non-default data dir, and
> the real unmocked default).

## BUG: Crash Logs tab reads `process.cwd()`, not the configured logs directory — WHERE: `server/routes/debug.js:4300-4305` (`GET /api/debug/crash-logs`) and `:4386-4389` (`GET /api/debug/crash-logs/:filename`)

**WHAT HAPPENS:** The Debug page's "Crashes" tab is supposed to show this panel install's own
crash/error logs. Its directory list is:
```
const crashDirs = [serverPath, path.join(serverPath, "logs"), process.cwd(), path.join(process.cwd(), "logs")];
```
`process.cwd()` is wherever the Node process happened to be launched from — for anyone running from
source (`npm run server:dev` / `node server/index.js`) that's the repo checkout root, **not**
`getDataPaths().logsDir`. Every other log feature in the same file gets this right: the "Full Log
(.txt)" download at line 1029 correctly builds its path from `paths.logsDir`. Only the crash-log
list and crash-log content routes bypass the abstraction and hardcode cwd.

**HOW I KNOW:** My test instance is deliberately isolated to its own data/logs directory (see the
environment note at the top of this file) so it can't be contaminated by the seven other agents
editing this same checkout. Despite that, my Debug → Crashes tab showed a real, current-looking
crash log — `error.log`, 35.1 KB, timestamped seconds after I loaded the page. Opening it: some
lines are genuinely mine (`RCON authentication failed`), but interleaved with them, at the *exact*
timestamps I was clicking around, are lines no real code path produces: `Failed to get storage
health: boom`, `Failed to get composed server status: db exploded`, `Unhandled API error on GET
/api/some-route: ENOENT: no such file or directory, open '/some/path'`. `"boom"` and `"db
exploded"` are textbook test-mock error messages, and `grep` confirms they only exist in
`server/tests/systemRoutes.test.js` / `serverStatusRoute.test.js` fixtures — never in production
code. I confirmed the actual file being shown is `D:\...\Zomboid_Control_Panel_Modernized\logs\error.log`
at the **repo root** (923 KB `combined.log` sitting next to it) — the shared log some other
agent's test run against a real (non-mocked) logger is writing to, not anything belonging to my
isolated instance.

**WHAT SHOULD HAPPEN:** `crashDirs` should use `getDataPaths().logsDir` (and, for `serverPath`,
whatever the active server's own configured log locations are) instead of `process.cwd()`.

**WHY IT MATTERS to a real operator, not just this hive:** in the packaged/installed app,
`process.cwd()` and the default data dir usually coincide, which is why this has stayed invisible.
But the panel has a real "move my data & logs directory" feature (`server/utils/paths.js
setDataPaths`) advertised in Settings. Any operator who uses it will find the Crash Logs tab keeps
showing crash logs from the OLD location forever — or, if they run the panel from a shortcut with a
different working directory, from some unrelated folder — while believing they're looking at their
current install's crash history. That's the panel stating something false about its own state, not
just a cosmetic miss.

**Severity: Medium.** Doesn't destroy or expose anything, but it's a genuine correctness bug in a
diagnostics feature whose entire job is to be trustworthy, and I found it completely by accident
within the first 20 minutes — I'd bet it's not the only place `process.cwd()` snuck in over
`paths.js`. Someone with more time than me tonight might `grep -rn "process.cwd()" server/routes`
for siblings.

---

> **RECONCILED 2026-08-24 (fork):** FIXED, same commit as the Crash Logs bug above (`a4c3030`).
> A new `formatDbAccessibleMessage(dbStats)` function (debug.js:2109) replaces the broken
> `collections.length`/`.size` string-interpolation. Tests cover three cases explicitly: populated
> stats, unavailable stats (still renders "?" — unknown stays unknown), and a genuinely empty
> database (renders "0", not "?" — an honest zero is not the same as "couldn't tell").

## BUG: "Database accessible" diagnostic always shows "? collections, 0 MB" — WHERE: `server/routes/debug.js:3156`, feeding off `server/database/init.js:845-889` (`getDatabaseStatsSync`)

**WHAT HAPPENS:** Debug → Diagnostics → Storage & Database → "Database accessible" always renders
literally `"? collections, 0 MB."` no matter how much real data is in `db.json`. Confirmed on my
instance with a populated db (users, server events, etc. present, file size several KB and
growing) — still `? collections, 0 MB.`

**WHY:** `getDatabaseStatsSync()` returns `collections` as a **plain object** keyed by collection
name → count (`{ command_history: 0, servers: 1, ... }`), and there is no `size` field at all (the
byte count is under `fileSizeBytes`/`fileSizeKB`). But the diagnostic line reads:
```js
`${dbStats?.collections?.length || "?"} collections, ${fmtMB(dbStats?.size || 0)}.`
```
`collections.length` is `undefined` on a plain object (always falsy) → always falls through to
`"?"`. `dbStats.size` doesn't exist → always `0` → `fmtMB(0)` → `"0 MB"`. This check **cannot ever
pass correctly** — it's not "usually right, wrong on an edge case," it is *structurally* wrong on
every single run, which is exactly the "a check that cannot fail (or in this case, cannot succeed)"
pattern: invisible in review because the code looks reasonable, and no test asserts on the actual
rendered string.

**WHAT SHOULD HAPPEN:** something like `Object.keys(dbStats.collections).length` (or a count of
collections with `> 0` records, whichever is intended) for the first number, and
`fmtMB(dbStats.fileSizeBytes)` for the second.

**Severity: Low-Medium.** Cosmetic in isolation, but it sits inside the one panel that exists
specifically so an operator can trust the diagnostics, and "?" next to a green checkmark reads as
"this passed, ignore the weird placeholder" rather than the actual bug it is.

---

## RECONCILIATION SUMMARY (2026-08-24, fork)

All 5 BUG findings in this file verified against current source: **5 FIXED, 0 LIVE, 0 INVALID.**
Commits: `a4c3030` (crash logs + database diagnostic, two findings in one commit),
`7f3be0a` (error-code translation + the roles.json gap, also two findings in one commit),
`87c3d3a`..`df1f75a` (8-commit Diagnostics-tab translation effort, 46/47 checks, one deliberately
deferred). The two OBSERVATION items (accented username field, built-in template card
localization) were explicitly not filed as bugs by the original author and are left as-is —
no verdict needed for a question, not a finding.

## Coverage so far

Done: first-run setup wizard (adversarial + happy path), first Dashboard load, full click-through
of every nav route in English (Dashboard, Console, Players, Chat, Events, World Map, Server
Config, Mods, Templates, Scheduler, Backups, Map Cleanup, Servers, Server Setup, Server Finder,
Discord, Settings, Roles & Permissions, Debug incl. its Diagnostics/Crashes tabs). All render
without crashing and show sensible "no server configured yet" empty states.

Not yet done: destructive-action confirmation copy (Wipe server, Delete Older backups, chunk
deletion — none reachable without configuring a real server, which I'm deliberately not doing
against the dev machine's real local Project Zomboid install), and Settings' deeper tabs (it's the
largest file in the app per the floor — I only captured the first screen).

Adversarial input testing done: Mods "Add a single mod" (whitespace-padded workshop ID — correctly
trimmed and resolved; garbage/script-tag input — correctly rejected with a clear toast, no XSS,
no crash), Templates "Save Current Config" (accented French name/description/tags — accepted
perfectly, correctly blocked by a real precondition failure not a fake success), Roles "New Role"
(accented French name — accepted, created, and displayed correctly). See below for what I could
NOT confirm as a bug despite chasing it hard.

Investigated and ruled out (recording so nobody re-chases these tonight):
- Suspected the admin "Username" field's ASCII-only regex was the French-display-name bug class
  from my brief. It isn't — that field is the literal login credential, not a display name, and
  every real display-name field I tried (Template name/description/tags, Role name) accepted
  accented French text correctly.
- Suspected "Add a single mod" mis-parsed a whitespace-padded ID into "2 mod IDs". It's correct:
  one Steamdworkshop item can bundle multiple in-game mod folders (`TombWardrobeALT` +
  `TombWardrobeALTVanilla`), which is exactly what got detected.
- Spent real effort chasing what looked like "Users / Roles & Permissions nav items missing right
  after first-run setup's auto-login, but present later." Reproduced a truly fresh setup twice
  end-to-end (new isolated instance, immediate DOM check right after auto-login, no reload) and
  the nav items were present immediately both times. Could not reproduce the original absence —
  it was very likely an artifact of my own test harness reading the DOM mid-render on an earlier,
  heavily-reused browser session. Not filing as a bug per my brief's own instruction not to report
  a suspicion as a defect.
- Spent real effort convinced language-toggle didn't persist across reload (localStorage showed
  `"en"` right after clicking Français). Root cause was my own flaky selector clicking "Français"
  as a bare text match without first opening the language dropdown, so the click silently hit
  nothing. Re-verified cleanly (open dropdown via its `aria-label="Language"` button, then click
  the option): switches immediately AND persists correctly (`localStorage: zcp-language: "fr"`)
  AND survives a hard reload. This is a **GOOD** — don't let anyone "fix" it.

---

## French pass

Switched to Français and re-walked every route. Nav, sidebar section headers, and page chrome are
fully translated everywhere with **no raw i18n keys anywhere** (checked systematically — grepped
every page's full text for dotted/camelCase key-shaped strings, zero matches) and **no duplicate
French labels** for two different English nav items (checked all 20 nav entries pairwise).

**Known WIP, explicitly excluded per god's guidance:** Events.tsx (Stanley) is mid-rewrite right
now and its top-level headers ("WORLD CONTROL", "Event Console", "Weather, time, sounds...") are
still English while its sub-sections are already French — textbook mid-save state, not a defect,
not reporting it.

> **RECONCILED 2026-08-24 (fork):** FIXED at `7f3be0a` ("fix(i18n): getUserErrorMessage now
> prefers a registered error.code translation"). `getUserErrorMessage()` now extracts
> `error.code` and checks `getRegisteredTranslation(code, params)` FIRST, before ever falling
> back to the raw `error.message` — the raw-message path is now genuinely the fallback, not the
> primary path. The same commit also filled in the "Download a backup archive" French gap
> (Finding below) — a bundled fix.

### BUG: `getUserErrorMessage()` never translates by error code — always shows the server's raw English text, even when a correct French translation already exists — WHERE: `client/src/lib/errorMessage.ts:3-28`, used at 18 call sites in `ServerConfig.tsx`, 6 in `Events.tsx`, 1 in `Dashboard.tsx`

**WHAT HAPPENS:** In French, `/server-config` with no active server shows a banner that's French
chrome around a **raw English sentence**: *"No active server configured."* — twice on the same
page (the load-error banner and a second inline error state). `/chunks` shows a correctly-French
toast title ("Erreur") over a **raw English body**: *"Zomboid data path not set."*

**WHY:** `getUserErrorMessage(error, fallback)` (`errorMessage.ts:3`) does this:
```js
if (error instanceof ApiError) {
  const message = error.message?.trim()
  if (message && message.toLowerCase() !== 'unknown error') return message   // <-- raw, never translated
  return fallback
}
```
It returns the API's literal `message` string verbatim whenever one exists and isn't the string
`"unknown error"` — the translated `fallback` argument (which callers correctly pass, e.g.
`t('toasts.loadConfigFailed')`) is a dead code path for every error that actually has useful text,
which is nearly all of them. It never looks at `error.code` at all. Meanwhile
`client/src/locales/fr/errors.json` **already has a correct, translated string for this exact
case** — `"SERVER_NOT_CONFIGURED": "Aucun serveur actif configuré"` — sitting unused by this
helper. Some other part of the app clearly does look up `errors.json` by code (the file exists and
is well-populated with 20+ entries), so the fix is almost certainly "make `getUserErrorMessage`
do what that other code path already does," not "add missing translations."

**HOW I KNOW:** Reproduced on a hard-reloaded page in French, not a hot-reload artifact. Confirmed
by reading the source: `getUserErrorMessage` never references `error.code` or any i18n lookup;
`fr/errors.json` has the string it should have used sitting right there unused. `grep` shows 25
call sites total across 3 pages, so this isn't a one-off — every load/action error on ServerConfig,
Events, and Dashboard that carries a real server message is affected the same way.

**WHAT SHOULD HAPPEN:** Check `error.code` against the current locale's `errors.json` first; fall
back to the raw message only for codes with no translation, and to `fallback` only when there's no
message at all.

**Severity: Medium.** Doesn't break functionality, but it's the exact "translation exists, is
correct, and is silently bypassed" failure mode — worse for morale than a plain missing key, since
whoever wrote the French `errors.json` entries reasonably believes this is already solved.

---

> **RECONCILED 2026-08-24 (fork):** FIXED, in a large, deliberate multi-batch effort — 8 commits
> (`87c3d3a` batch 1 through `df1f75a` batch 8), each translating one diagnostic group (Core
> Services, Active Server, Storage & Database, Runtime & Memory, Updates, PanelBridge IPC, Mods,
> server.recentCrash) via the same server-emits-codes-and-params-the-client-interpolates
> mechanism the original finding correctly identified as the real fix shape (not "add French
> strings" — there was nothing to add strings TO). Batch 8's own commit message states 46 of 47
> checks are now translated, with `server.configDrift` "deliberately deferred" (named, not
> silently skipped) — call this FIXED with one small, documented, intentional exception rather
> than fully closed.

### BUG: Debug → Diagnostics tab is 100% untranslated, by design of where the text comes from — WHERE: every check pushed in `server/routes/debug.js`'s `/diagnostics` handler (~40+ `diagOk`/`diagWarn`/`diagSkip` calls, e.g. lines 1940-1970 and on)

**WHAT HAPPENS:** In French, the Diagnostics tab's page chrome, tab labels, and a handful of
wrapper words translate fine ("Débogage et journaux", "ignoré", "N vérifications"), but every
check's own title and message is English, unconditionally: group headers ("Core Services",
"Storage & Database", "Runtime & Memory", "Updates") and every single check body ("Server is
offline — RCON will connect when it starts.", "Waiting for Steam Workshop folder…", "128.9 GB free
of 953.9 GB.", "Host clock in sync" / "Within 1s of Steam time.", etc.) — I counted roughly 15
check titles and their descriptions, all English regardless of the language switcher.

**WHY, and why this is different from a normal missing-key bug:** these strings are constructed as
literal JS string interpolations **on the server**, in `server/routes/debug.js` (e.g. `` `Server is
offline — RCON will connect when it starts.` `` is a hardcoded template literal, not a translation
key), then sent to the client as plain finished text over `GET /api/debug/diagnostics`. The client
has no i18n key to translate here — there's nothing to look up, because the string was never a key
in the first place. This is architecturally a bigger fix than adding French strings: either the
server needs to emit codes + params for the client to run through i18n (like `errors.json` already
does elsewhere), or the whole diagnostics feed needs to move to the client. Recent commit
`7344c47 i18n(debug): add English/French translations for Debug & Logs` clearly translated the
page's own chrome but could not have touched this, since the check text doesn't exist as a
translatable string anywhere in the client bundle.

**Severity: Medium.** Not a functional bug (the checks themselves work, diagnose correctly, and are
genuinely useful), but a French-speaking operator troubleshooting a real problem will be reading
English health-check prose the whole time, in the one part of the app whose entire job is to be
understood correctly under stress.

---

> **RECONCILED 2026-08-24 (fork):** FIXED, same commit as the errorMessage.ts fix above
> (`7f3be0a`). `fr/roles.json`'s `backups.download` entry now reads "Télécharger une archive de
> sauvegarde" / a full translated description. Both `en/roles.json` and `fr/roles.json` have 28
> `"label"` entries — counts match, nothing else missing in this section.

### BUG (small, isolated): Roles & Permissions — one capability row never got translated — WHERE: `client/src/locales/fr/roles.json` (or wherever the "Backups" section's capability copy lives), row "Download a backup archive"

**WHAT HAPPENS:** On `/roles` in French, every capability row in the "SAUVEGARDES" section is
correctly translated (*"Créer, supprimer et configurer les sauvegardes"*, *"Restaurer une
sauvegarde"*, etc.) **except one, sitting between them**, which is 100% English: *"Download a
backup archive / Download a backup .zip off the machine -- a full copy of the world save and, if
database backups are turned on, the panel's own account data. A different act from creating,
deleting or restoring one: this one leaves the machine."* Every other ~25 rows on this page are
fully translated. This is a single missed key, not a pattern — clean and easy to fix.

---

### OBSERVATION, not filing as a bug: built-in Template cards keep their English name/description/tags in French

On `/templates` in French, the page chrome is fully translated (*"Modèles de simulation"*,
*"Enregistrer la configuration actuelle"*, *"N paramètres modifiés"*, *"Aperçu"*) but all six
built-in template cards' own content — name, description sentence, and tag chips ("Builder's
Paradise", "Low zombie pressure, generous XP and loot respawn...", "creative", "building",
"relaxed") — stays English. I'm not sure this is meant to be in scope for the French pass (it
reads like seeded content/data rather than UI chrome), so flagging as a question for whoever owns
Templates rather than a confirmed defect: are built-in template names/descriptions supposed to be
localized too?

---

## Coverage so far (updated)

Done: first-run setup wizard (adversarial + happy path), full English click-through of all 20
routes, full French click-through of all 20 routes (Events.tsx correctly excluded as known WIP),
adversarial input on Mods/Templates/Roles forms, and three genuinely-chased-but-ruled-out
suspicions recorded above so nobody re-spends time on them.

Not yet done: destructive-action confirmation copy (needs a configured server; deliberately not
setting one up against the dev machine's real local Zomboid install), Settings' deeper tabs beyond
the first screen, Scheduler/Chat/Players adversarial input (negative countdown numbers, broadcast
length limits, ban reason fields) — running low on my session budget, flagging this explicitly
per my brief rather than silently stopping.

## STANDING DOWN — handover

God confirmed findings #1-3 above (assigned to Pam/Dwight) and asked me to stop here rather than
rush anything else. One item was requested mid-session and NOT started, so noting it explicitly
for whoever picks it up: the packaged `.exe` double-click / repeated-launch UX (does a second
launch while the first is already up detect and refuse cleanly, or pile up; what's visible in the
gap between double-click and the panel becoming reachable). Angela's
`docs/build/verification.md` (commit `93449be`) already covers most of this — three orphaned
`cmd /K Start.bat` windows and one locked-.exe error from stacking direct launches — but the exact
single-instance-detection behavior of a *second* launch against an *already-healthy* first instance
is still an open question. I did not touch it.

Not reached, for the next hunter: destructive-action confirmation copy (Wipe server, Delete Older
backups, chunk deletion) against a real configured server; Settings beyond its first tab; negative/
out-of-range adversarial input on Scheduler countdowns, Chat broadcast length, and Players ban
reasons.
