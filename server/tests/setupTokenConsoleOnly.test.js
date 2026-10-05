import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import winston from "winston";

// FILES-3 (security sweep 2026-10-04): logSetupTokenIfNeeded() logged the
// first-run setup token through every winston transport, so it landed in
// <logsDir>/combined.log. On the shipped systemd layout that file was
// world-readable (no UMask, default 0644 log files in a 0755 logs/), so any
// local account could read the token and create the panel's admin account
// first. The token must reach the console (terminal / journal / docker logs)
// and nothing else: not the log files, not the in-memory buffer and live
// stream that the Debug page and support bundles read.
//
// Real, unmocked logger, setup-token module and database (the per-file temp
// dataDir/logsDir from vitest.perFileDataDir.setup.mjs isolates them).
const { initDatabase } = await import("../database/init.js");
const { getDataPaths } = await import("../utils/paths.js");
const { logger, createLogger, onLog } = await import("../utils/logger.js");
const { logSetupTokenIfNeeded, getOrCreateSetupToken } = await import(
  "../utils/setupToken.js"
);

const combinedLog = () => path.join(getDataPaths().logsDir, "combined.log");
const readCombined = () =>
  fs.existsSync(combinedLog()) ? fs.readFileSync(combinedLog(), "utf8") : "";

async function waitFor(predicate, what) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SETUP_TOKEN;
});

describe("first-run setup token reaches the console only", () => {
  it("is printed to the console but never written to combined.log or the log stream", async () => {
    delete process.env.SETUP_TOKEN;
    await initDatabase();

    const consoleTransport = logger.transports.find(
      (transport) => transport instanceof winston.transports.Console,
    );
    const consoleMessages = [];
    vi.spyOn(consoleTransport, "log").mockImplementation((info, callback) => {
      consoleMessages.push(String(info.message));
      callback();
    });
    const streamed = [];
    const stopStreaming = onLog((entry) => streamed.push(String(entry.message)));

    try {
      await logSetupTokenIfNeeded(true);
      const token = await getOrCreateSetupToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);

      // A line logged AFTER the token: once it is on disk and in the stream,
      // anything logged before it would be too, so the absence checks below
      // can't pass just because a write hadn't landed yet.
      const marker = `setup-token-marker-${Date.now()}`;
      createLogger("Test").warn(marker);
      await waitFor(() => readCombined().includes(marker), "the marker in combined.log");
      await waitFor(() => streamed.some((m) => m.includes(marker)), "the marker in the log stream");

      expect(consoleMessages.some((m) => m.includes(`first-run setup: ${token}`))).toBe(true);
      expect(readCombined()).not.toContain(token);
      expect(streamed.some((m) => m.includes(token))).toBe(false);
    } finally {
      stopStreaming();
    }
  });

  it("still writes ordinary warnings to combined.log (only the flagged entry is held back)", async () => {
    const line = `ordinary-warning-${Date.now()}`;
    createLogger("Test").warn(line);
    await waitFor(() => readCombined().includes(line), "an ordinary warning in combined.log");
  });
});
