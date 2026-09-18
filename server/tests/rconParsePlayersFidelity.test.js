import { describe, expect, it } from "vitest";
import { RconService } from "../services/rcon.js";

// 2026-09-18, round 12 (card: RCON "players" output parsing). Real format
// bytecode-confirmed against zombie.commands.serverCommands.PlayersCommand
// .Command() (D:/pz-verify/server/java/projectzomboid.jar, javap -p -c
// -constants): GameServer.rcon(cmd) always calls
// handleServerCommand(cmd, null) -- a null UdpConnection -- so the row
// separator is unconditionally a real "\n" (the "<LINE>" client-markup
// token is only used when connection != null, which never happens for an
// RCON-issued command). Exact shape:
//   "Players connected (X):\n-username1\n-username2\n"
// -- trailing \n, no extra whitespace anywhere: the "-" sits directly
// against the raw username on both sides, per the class's own
// `sb.append("-").append(username).append(sep)`.
//
// parsePlayers() used to call `.trim()` on the whole line AND AGAIN on the
// substring after the leading "-", which silently ate any leading/trailing
// whitespace that was part of the player's actual username. Fixed to strip
// only a defensive stray trailing \r and take the rest of the line as-is.

describe("RconService.parsePlayers: exact PZ wire format fidelity", () => {
  const rcon = new RconService();

  it("parses a normal multi-player response", () => {
    const response = "Players connected (2):\n-Alice\n-Bob\n";
    expect(rcon.parsePlayers(response)).toEqual([
      { name: "Alice", online: true },
      { name: "Bob", online: true },
    ]);
  });

  it("returns an empty list for an empty server (header only, no rows)", () => {
    const response = "Players connected (0):\n";
    expect(rcon.parsePlayers(response)).toEqual([]);
  });

  it("preserves a leading space that is genuinely part of the username", () => {
    // "- Bob" -- bullet directly against a username that itself starts
    // with a space. The old double-trim collapsed this to "Bob".
    const response = "Players connected (1):\n- Bob\n";
    expect(rcon.parsePlayers(response)).toEqual([{ name: " Bob", online: true }]);
  });

  it("preserves a trailing space that is genuinely part of the username", () => {
    const response = "Players connected (1):\n-Bob \n";
    expect(rcon.parsePlayers(response)).toEqual([{ name: "Bob ", online: true }]);
  });

  it("preserves internal spaces in a username unaffected either way", () => {
    const response = "Players connected (1):\n-John Smith\n";
    expect(rcon.parsePlayers(response)).toEqual([{ name: "John Smith", online: true }]);
  });

  it("preserves unicode usernames untouched", () => {
    const response = "Players connected (2):\n-\u96f6\u5e02\n-\ud83e\udddf\u200d\u2642\ufe0f\n";
    expect(rcon.parsePlayers(response)).toEqual([
      { name: "\u96f6\u5e02", online: true },
      { name: "\ud83e\udddf\u200d\u2642\ufe0f", online: true },
    ]);
  });

  it("a username that itself starts with '-' keeps its own dash (only the bullet is stripped)", () => {
    const response = "Players connected (1):\n--Zed\n";
    expect(rcon.parsePlayers(response)).toEqual([{ name: "-Zed", online: true }]);
  });

  it("the header row itself is never mistaken for a player", () => {
    const response = "Players connected (0):\n";
    const players = rcon.parsePlayers(response);
    expect(players.some((p) => p.name.includes("Players connected"))).toBe(false);
  });

  it("strips a stray trailing \\r defensively without touching the name", () => {
    const response = "Players connected (1):\r\n-Bob\r\n";
    expect(rcon.parsePlayers(response)).toEqual([{ name: "Bob", online: true }]);
  });

  it("returns an empty list for a null/undefined response", () => {
    expect(rcon.parsePlayers(null)).toEqual([]);
    expect(rcon.parsePlayers(undefined)).toEqual([]);
    expect(rcon.parsePlayers("")).toEqual([]);
  });
});
