import { describe, expect, it } from "vitest";

// continuous-bug-hunt round 20 (charts mixing samples from two servers
// after a switch): performance_history used to be one single global array
// shared across every managed server, with no way to tell which recorded
// sample belonged to which one. On a panel managing more than one server,
// switching the active server never scoped this collection in any way --
// the next chart read (GET /debug/performance-history) returned a straight
// time-ordered mix of whichever server(s) happened to be active during
// each sample's window. Fixed by tagging every snapshot with the server
// that was active at sample time (server/index.js's perf-polling interval)
// and giving getPerformanceHistory() an optional serverId filter (server/
// database/init.js) that the operator-facing route now always passes.
//
// SAFETY, load-bearing: these are REAL, UNMOCKED modules -- a mock of
// database/init.js itself would make this meaningless, since the bug and
// fix are both IN that module's own filtering logic. Safe only because
// server/tests/vitest.perFileDataDir.setup.mjs mints a fresh, throwaway
// temp dataDir before this file's module graph is ever imported -- same
// convention as debugDatabaseRoutesRealExecution.test.js.

const { recordPerformanceSnapshot, getPerformanceHistory, clearPerformanceHistory } =
  await import("../database/init.js");

describe("getPerformanceHistory: scoped to one server, not mixed across a switch", () => {
  it("returns only the requested server's own tagged snapshots when a serverId is given", async () => {
    await clearPerformanceHistory();
    await recordPerformanceSnapshot({ serverId: "server-a", cpuUsage: 10 });
    await recordPerformanceSnapshot({ serverId: "server-b", cpuUsage: 20 });
    await recordPerformanceSnapshot({ serverId: "server-a", cpuUsage: 30 });
    await recordPerformanceSnapshot({ serverId: "server-b", cpuUsage: 40 });

    const historyA = await getPerformanceHistory(60, "server-a");
    expect(historyA.map((e) => e.cpuUsage)).toEqual([10, 30]);
    expect(historyA.every((e) => e.serverId === "server-a")).toBe(true);

    const historyB = await getPerformanceHistory(60, "server-b");
    expect(historyB.map((e) => e.cpuUsage)).toEqual([20, 40]);
  });

  it("returns everything, unfiltered, when no serverId is passed -- existing callers (the support-bundle export) are unaffected", async () => {
    await clearPerformanceHistory();
    await recordPerformanceSnapshot({ serverId: "server-a", cpuUsage: 10 });
    await recordPerformanceSnapshot({ serverId: "server-b", cpuUsage: 20 });

    const history = await getPerformanceHistory(60);
    expect(history.map((e) => e.cpuUsage)).toEqual([10, 20]);
  });

  it("tolerates pre-fix legacy rows with no serverId field at all -- treated as unknown, not excluded", async () => {
    await clearPerformanceHistory();
    // A snapshot recorded before this fix shipped never had a serverId key.
    await recordPerformanceSnapshot({ cpuUsage: 99 });
    await recordPerformanceSnapshot({ serverId: "server-a", cpuUsage: 10 });
    await recordPerformanceSnapshot({ serverId: "server-b", cpuUsage: 20 });

    const historyA = await getPerformanceHistory(60, "server-a");
    expect(historyA.map((e) => e.cpuUsage)).toEqual([99, 10]);
  });
});
