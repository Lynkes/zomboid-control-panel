import { describe, expect, it } from "vitest";

// The Players activity filter (GET /players/activity?player=) matched the
// player's name exactly, while notes and playtime match it case-insensitively
// (the game's own names do): filtering "bob" showed nothing of Bob's history.
// Real database module, per-file temp data root.

const { logPlayerAction, getPlayerLogs } = await import("../database/init.js");

describe("getPlayerLogs: the player filter ignores letter case", () => {
  it("finds a player's entries whatever case the filter uses", async () => {
    await logPlayerAction("Bob", "kick", "Kicked for spam");
    await logPlayerAction("Alice", "ban", "Banned");

    for (const query of ["Bob", "bob", "BOB"]) {
      const logs = await getPlayerLogs(query);
      expect(logs.map((l) => [l.player_name, l.action])).toEqual([["Bob", "kick"]]);
    }
  });
});
