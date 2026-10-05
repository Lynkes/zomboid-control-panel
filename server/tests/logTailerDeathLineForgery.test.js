import { describe, expect, it } from "vitest";
import { LogTailer } from "../services/logTailer.js";

// Security sweep 2026-10-04, BRIDGE-1: the *_user.txt death parser matched
// "user <name> died at (x,y,z)" anywhere in a line. A Project Zomboid
// username may contain a newline -- ServerWorldDatabase.isValidUserName
// refuses ; @ $ , \ / . ' ? " and the NUL char, nothing else, and
// LoginPacket.parse only trim()s -- so the game's own death line for a
// player named "q\nuser Sacha" lands in the file as two lines, and the
// second one read as Sacha's death: a Discord death notice and a "death"
// entry in Sacha's player history, for someone who never died.
//
// This anchoring stops an ACCOUNT name only (isValidUserName refuses '.').
// A co-op player's name skips that check and can carry whole, timestamped,
// '.'-terminated lines -- see bridgeReportedDeathsCoopForgery.test.js for
// that case and the PanelBridge-sourced deaths that close it.
//
// Every line below is built byte-for-byte the way the 42.x jar writes it:
// IsoGameCharacter's "user " + username + " died at " +
// LoggerManager.getPlayerCoords() ("(x,y,z)") + " (non pvp)", handed to
// ZLogger.writeUnsafe, which emits "[" + dd-MM-yy HH:mm:ss.SSS + "] " + msg
// + "." and println()s it.

const TS = "04-10-26 12:00:00.000";
const NBSP = String.fromCharCode(0x00a0);
const LS = String.fromCharCode(0x2028);
const NEL = String.fromCharCode(0x0085);

function deathLine(name, { ts = TS, coords = "(10500,9800,0)", eol = "\r\n" } = {}) {
  return `[${ts}] user ${name} died at ${coords} (non pvp).${eol}`;
}

function deathsFrom(data) {
  const tailer = new LogTailer();
  const events = [];
  tailer.on("playerDeath", (d) => events.push(d));
  tailer.processUserLogData(data);
  return events;
}

describe("LogTailer user.txt death parsing can't be steered by a crafted username (BRIDGE-1)", () => {
  it("a newline in the dead player's name does not report a death for another player (the verifier's repro)", () => {
    const events = deathsFrom(deathLine("q\nuser Sacha"));
    expect(events.map((e) => e.player)).not.toContain("Sacha");
    expect(events).toEqual([]);
  });

  it("a name that also fakes a bracketed prefix doesn't get past the anchor -- `[` and `]` are legal in names", () => {
    const events = deathsFrom(deathLine("q\n[x] user Sacha"));
    expect(events).toEqual([]);
  });

  it("a lone CR in the name (not split as a line) is dropped rather than reported under a mangled name", () => {
    const events = deathsFrom(deathLine("q\ruser Sacha"));
    expect(events).toEqual([]);
  });

  it.each([
    ["NEL", NEL],
    ["U+2028", LS],
  ])("a %s in the name is dropped too", (_label, ch) => {
    expect(deathsFrom(deathLine(`q${ch}user Sacha`))).toEqual([]);
  });

  it("a no-break space at the start of the name stays part of the name (it is a different player)", () => {
    // Java's trim() only strips chars <= U+0020, so a no-break space
    // (U+00A0) + "Sacha" is a distinct, valid account. The old
    // `user\s+(.+?)` swallowed the NBSP as separator whitespace and
    // reported plain "Sacha".
    const events = deathsFrom(deathLine(`${NBSP}Sacha`));
    expect(events).toHaveLength(1);
    expect(events[0].player).toBe(`${NBSP}Sacha`);
  });

  it("a no-break space at the end of the name stays part of the name too", () => {
    const events = deathsFrom(deathLine(`Sacha${NBSP}`));
    expect(events).toHaveLength(1);
    expect(events[0].player).toBe(`Sacha${NBSP}`);
  });

  it("a death line without the game's own timestamp prefix is not a death", () => {
    expect(deathsFrom("user Sacha died at (10500,9800,0) (non pvp).\n")).toEqual([]);
    expect(deathsFrom("[x] user Sacha died at (10500,9800,0) (non pvp).\n")).toEqual([]);
  });
});

describe("LogTailer user.txt death parsing still reads every real death line", () => {
  it("parses the game's exact line (CRLF and LF endings)", () => {
    for (const eol of ["\r\n", "\n"]) {
      const events = deathsFrom(deathLine("Bob", { eol }));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        player: "Bob",
        x: 10500,
        y: 9800,
        z: 0,
        pvp: false,
        location: "10500,9800,0",
      });
    }
  });

  it("keeps spaces, brackets and other legal characters in a name", () => {
    const names = ["Bob Smith", "[TAG] Bob", "x_X-99 (alt)", "Ünïcødé 名前"];
    const events = deathsFrom(names.map((n) => deathLine(n)).join(""));
    expect(events.map((e) => e.player)).toEqual(names);
  });

  it("parses negative coordinates and the older (pvp) suffix", () => {
    const events = deathsFrom("[29-05-26 17:42:08.123] user Bob died at (-12,-34,-1) (pvp).\n");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ player: "Bob", x: -12, y: -34, z: -1, pvp: true });
  });

  it("parses a timestamp printed in a non-Latin locale's digits (SimpleDateFormat uses the host locale)", () => {
    const arabicIndic = (s) => s.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
    const events = deathsFrom(deathLine("Bob", { ts: arabicIndic(TS) }));
    expect(events.map((e) => e.player)).toEqual(["Bob"]);
  });

  it("joins a death line split across two polls", () => {
    const tailer = new LogTailer();
    const events = [];
    tailer.on("playerDeath", (d) => events.push(d));
    const line = deathLine("Bob");
    tailer.processUserLogData(line.slice(0, 20));
    expect(events).toEqual([]);
    tailer.processUserLogData(line.slice(20));
    expect(events.map((e) => e.player)).toEqual(["Bob"]);
  });

  it("ignores the joins/leaves user.txt also records", () => {
    const data = [
      `[${TS}] 76561198000000000 "Bob" fully connected (10500,9800,0).\n`,
      `[${TS}] 76561198000000000 "Bob" disconnected player (10500,9800,0).\n`,
    ].join("");
    expect(deathsFrom(data)).toEqual([]);
  });
});
