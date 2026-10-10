import { describe, expect, it } from "vitest";
import { scoreServerProcessOwnership } from "../services/serverManager.js";

// A process listing (pgrep -af, ps) drops argument quotes, so a server name
// with spaces reads back as several words (#223). The check that undoes that
// must not let a profile claim a longer name that merely starts with its own:
// "Survival" must not own the process of "Survival Hard", or Force Stop on one
// kills both.

describe("launch argument ownership: a name that is the prefix of another", () => {
  const survival = { serverName: "Survival" };
  const survivalHard = { serverName: "Survival Hard" };

  const quotedHard =
    'java zombie.network.GameServer -servername "Survival Hard" -cachedir="C:\\Zomboid\\Hard"';
  const unquotedHard =
    "java zombie.network.GameServer -servername Survival Hard -cachedir=/srv/zomboid/hard";
  const quotedPlain =
    'java zombie.network.GameServer -servername "Survival" -cachedir="C:\\Zomboid\\Plain"';
  const unquotedPlain =
    "java zombie.network.GameServer -servername Survival -cachedir=/srv/zomboid/plain";

  it("does not let profile 'Survival' claim the quoted process of 'Survival Hard'", () => {
    expect(scoreServerProcessOwnership(quotedHard, survival)).toBe(-1);
  });

  it("does not let profile 'Survival' claim the unquoted process of 'Survival Hard'", () => {
    expect(scoreServerProcessOwnership(unquotedHard, survival)).toBe(-1);
  });

  it("does not let profile 'Survival' claim 'Survival Hard' when it is the last argument", () => {
    expect(
      scoreServerProcessOwnership("java zombie.network.GameServer -servername Survival Hard", survival),
    ).toBe(-1);
  });

  it("still lets 'Survival Hard' claim its own process, quoted or not", () => {
    expect(scoreServerProcessOwnership(quotedHard, survivalHard)).toBeGreaterThan(0);
    expect(scoreServerProcessOwnership(unquotedHard, survivalHard)).toBeGreaterThan(0);
    expect(
      scoreServerProcessOwnership("java zombie.network.GameServer -servername Survival Hard", survivalHard),
    ).toBeGreaterThan(0);
  });

  it("does not let 'Survival Hard' claim the process of plain 'Survival'", () => {
    expect(scoreServerProcessOwnership(quotedPlain, survivalHard)).toBe(-1);
    expect(scoreServerProcessOwnership(unquotedPlain, survivalHard)).toBe(-1);
  });

  it("still lets 'Survival' claim its own process in every shape", () => {
    expect(scoreServerProcessOwnership(quotedPlain, survival)).toBeGreaterThan(0);
    expect(scoreServerProcessOwnership(unquotedPlain, survival)).toBeGreaterThan(0);
    expect(scoreServerProcessOwnership('java GameServer -servername "survival"', survival)).toBeGreaterThan(0);
    expect(scoreServerProcessOwnership("java GameServer -servername Survival", survival)).toBeGreaterThan(0);
    expect(scoreServerProcessOwnership("java GameServer -servername=Survival", survival)).toBeGreaterThan(0);
  });

  it("accepts the name followed by further launch flags, and by a closing quote", () => {
    const flags = "java GameServer -servername Survival -adminpassword x -statistic 0";
    expect(scoreServerProcessOwnership(flags, survival)).toBeGreaterThan(0);
    const multiWord = "java GameServer -servername AU-NZ Auckland PvE -adminpassword x";
    expect(scoreServerProcessOwnership(multiWord, { serverName: "AU-NZ Auckland PvE" })).toBeGreaterThan(0);
    // and not a profile named after the first word(s)
    expect(scoreServerProcessOwnership(multiWord, { serverName: "AU-NZ" })).toBe(-1);
    expect(scoreServerProcessOwnership(multiWord, { serverName: "AU-NZ Auckland" })).toBe(-1);
  });

  it("is not fooled by a longer unquoted value followed by a flag", () => {
    const cmd = "java GameServer -servername Survival Hard -adminpassword x";
    expect(scoreServerProcessOwnership(cmd, survival)).toBe(-1);
    expect(scoreServerProcessOwnership(cmd, survivalHard)).toBeGreaterThan(0);
  });
});

describe("launch argument ownership: a data folder that is the prefix of another", () => {
  it("does not let 'C:/Zomboid' claim the unquoted -cachedir of 'C:/Zomboid Data'", () => {
    const cmd = "java GameServer -cachedir=C:/Zomboid Data -servername Alpha";
    expect(scoreServerProcessOwnership(cmd, { savePath: "C:/Zomboid" })).toBe(-1);
    expect(scoreServerProcessOwnership(cmd, { savePath: "C:/Zomboid Data" })).toBeGreaterThan(0);
  });

  it("still matches an unquoted folder with spaces and a trailing separator", () => {
    const cmd = "java GameServer -cachedir=/srv/zomboid data/ -servername Alpha";
    expect(scoreServerProcessOwnership(cmd, { savePath: "/srv/zomboid data" })).toBeGreaterThan(0);
  });
});
