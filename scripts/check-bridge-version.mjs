// PanelBridge version lock.
//
// The bridge VERSION changes only when the code a server or player runs
// changes. Workshop servers are told to restart for every published update
// (a new item timestamp refuses new joins with VersionMismatch until the
// server restarts), so a version bump over identical bytes costs every
// operator a restart for nothing. pz-mod/bridge-version.lock.json records the
// released version and the normalized hash of the three bridge files
// (PanelBridge.lua, PanelBridgeClient.lua, mod.info, with CRLF/BOM and the
// three version declarations masked). Unlike diffing against a git tag, it
// needs no history, so a shallow CI checkout works.
//
// Usage:
//   node scripts/check-bridge-version.mjs                  PR mode
//   node scripts/check-bridge-version.mjs --release        also fails when the code differs from the lock
//   node scripts/check-bridge-version.mjs --print-json     { version, lockVersion, codeSha256, lockSha256, changed }
//   node scripts/check-bridge-version.mjs --next           the version the next release should ship
//   node scripts/check-bridge-version.mjs --validate <v>   whether an explicit release version is allowed
//   node scripts/check-bridge-version.mjs --write-lock <v> record <v> and the current hash (same rules as --validate
//                                                          once a lock exists)
//   --root <dir>  run against another checkout (tests)

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_FILES,
  REPO_ROOT,
  compareSemver,
  formatLock,
  nextPatch,
  parseSemver,
  readBridgeState,
  readLock,
} from "./workshop/lib.mjs";

export function getBridgeVersionStatus(repoRoot = REPO_ROOT) {
  const state = readBridgeState(repoRoot);
  const { lock, error: lockError } = readLock(repoRoot);
  return {
    version: state.version,
    parityErrors: state.parityErrors,
    codeSha256: state.codeSha256,
    lockVersion: lock?.version ?? null,
    lockSha256: lock?.codeSha256 ?? null,
    lockError,
    changed: lock ? state.codeSha256 !== lock.codeSha256 : null,
  };
}

// Returns { errors, notices } for PR mode, or release mode with { release: true }.
export function checkBridgeVersion(status, { release = false } = {}) {
  const errors = [...status.parityErrors];
  const notices = [];
  if (status.lockError) {
    errors.push(status.lockError);
    return { errors, notices };
  }
  if (!status.version || !parseSemver(status.version)) return { errors, notices };
  const order = compareSemver(status.version, status.lockVersion);
  if (order < 0) {
    errors.push(`PanelBridge VERSION ${status.version} is below the released ${status.lockVersion} in ${BRIDGE_FILES.lock}`);
  } else if (!status.changed && order !== 0) {
    errors.push(
      `PanelBridge VERSION is ${status.version} but its code is unchanged since ${status.lockVersion}. ` +
        `Revert the bump: an unchanged bridge keeps its version (release.ps1 bumps it when the code changes).`,
    );
  } else if (status.changed && release) {
    // Not a --write-lock hint: re-locking by hand is how changed code ends up
    // under an old number. release.ps1 moves the version and the lock together.
    errors.push(
      `PanelBridge code differs from ${BRIDGE_FILES.lock} (${status.lockVersion}), so this tree wasn't released with release.ps1. ` +
        `Cut releases with release.ps1: it moves PanelBridge to ${nextBridgeVersion(status)} and rewrites the lock.`,
    );
  } else if (status.changed && order === 0) {
    notices.push("unreleased PanelBridge changes; the next release bumps the version");
  } else if (status.changed) {
    notices.push(`unreleased PanelBridge changes, already versioned ${status.version}`);
  }
  return { errors, notices };
}

export function nextBridgeVersion(status) {
  if (status.lockError) throw new Error(status.lockError);
  if (!status.changed) return status.lockVersion;
  if (status.version && parseSemver(status.version) && compareSemver(status.version, status.lockVersion) > 0) {
    return status.version;
  }
  return nextPatch(status.lockVersion);
}

// Rules for an explicit release.ps1 -PanelBridgeVersion: never below the lock,
// never a new number over unchanged code, and never the locked number over
// changed code (two different bridges would share one version, and the
// Workshop publish tool keys off it).
export function validateReleaseVersion(status, version) {
  if (status.lockError) return [status.lockError];
  if (!parseSemver(version)) return [`${version} is not a numeric SemVer`];
  const order = compareSemver(version, status.lockVersion);
  if (order < 0) return [`${version} is below the released PanelBridge ${status.lockVersion}`];
  if (!status.changed && order !== 0) {
    return [`PanelBridge code is unchanged since ${status.lockVersion}; ${version} would be a no-op bump`];
  }
  if (status.changed && order === 0) {
    return [`PanelBridge code changed since ${status.lockVersion}; ship it as a newer version (next: ${nextPatch(status.lockVersion)})`];
  }
  return [];
}

export function writeBridgeVersionLock(repoRoot, version) {
  if (!parseSemver(version)) throw new Error(`${version} is not a numeric SemVer`);
  const status = getBridgeVersionStatus(repoRoot);
  if (status.parityErrors.length) throw new Error(status.parityErrors.join("; "));
  // The lock describes the files as they are, so they must already carry the
  // version it records (release.ps1 rewrites them first).
  if (status.version !== version) {
    throw new Error(`PanelBridge files declare ${status.version}, not ${version}; rewrite them before locking`);
  }
  // An existing lock only moves the way a release may: re-locking the locked
  // number over changed code would give two different bridges one version,
  // and Workshop servers would silently keep the old one (the publish tool
  // refuses a version it already published, and the panel's staleness warning
  // compares versions, not code). A missing or unreadable lock can be recreated.
  if (!status.lockError) {
    const problems = validateReleaseVersion(status, version);
    if (problems.length) {
      throw new Error(
        `refusing to lock ${version}: ${problems.join("; ")}. ` +
          "Cut releases with release.ps1, which picks the version and rewrites the files and the lock together.",
      );
    }
  }
  fs.writeFileSync(path.join(repoRoot, BRIDGE_FILES.lock), formatLock(version, status.codeSha256));
  return { version, codeSha256: status.codeSha256 };
}

const USAGE = `Usage: node scripts/check-bridge-version.mjs [--release | --print-json | --next | --validate <version> | --write-lock <version>] [--root <dir>]`;

export function runCheckBridgeVersionCli(argv, { repoRoot = REPO_ROOT, log = console.log, error = console.error } = {}) {
  let mode = "pr";
  let modeValue = null;
  let root = repoRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      log(USAGE);
      return 0;
    } else if (arg === "--root" && argv[index + 1]) {
      root = path.resolve(argv[++index]);
    } else if (["--release", "--print-json", "--next"].includes(arg)) {
      mode = arg.slice(2);
    } else if (["--validate", "--write-lock"].includes(arg) && argv[index + 1]) {
      mode = arg.slice(2);
      modeValue = String(argv[++index]).trim().replace(/^v/, "");
    } else {
      error(`Unknown or incomplete argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }

  try {
    if (mode === "write-lock") {
      const written = writeBridgeVersionLock(root, modeValue);
      log(`Wrote ${BRIDGE_FILES.lock}: PanelBridge ${written.version} (${written.codeSha256})`);
      return 0;
    }
    const status = getBridgeVersionStatus(root);
    if (mode === "print-json") {
      const { version, lockVersion, codeSha256, lockSha256, changed } = status;
      log(JSON.stringify({ version, lockVersion, codeSha256, lockSha256, changed }));
      return 0;
    }
    if (mode === "next") {
      log(nextBridgeVersion(status));
      return 0;
    }
    if (mode === "validate") {
      const problems = validateReleaseVersion(status, modeValue);
      for (const problem of problems) error(`PanelBridge version check failed: ${problem}`);
      if (!problems.length) log(`PanelBridge ${modeValue} is a valid release version`);
      return problems.length ? 1 : 0;
    }
    const { errors, notices } = checkBridgeVersion(status, { release: mode === "release" });
    for (const problem of errors) error(`PanelBridge version check failed: ${problem}`);
    for (const notice of notices) log(`Notice: ${notice}`);
    if (!errors.length) {
      log(`PanelBridge version check passed: ${status.version} (lock ${status.lockVersion}, code ${status.changed ? "changed" : "unchanged"})`);
    }
    return errors.length ? 1 : 0;
  } catch (caught) {
    error(`PanelBridge version check failed: ${caught.message}`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  process.exitCode = runCheckBridgeVersionCli(process.argv.slice(2));
}
