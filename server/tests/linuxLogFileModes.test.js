import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// FILES-3 (security sweep 2026-10-04): logger.js created logs/ and its files
// with no explicit mode, so under the shipped systemd unit (no UMask) they came
// out 0755/0644: every local account could read combined.log, which then held
// the first-run setup token (see setupTokenConsoleOnly.test.js) along with
// host paths, usernames and IPs. logs/ is now 0700 and the log files 0600,
// tightened on every start so an existing install is fixed too.

const originalConfigPathEnv = process.env.PANEL_PATHS_CONFIG_PATH;
const originalUmask = process.platform !== "win32" ? process.umask() : null;
const tempRoots = [];
const loggers = [];

afterEach(async () => {
  if (process.platform !== "win32") process.umask(originalUmask);
  if (originalConfigPathEnv === undefined) {
    delete process.env.PANEL_PATHS_CONFIG_PATH;
  } else {
    process.env.PANEL_PATHS_CONFIG_PATH = originalConfigPathEnv;
  }
  for (const logger of loggers.splice(0)) logger.close();
  vi.resetModules();
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A fresh logger.js (and paths.js under it) pointed at a brand-new logsDir:
// both modules resolve their paths once, at import time.
async function freshLogger(prepare = () => {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-log-modes-"));
  tempRoots.push(tempRoot);
  const logsDir = path.join(tempRoot, "logs");
  const configPath = path.join(tempRoot, "paths.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ dataDir: path.join(tempRoot, "data"), logsDir }),
  );
  prepare(logsDir);
  process.env.PANEL_PATHS_CONFIG_PATH = configPath;
  vi.resetModules();
  const mod = await import("../utils/logger.js");
  loggers.push(mod.logger);
  return { ...mod, logsDir };
}

async function waitForFile(file) {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${file}`);
}

const modeBits = (p) => fs.statSync(p).mode & 0o777;

describe("logger.js: log directory and file modes", () => {
  it.skipIf(process.platform === "win32")(
    "fresh install, umask 022: logs/ is 0700 and combined.log / error.log are 0600",
    async () => {
      process.umask(0o022);
      const { createLogger, logsDir } = await freshLogger();
      createLogger("Test").error("mode probe");
      const combined = path.join(logsDir, "combined.log");
      const errors = path.join(logsDir, "error.log");
      await waitForFile(combined);
      await waitForFile(errors);

      expect(modeBits(logsDir)).toBe(0o700);
      expect(modeBits(combined)).toBe(0o600);
      expect(modeBits(errors)).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "existing install: a world-readable logs/ and log files are tightened on the next start",
    async () => {
      process.umask(0o022);
      const { createLogger, logsDir } = await freshLogger((dir) => {
        // What the pre-fix logger left behind under the shipped unit.
        fs.mkdirSync(dir, { recursive: true });
        fs.chmodSync(dir, 0o755);
        for (const name of ["combined.log", "error.log"]) {
          fs.writeFileSync(path.join(dir, name), "old line\n");
          fs.chmodSync(path.join(dir, name), 0o644);
        }
      });
      createLogger("Test").error("mode probe");
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(modeBits(logsDir)).toBe(0o700);
      expect(modeBits(path.join(logsDir, "combined.log"))).toBe(0o600);
      expect(modeBits(path.join(logsDir, "error.log"))).toBe(0o600);
    },
  );
});
