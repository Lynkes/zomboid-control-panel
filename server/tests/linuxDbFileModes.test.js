import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

// 2026-08-29 Linux auth/session/DB bug hunt (god): "what mode does db.json
// actually end up with on Linux, and is the write crash-safe" -- real stat
// output and a real fault-injected crash on real ext4 (WSL2), not reasoning
// about the code. Uses the real database/init.js (not mocked) against the
// per-test-file dataDir vitest.perFileDataDir.setup.mjs already provides --
// same approach as circuitBreakerStatus.test.js and db-tmp-cleanup.test.js.
const { getDb, commitNow, createDatabaseBackup, setSetting } = await import(
  "../database/init.js"
);
const { getDataPaths } = await import("../utils/paths.js");

const { dataDir, dbPath } = getDataPaths();
const backupDir = path.join(dataDir, "backups");
const isWindows = process.platform === "win32";

// Windows fs.chmod only toggles the read-only attribute, not a real POSIX
// mode -- mode assertions are meaningless there, matching this repo's own
// convention (see linuxSecretsFileModes.test.js, linuxDataDirModeGate.test.js).
function mode(p) {
  return fs.statSync(p).mode & 0o777;
}

const realWriteFileSync = fs.writeFileSync;

// 2026-08-30, flake-class-fixed-margin-sync: same shape as
// server/tests/supervisor-restart.test.js's waitForCondition -- poll for the
// actual post-condition instead of a wall-clock guess at when a scheduled
// retry will have fired and landed.
async function waitForCondition(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("db.json / backups — real on-disk mode", () => {
  it.skipIf(isWindows)(
    "db.json lands at 0600 after a flush under a normal umask",
    async () => {
      await getDb();
      const prevUmask = process.umask(0o022);
      try {
        await commitNow();
        expect(mode(dbPath)).toBe(0o600);
      } finally {
        process.umask(prevUmask);
      }
    },
  );

  it.skipIf(isWindows)(
    "db.json stays 0600 even under a permissive umask (000) -- not left at the mercy of the process umask",
    async () => {
      await getDb();
      const prevUmask = process.umask(0o000);
      try {
        await commitNow();
        expect(mode(dbPath)).toBe(0o600);
      } finally {
        process.umask(prevUmask);
      }
    },
  );

  it.skipIf(isWindows)(
    "a database backup file lands at 0600 -- same secrets it copies from db.json",
    async () => {
      await getDb();
      const result = await createDatabaseBackup();
      expect(result.success).toBe(true);
      const backupPath = path.join(backupDir, result.file);
      expect(mode(backupPath)).toBe(0o600);
    },
  );
});

describe("db.json write — crash-safety via fault injection at the write boundary", () => {
  it.skipIf(isWindows)(
    "a fault mid-write leaves db.json exactly as it was -- never truncated or partial",
    async () => {
      await getDb();
      await commitNow(); // establish a known-good baseline on disk
      const before = fs.readFileSync(dbPath, "utf-8");
      expect(() => JSON.parse(before)).not.toThrow();

      // Simulate the process dying mid-write: whichever path flushWrites()
      // actually targets (a same-dir tmp file, or -- if ever regressed --
      // db.json directly), let the write proceed halfway, then blow up
      // exactly like a SIGKILL would: no further bytes, no rename, nothing
      // cleaned up. Only intercepts writes that touch this test's own
      // db.json family so unrelated writeFileSync calls (logger, etc.)
      // pass straight through.
      const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((p, data, opts) => {
        if (!String(p).includes(path.basename(dbPath))) {
          return realWriteFileSync(p, data, opts);
        }
        const half =
          typeof data === "string" ? data.slice(0, Math.floor(data.length / 2)) : data;
        realWriteFileSync(p, half, opts);
        throw new Error("simulated crash mid-write");
      });

      await setSetting("crashProbeMarker", "should-not-appear-if-killed-mid-write");
      await commitNow(); // flushWrites() catches the thrown error internally, never rejects

      spy.mockRestore();

      // The live file must be untouched -- either the fault landed on a
      // separate tmp file (correct, atomic design) or, if it landed
      // directly on db.json, this assertion is exactly what should fail.
      const afterCrash = fs.readFileSync(dbPath, "utf-8");
      expect(afterCrash).toBe(before);
      expect(() => JSON.parse(afterCrash)).not.toThrow();

      // Positive control: prove the interception actually engaged the real
      // write path (not a vacuous pass because nothing wrote anything) --
      // a half-written casualty file must exist somewhere in dataDir.
      const casualty = fs
        .readdirSync(dataDir)
        .map((f) => path.join(dataDir, f))
        .find((f) => f !== dbPath && fs.statSync(f).isFile() && f.includes(path.basename(dbPath)));
      expect(casualty, "expected a half-written casualty file from the simulated crash").toBeTruthy();
      const casualtyContent = fs.readFileSync(casualty, "utf-8");
      expect(() => JSON.parse(casualtyContent)).toThrow(); // half a JSON document is not valid JSON

      // And the write path self-heals on its own scheduled retry -- no
      // operator action needed, no data loss beyond the interrupted write.
      // 2026-08-30, flake-class-fixed-margin-sync: this used to be a blind
      // `await sleep(1500)` -- a wall-clock guess that the first retry
      // (WRITE_BACKOFF_BASE_MS = 1000ms in database/init.js) would have
      // fired AND landed with 500ms to spare. Under this floor's routine
      // multi-agent CPU contention, a delayed timer callback could still be
      // mid-flight at the 1500ms mark. Poll for the actual post-condition
      // instead, with a deadline generous enough to absorb real contention.
      await waitForCondition(
        () => {
          try {
            return (
              JSON.parse(fs.readFileSync(dbPath, "utf-8")).settings.crashProbeMarker ===
              "should-not-appear-if-killed-mid-write"
            );
          } catch {
            return false; // mid-retry read of a not-yet-rewritten or transiently invalid file
          }
        },
        10000,
        "the scheduled retry to heal db.json",
      );
      const healed = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
      expect(healed.settings.crashProbeMarker).toBe("should-not-appear-if-killed-mid-write");

      fs.rmSync(casualty, { force: true });
    },
    10000,
  );
});
