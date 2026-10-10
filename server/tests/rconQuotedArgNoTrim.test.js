import { describe, expect, it, vi } from "vitest";
import { RconService } from "../services/rcon.js";

// parsePlayers() reports " Bob", "Bob " and "Bob" as three different players
// (rconParsePlayersFidelity.test.js), and the game's own username check and
// command tokenizer keep spaces inside quotes. sanitizeQuotedArg() used to
// trim, so kicking/banning/unbanning " Bob" or "Bob " acted on the account
// "Bob" instead.

function makeRcon() {
  const rcon = new RconService();
  const execute = vi
    .spyOn(rcon, "execute")
    .mockResolvedValue({ success: true, response: "ok" });
  return { rcon, execute };
}

describe("sanitizeQuotedArg keeps a name's own leading and trailing spaces", () => {
  it("returns the value as given", () => {
    const rcon = new RconService();
    expect(rcon.sanitizeQuotedArg(" Bob", "Username", 64)).toBe(" Bob");
    expect(rcon.sanitizeQuotedArg("Bob ", "Username", 64)).toBe("Bob ");
    expect(rcon.sanitizeQuotedArg("  Bob  ", "Username", 64)).toBe("  Bob  ");
    expect(rcon.sanitizeQuotedArg("Bob", "Username", 64)).toBe("Bob");
  });

  it("still refuses a blank value", () => {
    const rcon = new RconService();
    expect(() => rcon.sanitizeQuotedArg("", "Username")).toThrow("Username is required");
    expect(() => rcon.sanitizeQuotedArg("   ", "Username")).toThrow("Username is required");
    expect(() => rcon.sanitizeQuotedArg(null, "Username")).toThrow("Username is required");
    expect(() => rcon.sanitizeQuotedArg(undefined, "Username")).toThrow("Username is required");
  });

  it("still refuses quotes, backslashes and control characters, including at the edges", () => {
    const rcon = new RconService();
    for (const bad of ['Bob"', '"Bob', 'Bo"b', "Bob\\", "Bob\n", "\nBob", "Bob\t", "Bo\0b", "Bob\x7f"]) {
      expect(() => rcon.sanitizeQuotedArg(bad, "Username")).toThrow(
        "Username contains unsupported characters",
      );
    }
  });

  it("counts the spaces toward the length limit", () => {
    const rcon = new RconService();
    expect(() => rcon.sanitizeQuotedArg(`${"a".repeat(64)} `, "Username", 64)).toThrow(
      "Username is too long",
    );
    expect(rcon.sanitizeQuotedArg("a".repeat(64), "Username", 64)).toHaveLength(64);
  });
});

describe("player commands target the exact account name", () => {
  it("kickPlayer sends the name with its spaces", async () => {
    const { rcon, execute } = makeRcon();
    await rcon.kickPlayer(" Bob");
    await rcon.kickPlayer("Bob ");
    await rcon.kickPlayer("Bob");
    expect(execute.mock.calls.map((c) => c[0])).toEqual([
      'kickuser " Bob"',
      'kickuser "Bob "',
      'kickuser "Bob"',
    ]);
  });

  it('a lookalike "Bob " never produces a command for "Bob"', async () => {
    const { rcon, execute } = makeRcon();
    await rcon.kickPlayer("Bob ", "afk");
    await rcon.banPlayer("Bob ", true, "griefing");
    await rcon.unbanPlayer("Bob ");
    await rcon.setAccessLevel("Bob ", "admin");
    await rcon.removeFromWhitelist("Bob ");
    await rcon.voiceBan("Bob ", true);
    const sent = execute.mock.calls.map((c) => c[0]);
    expect(sent).toEqual([
      'kickuser "Bob " -r "afk"',
      'banuser "Bob " -ip -r "griefing"',
      'unbanuser "Bob "',
      'setaccesslevel "Bob " "admin"',
      'removeuserfromwhitelist "Bob "',
      'voiceban "Bob " -true',
    ]);
    for (const cmd of sent) {
      expect(cmd).not.toMatch(/"Bob"/);
    }
  });

  it("banPlayer, unbanPlayer and setAccessLevel keep a leading space too", async () => {
    const { rcon, execute } = makeRcon();
    await rcon.banPlayer(" Bob");
    await rcon.unbanPlayer(" Bob");
    await rcon.setAccessLevel(" Bob", "moderator");
    expect(execute.mock.calls.map((c) => c[0])).toEqual([
      'banuser " Bob"',
      'unbanuser " Bob"',
      'setaccesslevel " Bob" "moderator"',
    ]);
  });

  it("a name made only of spaces is refused before anything is sent", async () => {
    const { rcon, execute } = makeRcon();
    await expect(rcon.kickPlayer("   ")).rejects.toThrow("Username is required");
    await expect(rcon.unbanPlayer("")).rejects.toThrow("Username is required");
    expect(execute).not.toHaveBeenCalled();
  });

  it("quote injection through a padded name is still refused", async () => {
    const { rcon, execute } = makeRcon();
    await expect(rcon.kickPlayer(' Bob" servermsg "x')).rejects.toThrow(
      "Username contains unsupported characters",
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
