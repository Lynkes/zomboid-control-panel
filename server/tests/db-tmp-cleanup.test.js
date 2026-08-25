import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

// Real modules (not mocked) — the globalSetup already redirects dataDir into
// a throwaway temp root for the whole suite, so this is safe to exercise
// against the real fs the same way circuitBreakerStatus.test.js does.
const { sweepOrphanedTmpFiles } = await import("../database/init.js");
const { getDataPaths } = await import("../utils/paths.js");

const { dataDir } = getDataPaths();

// Mirrors MIN_ORPHAN_AGE_MS in database/init.js with margin — not exported
// since it's an internal safety threshold, not part of the module's surface.
const OLD_ENOUGH_MS = 90_000;

function tmpFilePath(pid) {
  return path.join(dataDir, `db.json.${pid}.abc123.tmp`);
}

function writeTmpFile(pid, ageMs) {
  const filePath = tmpFilePath(pid);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ servers: [{ rconPassword: "leaked-secret-should-not-survive" }] }),
  );
  if (ageMs > 0) {
    const old = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, old, old);
  }
  return filePath;
}

/** A pid guaranteed dead: spawn a trivial child and wait for it to exit. */
function getDeadPid() {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return result.pid;
}

function cleanupFixtures() {
  for (const name of fs.readdirSync(dataDir)) {
    if (/^db\.json\.\d+\.[0-9a-z]+\.tmp$/i.test(name)) {
      fs.rmSync(path.join(dataDir, name), { force: true });
    }
  }
}

describe("sweepOrphanedTmpFiles", () => {
  beforeEach(() => {
    cleanupFixtures();
  });

  afterEach(() => {
    cleanupFixtures();
  });

  it("removes a tmp file from a dead pid once it is old enough to be sure", () => {
    const filePath = writeTmpFile(getDeadPid(), OLD_ENOUGH_MS);
    sweepOrphanedTmpFiles();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("does NOT remove a tmp file belonging to a live process — the point of the whole sweep", () => {
    const filePath = writeTmpFile(process.pid, OLD_ENOUGH_MS);
    sweepOrphanedTmpFiles();
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("does NOT remove a dead-pid tmp file that is too fresh to be sure", () => {
    const filePath = writeTmpFile(getDeadPid(), 0);
    sweepOrphanedTmpFiles();
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("ignores files that don't match the write-temp naming pattern", () => {
    const decoyPath = path.join(dataDir, "db.json.notapid.abc123.tmp");
    fs.writeFileSync(decoyPath, "irrelevant");
    const old = new Date(Date.now() - OLD_ENOUGH_MS);
    fs.utimesSync(decoyPath, old, old);
    sweepOrphanedTmpFiles();
    expect(fs.existsSync(decoyPath)).toBe(true);
    fs.rmSync(decoyPath, { force: true });
  });
});
