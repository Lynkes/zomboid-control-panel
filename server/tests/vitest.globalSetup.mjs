// Modernization DISC-001 / RISK-009: keep the test suite out of the
// repository's data/ and logs/, and stop concurrent runs from racing on
// each other -- or on the real panel.
//
// WHY THIS EXISTS
// `server/database/init.js` runs a bare top-level `for` loop of `fs.mkdirSync` (lines 43-50), so
// merely IMPORTING it creates `data/` and `data/backups/` and writes a default `data/db.json`.
// `scripts/modernization/bootstrap-plan.ps1` then refuses to pass, because a runtime `data/db.json`
// must never exist in the modernization fork. The documented FND-001 command sequence therefore
// could not be run twice: its own mandatory gate broke its own mandatory preflight.
//
// WHY EVERY RUN GETS ITS OWN CONFIG FILE, NOT ONE SHARED PATH
// The original version of this file (see git history) wrote a single fixed
// `paths.config.json` at the repo root, matching what `server/utils/paths.js`
// read by default. That was fine for one run at a time. It is not fine for
// eight-plus agents each running `vitest run server/tests` concurrently on
// the same machine: two runs starting close together raced on that one
// file, and one run's data root would silently become another run's. Worse
// than a test-only problem -- `paths.js` resolves that SAME shared path for
// the real panel process too, with no way to tell "a live test run's
// temporary override" from "a developer's real config". A real server boot
// that started while a test run's override was live would read the test
// run's ephemeral, about-to-be-deleted temp root as ITS data root. This
// happened for real on this floor: a concurrent vitest run's temp override
// plus a stale panel.lock (correctly refusing a second instance on what it
// believed, correctly given its input, was a shared data directory) kept
// the real panel from booting. Fixed at the root: give every run its own
// file, so a test run and the real panel -- or two test runs -- can never
// end up pointing at the same directory by accident.
//
// PANEL_PATHS_CONFIG_PATH (see server/utils/paths.js) is how this run's
// config file gets found: written here, in the main process, BEFORE
// `getDataPaths()` first executes anywhere. `paths.js` resolves the data
// root ONLY from that file's location and memoizes the result at first
// import -- there is no live re-read, so the env var must already be set
// before ANY worker imports the module. `globalSetup` runs in the main
// process before workers spawn, which is exactly that window; a
// `setupFiles` hook would be too late. Verified (not assumed) that a
// `process.env` write here actually reaches vitest's worker processes:
// vitest's default pool forks workers via child_process AFTER globalSetup
// completes, and Node's fork() snapshots `process.env` at spawn time -- the
// same ordering this file already depended on for the file-based version,
// now carrying one more value across that same boundary. The full suite
// passing with data/db.json staying absent (this file's own acceptance
// check, unchanged) is the empirical proof, not the reasoning above on its
// own.
//
// A process that never sets PANEL_PATHS_CONFIG_PATH -- the real panel, or
// any manual script -- is completely unaffected: paths.js falls back to
// reading today's repo-root paths.config.json exactly as before, so a
// developer's real hand-written override is still respected. The real
// panel never touches this file's per-run path, and a per-run path never
// touches the repo-root file -- neither can affect the other by
// construction, not by convention.
//
// AN INTERRUPTED RUN (Ctrl-C, a killed worker, a crash) is harmless, not
// prevented -- with eight-plus agents starting and killing runs, it is
// routine. Its config file lives inside its own unique OS temp directory
// (from fs.mkdtempSync), the same one already holding its data/logs dirs.
// If teardown doesn't fire, that whole directory is just ordinary orphaned
// OS temp clutter -- nothing else was ever pointed at it, so nothing can be
// corrupted by it lingering, unlike the old shared-path design where a
// leftover file WAS the next run's (or the real panel's) config.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempRoot = null;

export async function setup() {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-test-"));
  const configPath = path.join(tempRoot, "paths.config.json");
  const config = {
    dataDir: path.join(tempRoot, "data"),
    logsDir: path.join(tempRoot, "logs"),
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  process.env.PANEL_PATHS_CONFIG_PATH = configPath;
}

export async function teardown() {
  delete process.env.PANEL_PATHS_CONFIG_PATH;
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
}
