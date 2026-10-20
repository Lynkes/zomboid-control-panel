import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SECURITY (2026-10-20): the support bundle's in-memory-log-buffer.json holds
// the panel's newest log lines -- the same lines combined.log has -- but went
// into the bundle as they were logged, while combined.log is redacted on the
// way in (known secret values, RCON adduser passwords, Discord token shapes,
// Steam key query params). It now gets the same redaction.
const mockExecFile = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args) => mockExecFile(...args),
}));

const { buildBundleDiagnostics, addLogToBuffer, logBuffer } = await import("../routes/debug.js");

function fakeReq() {
  return { app: { get: () => undefined }, headers: {} };
}

const KNOWN = "hunter2-known-rcon-secret";
const DISCORD_TOKEN = `${"M".repeat(24)}.${"G".repeat(6)}.${"x".repeat(30)}`;

beforeEach(() => {
  // buildBundleDiagnostics also shells out (curl, docker); answer at once.
  mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "curl 8.4.0", ""));
  logBuffer.length = 0;
});
afterEach(() => {
  mockExecFile.mockReset();
  logBuffer.length = 0;
});

describe("support bundle: in-memory-log-buffer.json", () => {
  it("redacts the buffered lines as combined.log is redacted", async () => {
    addLogToBuffer("info", `RCON connected with password ${KNOWN}`, "server");
    addLogToBuffer("info", 'executing: adduser "bob" "swordfish123"', "rcon");
    addLogToBuffer("warn", `Discord login failed for token ${DISCORD_TOKEN}`, "discord");
    addLogToBuffer("info", "GET https://api.steampowered.com/x?key=ABCDEF0123456789ABCD&steamids=1", "steam");
    addLogToBuffer("info", { detail: `nested ${KNOWN}` }, `source ${KNOWN}`);
    addLogToBuffer("info", "Server started on port 16261", "server");

    const files = await buildBundleDiagnostics(null, fakeReq(), [KNOWN]);
    const content = files.find((f) => f.name === "in-memory-log-buffer.json").content;
    const buffer = JSON.parse(content);

    expect(content).not.toContain(KNOWN);
    expect(content).not.toContain("swordfish123");
    expect(content).not.toContain(DISCORD_TOKEN);
    expect(content).not.toContain("ABCDEF0123456789ABCD");
    expect(buffer.total).toBe(6);
    expect(buffer.entries.map((e) => e.message)).toEqual([
      "RCON connected with password [REDACTED]",
      'executing: adduser "bob" "[REDACTED]"',
      "Discord login failed for token [REDACTED-DISCORD-TOKEN]",
      "GET https://api.steampowered.com/x?key=[REDACTED]&steamids=1",
      '{"detail":"nested [REDACTED]"}',
      "Server started on port 16261",
    ]);
    expect(buffer.entries[4].source).toBe("source [REDACTED]");
    expect(buffer.entries[5]).toEqual(expect.objectContaining({ level: "info", source: "server" }));
  });

  it("leaves the live buffer itself untouched (the Logs page reads it)", async () => {
    addLogToBuffer("info", `RCON connected with password ${KNOWN}`, "server");
    await buildBundleDiagnostics(null, fakeReq(), [KNOWN]);
    expect(logBuffer[0].message).toContain(KNOWN);
  });
});
