import { describe, expect, it } from "vitest";

// REAL, UNMOCKED database/init.js (the retention rule lives there). Safe
// because server/tests/vitest.perFileDataDir.setup.mjs gives every test file
// its own throwaway data dir.
const { getDb, logPlayerAction, getPlayerLogs, capPlayerLogs } = await import(
  "../database/init.js"
);

const row = (action, n) => ({
  id: `${action}-${n}`,
  server_id: null,
  player_name: `p${n}`,
  action,
  details: null,
  logged_at: new Date(2026, 0, 1, 0, 0, n).toISOString(),
});

// Newest-first, like player_logs itself: index 0 is the newest row.
const ring = (...actions) => actions.map((action, i) => row(action, i));

describe("capPlayerLogs: moderator actions are not evicted by routine rows", () => {
  it("leaves a ring at or under the routine cap untouched (same array)", () => {
    const logs = ring("connect", "ban", "disconnect");
    expect(capPlayerLogs(logs)).toBe(logs);
  });

  it("keeps an old ban when connect/disconnect/death rows overflow the routine cap", () => {
    // 1 recent ban, then 1100 routine rows (all newer than the ban would be in
    // a real ring) with the OLD ban at the very end.
    const routine = Array.from({ length: 1100 }, (_, i) =>
      row(["connect", "disconnect", "death"][i % 3], i),
    );
    const oldBan = row("ban", 5000);
    const oldKick = row("kick", 5001);
    const access = row("access_level", 5002);
    const logs = [...routine, oldBan, oldKick, access];

    const capped = capPlayerLogs(logs);

    // Routine rows are trimmed to the newest 1000; the three moderator rows,
    // which sit behind all of them, all survive.
    expect(capped.filter((r) => r.action === "connect" || r.action === "disconnect" || r.action === "death")).toHaveLength(1000);
    expect(capped.filter((r) => r.id === oldBan.id)).toHaveLength(1);
    expect(capped.filter((r) => r.id === oldKick.id)).toHaveLength(1);
    expect(capped.filter((r) => r.id === access.id)).toHaveLength(1);
    // Original (newest-first) order is preserved.
    expect(capped.map((r) => r.id)).toEqual(
      logs.filter((r) => !routine.slice(1000).includes(r)).map((r) => r.id),
    );
  });

  it("caps moderator rows at 5000, newest kept", () => {
    const logs = Array.from({ length: 5100 }, (_, i) => row("kick", i));
    const capped = capPlayerLogs(logs);
    expect(capped).toHaveLength(5000);
    expect(capped[0].id).toBe("kick-0");
    expect(capped[4999].id).toBe("kick-4999");
  });

  it("evicts oldest routine rows first, and never touches moderator rows doing so", () => {
    const logs = [
      ...Array.from({ length: 1000 }, (_, i) => row("connect", i)),
      row("ban", 2000),
      row("connect", 3000), // oldest routine row: the one that must go
    ];
    const capped = capPlayerLogs(logs);
    expect(capped).toHaveLength(1001);
    expect(capped.some((r) => r.id === "connect-3000")).toBe(false);
    expect(capped.some((r) => r.id === "ban-2000")).toBe(true);
  });

  it("treats unknown actions as moderator rows (default to protected)", () => {
    const logs = [
      ...Array.from({ length: 1001 }, (_, i) => row("connect", i)),
      row("some_future_action", 9000),
    ];
    const capped = capPlayerLogs(logs);
    expect(capped.some((r) => r.id === "some_future_action-9000")).toBe(true);
  });
});

describe("logPlayerAction: a ban survives connect/disconnect churn", () => {
  it("still lists a ban after 1200 later connects and disconnects", async () => {
    await logPlayerAction("Griefer", "ban", "IP: false, Reason: griefing");
    for (let i = 0; i < 600; i++) {
      await logPlayerAction(`p${i}`, "connect", "Player connected to server");
      await logPlayerAction(`p${i}`, "disconnect", "Player disconnected from server");
    }

    const db = await getDb();
    // The ban is still in the ring, behind 1000 newer routine rows (so it is
    // not in the newest page; the per-player filter is how it is found).
    expect(db.data.player_logs.filter((l) => l.action === "ban")).toHaveLength(1);
    expect(db.data.player_logs.filter((l) => l.action === "connect" || l.action === "disconnect")).toHaveLength(1000);
    const found = await getPlayerLogs("Griefer", 200);
    expect(found).toHaveLength(1);
    expect(found[0].action).toBe("ban");
  });

  it("keeps moderator rows that an older version already left in a full ring (nothing is migrated away)", async () => {
    const db = await getDb();
    // A 1000-row ring as the old code left it: mostly connects, two bans.
    db.data.player_logs = [
      ...Array.from({ length: 998 }, (_, i) => row("connect", i)),
      row("ban", 7000),
      row("kick", 7001),
    ];

    await logPlayerAction("NewPlayer", "connect", "Player connected to server");

    const logs = db.data.player_logs;
    expect(logs.map((l) => l.id)).toEqual(
      expect.arrayContaining(["ban-7000", "kick-7001"]),
    );
    expect(logs[0].player_name).toBe("NewPlayer");
  });
});
