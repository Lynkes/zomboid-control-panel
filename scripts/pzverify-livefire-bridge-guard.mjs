#!/usr/bin/env node
// Refuses to let a live-fire test run against a stale pz-verify bridge. Exits 0 only when the
// version this repo ships, the version PZ's own boot log announced it loaded, and the version the
// running bridge is CURRENTLY reporting over its live status file all agree. Any other outcome --
// including "could not tell" -- exits non-zero. Run this immediately before a live-fire session
// against pz-verify; treat any non-zero exit as "do not run the test", not as a warning.
//
// WHY THIS EXISTS: pz-verify's installed PanelBridge.lua has drifted from what the repo ships four
// separate times (2026-08-17, 2026-08-30, 2026-09-02 x2), each caught only because an agent happened
// to do a manual version diff before testing. That is not a guard, it is a good track record of
// luck. pz-verify has zero entries in data/db.json, so it was never enrolled as a panel-managed
// server and panelBridgeInstaller.js's own checkBridgeInstalled/needsUpdate sync path -- which is
// real, and does work for servers the panel manages -- was never wired to this box at all. This
// script is the guard for the one target that mechanism cannot reach.
//
// LAUNCHER-AGNOSTIC BY DESIGN (2026-09-03 rewrite): pz-verify can be started two different ways --
// by hand via start.ps1/stop.ps1, or through the panel's own POST /api/server/start and /restart
// (proven live this same day, see hive history). The two launchers write their process's pidfile to
// different places and capture stdout to different files, so an earlier version of this script that
// looked for start.ps1's own pz-verify.pid and its logs/pz-verify-*.out.log convention refused with
// "no pid file" after a perfectly healthy PANEL-managed boot -- correct to refuse on a signal it
// couldn't verify, wrong that it had no way to recognise the other convention at all. Fixed by
// dropping pidfile-dependence entirely in favour of two signals that are true regardless of which
// launcher started the process:
//
//   1. LIVENESS: scan for a java.exe process whose command line references this pz-verify install's
//      own cachedir path. Both launchers pass an absolute `-cachedir="<root>\Zomboid"` argument (it
//      is intrinsic to which save data the server points at, not a launcher choice), so this is true
//      in both worlds and false in neither -- matching the same technique start.ps1 already uses for
//      its own liveness probe, just keyed on the cachedir rather than a bare "pz-verify" substring so
//      it cannot cross-match the operator's separate real server also running java.exe on this box.
//
//   2. WHAT IT LOADED: PZ's own internal DebugLog-server.txt under `<root>\Zomboid\Logs\`, not the
//      panel's own server-launch.log. That file was PROVEN EMPTY through two full successful boots
//      today (2026-09-03) -- something about the panel's detached-cmd.exe stdio-redirect setup on
//      Windows isn't actually capturing the child's stdout into it (Jim is fixing that separately;
//      this script does not depend on it existing until he has). PZ's own DebugLog is written by the
//      game itself, independent of how -- or whether -- the launcher captured its stdout, and it is
//      the one boot-version signal that worked for both of today's panel-driven boots.
//
// TWO DESIGN CONSTRAINTS THAT SURVIVE FROM THE ORIGINAL VERSION:
//
//   1. Compare what the server ACTUALLY LOADED, not the file currently sitting on disk. PZ reads Lua
//      once, at JVM startup -- a correct file on disk and a stale already-running server are an
//      entirely normal, entirely misleading combination.
//
//   2. Fail CLOSED, and say WHICH KIND of failure it is. "No server running" (no matching process at
//      all) and "a server IS running but I cannot confirm what it loaded" (process found, but the
//      DebugLog/status signals are missing, stale, or unparsable) are different findings -- the first
//      is inert, the second is the one that would silently rot if it printed the same generic message
//      as the first and got ignored. Both still exit non-zero; only the wording differs.
//
// Usage: node scripts/pzverify-livefire-bridge-guard.mjs [--root <pz-verify root>]
//                                                          [--max-status-age-ms <n>]
// Defaults match this box: root D:\pz-verify, max status age 120000 (2 minutes). Override with
// --root/PZVERIFY_ROOT and --max-status-age-ms/PZVERIFY_MAX_STATUS_AGE_MS if your checkout differs.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const REPO_LUA_PATH = path.join(REPO_ROOT, 'pz-mod/PanelBridge/media/lua/server/PanelBridge.lua');

function parseArgs(argv) {
  const args = { root: null, maxStatusAgeMs: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = argv[++i];
    else if (argv[i] === '--max-status-age-ms') args.maxStatusAgeMs = Number(argv[++i]);
  }
  return args;
}

const cli = parseArgs(process.argv.slice(2));
const PZVERIFY_ROOT = cli.root || process.env.PZVERIFY_ROOT || String.raw`D:\pz-verify`;
const MAX_STATUS_AGE_MS =
  cli.maxStatusAgeMs ||
  Number(process.env.PZVERIFY_MAX_STATUS_AGE_MS) ||
  120000;
const SERVER_NAME = 'pz-verify';
const CACHEDIR = path.join(PZVERIFY_ROOT, 'Zomboid');

function fail(message) {
  console.error(`GUARD FAILED (would allow a stale live-fire run): ${message}`);
  process.exit(1);
}

// ---- 1. What does the repo ship? -------------------------------------------------------------

if (!fs.existsSync(REPO_LUA_PATH)) {
  fail(`repo Lua file not found at ${REPO_LUA_PATH} -- cannot determine the shipped version`);
}
const repoLuaText = fs.readFileSync(REPO_LUA_PATH, 'utf8');
const repoMatch = repoLuaText.match(/Version:\s*(\S+)/);
if (!repoMatch) {
  fail(`repo Lua file has no "Version:" header line -- cannot determine the shipped version`);
}
const repoVersion = repoMatch[1];

// ---- 2. LIVENESS: is a java.exe process pointed at pz-verify's own cachedir running right now, --
//         regardless of which launcher started it? -----------------------------------------------

let matchingPids = [];
try {
  // Passed via env, not string-interpolated into the PowerShell command, so the cachedir path's
  // own backslashes/parens can't be misread as script syntax. [regex]::Escape() inside handles
  // turning it into a literal match pattern for -match (which is regex, not a plain substring op).
  const psScript = [
    '$cd = [regex]::Escape($env:PZVERIFY_CACHEDIR_MATCH)',
    "Get-CimInstance Win32_Process -Filter \"Name='java.exe'\" |",
    '  Where-Object { $_.CommandLine -match $cd } |',
    '  Select-Object -ExpandProperty ProcessId',
  ].join('\n');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    encoding: 'utf8',
    env: { ...process.env, PZVERIFY_CACHEDIR_MATCH: CACHEDIR },
  });
  matchingPids = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l));
} catch (err) {
  fail(`process scan for a java.exe referencing ${CACHEDIR} failed to run: ${err.message}`);
}

if (matchingPids.length === 0) {
  // "No server running" -- distinct wording from the "running but unconfirmed" case below on
  // purpose (see header comment): this one is inert, nothing to accidentally treat as a pass.
  fail(
    `no server running -- no java.exe process references pz-verify's cachedir (${CACHEDIR}). ` +
      `Nothing to live-fire against.`
  );
}
if (matchingPids.length > 1) {
  fail(
    `ambiguous: ${matchingPids.length} java.exe processes reference ${CACHEDIR} ` +
      `(pids ${matchingPids.join(', ')}) -- refusing rather than guessing which one is current.`
  );
}
const pid = matchingPids[0];

// ---- 3. WHAT IT LOADED: PZ's own DebugLog-server.txt, not the panel's launch-capture log --------
//         (proven empty through two successful panel-driven boots on 2026-09-03 -- see header). --

const logsDir = path.join(PZVERIFY_ROOT, 'Zomboid', 'Logs');
let debugLogVersion = null;
let debugLogPath = null;
if (!fs.existsSync(logsDir)) {
  fail(
    `a server IS running (pid ${pid}) but its DebugLog directory does not exist at ${logsDir} -- ` +
      `cannot confirm what it loaded.`
  );
}
const debugLogCandidates = fs
  .readdirSync(logsDir)
  .filter((f) => /DebugLog-server\.txt$/.test(f))
  .map((f) => {
    const p = path.join(logsDir, f);
    return { path: p, mtime: fs.statSync(p).mtimeMs };
  })
  .sort((a, b) => b.mtime - a.mtime);
if (debugLogCandidates.length === 0) {
  fail(
    `a server IS running (pid ${pid}) but no *_DebugLog-server.txt exists under ${logsDir} -- ` +
      `cannot confirm what it loaded.`
  );
}
debugLogPath = debugLogCandidates[0].path;
const debugLogText = fs.readFileSync(debugLogPath, 'utf8');
// PZ's own log line ends the sentence with a period immediately after the version
// ("...Initializing v1.7.50.") -- a bare \S+ capture swallows it as part of the version and then
// never matches the repo's "1.7.50", failing closed for the wrong reason. Match the version's own
// X.Y.Z shape instead of "everything until whitespace" so the trailing full stop is never captured.
const debugLogMatches = [...debugLogText.matchAll(/\[PanelBridge\]\s+Initializing\s+v(\d+\.\d+\.\d+)/g)];
if (debugLogMatches.length === 0) {
  fail(
    `a server IS running (pid ${pid}) but its newest DebugLog (${debugLogPath}) has no ` +
      `"[PanelBridge] Initializing vX.Y.Z" line yet -- still booting, or PanelBridge failed to load. ` +
      `Cannot confirm what it loaded.`
  );
}
debugLogVersion = debugLogMatches[debugLogMatches.length - 1][1];

// ---- 4. What is the running bridge reporting RIGHT NOW? -----------------------------------------

const statusPath = path.join(PZVERIFY_ROOT, 'Zomboid', 'Lua', 'panelbridge', SERVER_NAME, 'status.json.txt');
if (!fs.existsSync(statusPath)) {
  fail(`a server IS running (pid ${pid}) but no live status file exists at ${statusPath}.`);
}
let status;
try {
  status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
} catch (err) {
  fail(`a server IS running (pid ${pid}) but its live status file is not valid JSON: ${err.message}`);
}
if (status.alive !== true) {
  fail(`a server IS running (pid ${pid}) but its live status file reports alive:${status.alive}.`);
}
if (!status.version) {
  fail(`a server IS running (pid ${pid}) but its live status file has no "version" field.`);
}
const statusAgeMs = Date.now() - Number(status.timestamp);
if (!Number.isFinite(statusAgeMs) || statusAgeMs < 0) {
  fail(`a server IS running (pid ${pid}) but its live status file has no usable timestamp.`);
}
if (statusAgeMs > MAX_STATUS_AGE_MS) {
  fail(
    `a server IS running (pid ${pid}) but its live status file is ${Math.round(statusAgeMs / 1000)}s ` +
      `old (max ${Math.round(MAX_STATUS_AGE_MS / 1000)}s) -- treating as unable to confirm current ` +
      `state, not assuming it is still accurate.`
  );
}
const statusVersion = status.version;

// ---- 5. Do they all agree? -----------------------------------------------------------------------

if (repoVersion !== debugLogVersion || repoVersion !== statusVersion) {
  fail(
    [
      'version mismatch:',
      `  repo ships (pz-mod/PanelBridge):      ${repoVersion}`,
      `  DebugLog announced loading:           ${debugLogVersion}  (${debugLogPath})`,
      `  running bridge currently reports:     ${statusVersion}`,
      'The running pz-verify server is not the code this repo ships. Redeploy before testing.',
    ].join('\n')
  );
}

console.log(
  `PASS: pz-verify (pid ${pid}) is running v${repoVersion}, confirmed by PZ's own DebugLog and live status. Safe to live-fire.`
);
process.exit(0);
