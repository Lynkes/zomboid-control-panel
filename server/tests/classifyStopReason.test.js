import { describe, expect, it } from "vitest";
import { classifyStopReason } from "../index.js";

// continuous-bug-hunt round 28 (ux-proposals-need-backend-data): a native
// crash and a deliberate stop used to look identical to every client --
// both just "stopped". classifyStopReason() is the precedence logic that
// turns whatever bookkeeping the panel's various stop/restart paths left
// behind into one of stop/restart/crash/unknown. Uses plain fake
// serverManager/rconService objects (the function takes them as explicit
// parameters specifically so this doesn't need to reach into index.js's own
// unexported module-level singletons).

function fakeServerManager(overrides = {}) {
  return { stopIntent: null, lastExitInfo: null, ...overrides };
}
function fakeRconService(overrides = {}) {
  return { lastQuitAttemptAt: null, ...overrides };
}

describe("classifyStopReason", () => {
  it("prefers stopIntent='stop' (ServerManager.stopServer) over everything else", () => {
    const sm = fakeServerManager({
      stopIntent: "stop",
      lastExitInfo: { exitCode: 1, signal: null }, // would otherwise say "crash"
    });
    const rcon = fakeRconService({ lastQuitAttemptAt: new Date().toISOString() }); // would otherwise also say "stop", but for the wrong reason
    const result = classifyStopReason(sm, rcon);
    expect(result.reason).toBe("stop");
  });

  it("prefers stopIntent='restart' (ServerManager.restartServer / performRestart) over a recent quit attempt", () => {
    const sm = fakeServerManager({ stopIntent: "restart" });
    const rcon = fakeRconService({ lastQuitAttemptAt: new Date().toISOString() });
    const result = classifyStopReason(sm, rcon);
    expect(result.reason).toBe("restart");
  });

  it("consumes (clears) stopIntent so the next call starts fresh", () => {
    const sm = fakeServerManager({ stopIntent: "stop" });
    const rcon = fakeRconService();
    classifyStopReason(sm, rcon);
    expect(sm.stopIntent).toBeNull();
  });

  it("falls back to a recent RCON quit attempt when no stopIntent is set (an ordinary /stop or Discord stop)", () => {
    const sm = fakeServerManager();
    const rcon = fakeRconService({ lastQuitAttemptAt: new Date().toISOString() });
    const result = classifyStopReason(sm, rcon);
    expect(result.reason).toBe("stop");
  });

  it("consumes (clears) lastQuitAttemptAt so a stale quit can't misattribute a later, unrelated exit", () => {
    const sm = fakeServerManager();
    const rcon = fakeRconService({ lastQuitAttemptAt: new Date().toISOString() });
    classifyStopReason(sm, rcon);
    expect(rcon.lastQuitAttemptAt).toBeNull();
  });

  it("ignores a quit attempt older than the recency window and falls through to exit-info/unknown", () => {
    const sm = fakeServerManager({ lastExitInfo: { exitCode: 1, signal: null } });
    const rcon = fakeRconService({ lastQuitAttemptAt: new Date(Date.now() - 5 * 60000).toISOString() });
    const result = classifyStopReason(sm, rcon);
    expect(result.reason).toBe("crash");
  });

  it("classifies a non-zero exit code as a crash when nothing more specific was recorded", () => {
    const sm = fakeServerManager({ lastExitInfo: { exitCode: 1, signal: null } });
    const result = classifyStopReason(sm, fakeRconService());
    expect(result.reason).toBe("crash");
    expect(result.exitCode).toBe(1);
  });

  it("classifies a signalled exit (e.g. killed) as a crash even with exit code 0/null", () => {
    const sm = fakeServerManager({ lastExitInfo: { exitCode: null, signal: "SIGKILL" } });
    const result = classifyStopReason(sm, fakeRconService());
    expect(result.reason).toBe("crash");
    expect(result.signal).toBe("SIGKILL");
  });

  it("does NOT classify a clean exit code 0 with no signal as a crash", () => {
    const sm = fakeServerManager({ lastExitInfo: { exitCode: 0, signal: null } });
    const result = classifyStopReason(sm, fakeRconService());
    expect(result.reason).toBe("unknown");
  });

  it("falls back to 'unknown' when nothing at all was recorded", () => {
    const result = classifyStopReason(fakeServerManager(), fakeRconService());
    expect(result.reason).toBe("unknown");
  });
});
