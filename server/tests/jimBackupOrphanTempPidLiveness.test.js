import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { cleanupOrphanBackupTemps, isBackupTempOwnerAlive } from "../services/backupService.js";

// hunt-wave11-2026-08-29 follow-up. Dwight found this while copying
// cleanupOrphanBackupTemps as the model for fileWriteQueue.js's own sweep
// (531dfd8d) -- his copy came out stronger than the original. The original
// deleted on FILENAME PATTERN ALONE, with no check that the process which
// created a match is actually gone. Safe TODAY only because backups are
// effectively single-flight -- an assumption resting OUTSIDE this function
// rather than a guarantee inside it. This proves the fix applies
// fileWriteQueue.js's model (process.kill(pid, 0), any outcome other than
// a confirmed ESRCH treated as "still alive") to the ONE pattern that
// actually embeds a pid (.central-{pid}-{timestamp}-{random}.tmp,
// StreamingZipWriter's own construction, server/utils/streamingZip.js),
// while *.zip.tmp (no pid anywhere in its name) stays exactly as before --
// two patterns, deliberately not one generalised mechanism.

function makeDeadPid() {
  // A real pid guaranteed to have exited by the time this returns --
  // spawnSync only returns once the child is gone, so its pid cannot
  // legitimately be "alive" a moment later. Same technique as
  // writeFileAtomicOrphanTempSweep.test.js's makeDeadPid().
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return result.pid;
}

function centralName(pid) {
  return `.central-${pid}-1735500000000-k3f9zq.tmp`;
}

describe("isBackupTempOwnerAlive", () => {
  it("is true for this process's own, unambiguously running pid", () => {
    expect(isBackupTempOwnerAlive(process.pid)).toBe(true);
  });

  it("is false for a pid confirmed to have already exited (ESRCH)", () => {
    expect(isBackupTempOwnerAlive(makeDeadPid())).toBe(false);
  });
});

describe("cleanupOrphanBackupTemps", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-orphan-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes a .central-*.tmp orphan whose pid is confirmed dead", () => {
    const orphan = path.join(dir, centralName(makeDeadPid()));
    fs.writeFileSync(orphan, "half-written before a crash");

    cleanupOrphanBackupTemps(dir);

    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("NEVER removes a .central-*.tmp file whose pid is still running, even though it matches the exact same name shape -- the bug Dwight found", () => {
    // Our own pid -- unambiguously alive for the duration of this test.
    const liveOrphan = path.join(dir, centralName(process.pid));
    fs.writeFileSync(liveOrphan, "a backup genuinely still in flight");

    cleanupOrphanBackupTemps(dir);

    expect(fs.existsSync(liveOrphan)).toBe(true);
    expect(fs.readFileSync(liveOrphan, "utf-8")).toBe(
      "a backup genuinely still in flight",
    );
  });

  it("*.zip.tmp is still removed unconditionally -- no pid to check, pattern-only deletion is unchanged for this pattern", () => {
    const zipTemp = path.join(dir, "some-backup.zip.tmp");
    fs.writeFileSync(zipTemp, "partial archive");

    cleanupOrphanBackupTemps(dir);

    expect(fs.existsSync(zipTemp)).toBe(false);
  });

  it("a malformed .central-*.tmp name that doesn't embed a real pid is left alone, not swept on a lenient match -- 'fail toward leave it alone'", () => {
    // Not shaped like StreamingZipWriter's real output at all (no numeric
    // pid segment) -- liveness genuinely cannot be determined for this, so
    // the safe direction is to leave it, not delete it on a loose prefix
    // match the way the pre-fix regex (/^\.central-.*\.tmp$/) would have.
    const malformed = path.join(dir, ".central-not-a-real-pid.tmp");
    fs.writeFileSync(malformed, "not a real StreamingZipWriter temp");

    cleanupOrphanBackupTemps(dir);

    expect(fs.existsSync(malformed)).toBe(true);
  });

  it("leaves unrelated files alone", () => {
    const unrelated = path.join(dir, "notes.txt");
    fs.writeFileSync(unrelated, "not ours");

    cleanupOrphanBackupTemps(dir);

    expect(fs.existsSync(unrelated)).toBe(true);
  });
});

// Audit 2026-10-20: POST /api/backup/upload streams into
// `<name>.zip.<pid>.<random>.tmp`, a name neither pattern above matched, so a
// panel killed mid-upload left a multi-GB temp file behind for good. It
// embeds the uploading process's pid and is swept once that pid is gone.
describe("cleanupOrphanBackupTemps: upload temps", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-orphan-upload-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The exact shape routes/backup.js builds.
  const uploadTemp = (pid) => `uploaded-world.zip.${pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;

  it("removes an upload temp whose pid is confirmed dead", () => {
    const orphan = path.join(dir, uploadTemp(makeDeadPid()));
    fs.writeFileSync(orphan, "half an upload");

    cleanupOrphanBackupTemps(dir);

    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("keeps an upload still streaming in a live process", () => {
    const live = path.join(dir, uploadTemp(process.pid));
    fs.writeFileSync(live, "an upload in flight");

    cleanupOrphanBackupTemps(dir);

    expect(fs.existsSync(live)).toBe(true);
  });

  it("leaves a finished upload and look-alike names alone", () => {
    const names = ["uploaded-world.zip", "uploaded-world.zip.notapid.abc.tmp", "notes.123.abc.tmp"];
    for (const name of names) fs.writeFileSync(path.join(dir, name), "x");

    cleanupOrphanBackupTemps(dir);

    for (const name of names) expect(fs.existsSync(path.join(dir, name))).toBe(true);
  });
});

// In the Docker images the panel is PID 1 at every start, so a temp left by a
// killed earlier run is named with a pid that is "alive" again: it is ours.
// A temp named with our own pid but written before this process started is
// from an earlier run and must go; one written since is in use and stays.
describe("cleanupOrphanBackupTemps when the panel reuses its pid (Docker PID 1)", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-pid1-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const hourAgo = () => new Date(Date.now() - process.uptime() * 1000 - 3600_000);

  it("removes a temp with our pid that predates this process", () => {
    const central = path.join(dir, centralName(process.pid));
    const upload = path.join(dir, `world.zip.${process.pid}.abc123.tmp`);
    for (const file of [central, upload]) {
      fs.writeFileSync(file, "left by an earlier run");
      fs.utimesSync(file, hourAgo(), hourAgo());
    }

    cleanupOrphanBackupTemps(dir);

    expect(fs.existsSync(central)).toBe(false);
    expect(fs.existsSync(upload)).toBe(false);
  });

  it("keeps a temp with our pid that this process is writing", () => {
    const central = path.join(dir, centralName(process.pid));
    const upload = path.join(dir, `world.zip.${process.pid}.abc123.tmp`);
    fs.writeFileSync(central, "in use");
    fs.writeFileSync(upload, "in use");

    cleanupOrphanBackupTemps(dir);

    expect(fs.existsSync(central)).toBe(true);
    expect(fs.existsSync(upload)).toBe(true);
  });
});
