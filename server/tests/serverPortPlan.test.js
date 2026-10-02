import { describe, expect, it } from "vitest";
import {
  collectUsedPorts,
  findPortConflicts,
  getAllInOneLayout,
  isGamePortPublished,
  parsePortRange,
  suggestFreePorts,
} from "../services/serverPortPlan.js";

const first = {
  id: "a",
  name: "Main",
  serverName: "servertest",
  installPath: "/pz-server",
  serverPort: 16261,
  rconPort: 27015,
};

describe("parsePortRange", () => {
  it("reads a range and a single port", () => {
    expect(parsePortRange("16261-16270")).toEqual({ start: 16261, end: 16270 });
    expect(parsePortRange(" 16261 ")).toEqual({ start: 16261, end: 16261 });
  });

  it("refuses anything else", () => {
    for (const value of ["", undefined, "16270-16261", "abc", "16261-", "1-2-3", "70000"]) {
      expect(parsePortRange(value)).toBeNull();
    }
  });
});

describe("getAllInOneLayout", () => {
  it("is null outside the all-in-one image", () => {
    expect(getAllInOneLayout({ PZ_EXTRA_SERVERS_PATH: "/pz-servers" })).toBeNull();
  });

  it("reads the extra-servers folder and the published range", () => {
    expect(
      getAllInOneLayout({
        PANEL_ALL_IN_ONE: "true",
        PZ_EXTRA_SERVERS_PATH: "/pz-servers",
        PZ_PUBLISHED_GAME_PORTS: "16261-16270",
      }),
    ).toEqual({ serversRoot: "/pz-servers", publishedGamePorts: { start: 16261, end: 16270 } });
  });

  it("drops a relative extra-servers folder", () => {
    expect(
      getAllInOneLayout({ PANEL_ALL_IN_ONE: "true", PZ_EXTRA_SERVERS_PATH: "pz-servers" }).serversRoot,
    ).toBeNull();
  });
});

describe("collectUsedPorts", () => {
  it("skips remote profiles and fills in the default ports of an old profile", () => {
    const used = collectUsedPorts([
      { id: "r", name: "Remote", isRemote: true, serverPort: 16261, rconPort: 27015 },
      { id: "o", name: "Old", serverName: "old", installPath: "/srv/pz" },
    ]);
    expect(used).toEqual([
      {
        id: "o",
        name: "Old",
        serverName: "old",
        installPath: "/srv/pz",
        gamePort: 16261,
        udpPort: 16262,
        rconPort: 27015,
      },
    ]);
  });
});

describe("suggestFreePorts", () => {
  it("keeps the defaults on an empty host", () => {
    expect(suggestFreePorts([])).toEqual({ gamePort: 16261, rconPort: 27015, withinPublishedRange: null });
  });

  it("moves past the ports another server already uses", () => {
    expect(suggestFreePorts(collectUsedPorts([first]))).toEqual({
      gamePort: 16263,
      rconPort: 27016,
      withinPublishedRange: null,
    });
  });

  it("needs both the game port and the next one free", () => {
    const odd = { ...first, id: "b", serverPort: 16264, rconPort: 27016 };
    expect(suggestFreePorts(collectUsedPorts([first, odd])).gamePort).toBe(16266);
  });

  it("stays inside the published range, and says so when it can't", () => {
    const range = { start: 16261, end: 16264 };
    expect(suggestFreePorts(collectUsedPorts([first]), { publishedGamePorts: range })).toMatchObject({
      gamePort: 16263,
      withinPublishedRange: true,
    });
    const second = { ...first, id: "b", serverPort: 16263, rconPort: 27016 };
    expect(suggestFreePorts(collectUsedPorts([first, second]), { publishedGamePorts: range })).toMatchObject({
      gamePort: 16265,
      withinPublishedRange: false,
    });
  });
});

describe("findPortConflicts", () => {
  const used = collectUsedPorts([first]);

  it("reports a shared game port, a game port landing on the UDP port, and a shared RCON port", () => {
    expect(
      findPortConflicts({ serverPort: 16261, rconPort: 27015, serverName: "second", installPath: "/pz-servers/second" }, used),
    ).toEqual([
      { kind: "game", port: 16261, serverId: "a", serverName: "Main" },
      { kind: "udp", port: 16262, serverId: "a", serverName: "Main" },
      { kind: "rcon", port: 27015, serverId: "a", serverName: "Main" },
    ]);
    expect(
      findPortConflicts({ serverPort: 16260, rconPort: 27016, serverName: "second", installPath: "/x" }, used),
    ).toEqual([{ kind: "udp", port: 16261, serverId: "a", serverName: "Main" }]);
  });

  it("is quiet for free ports and for the same server set up again", () => {
    expect(
      findPortConflicts({ serverPort: 16263, rconPort: 27016, serverName: "second", installPath: "/x" }, used),
    ).toEqual([]);
    expect(
      findPortConflicts({ serverPort: 16261, rconPort: 27015, serverName: "ServerTest", installPath: "/pz-server/" }, used),
    ).toEqual([]);
  });

  it("doesn't compare UDP game ports with the TCP RCON port", () => {
    expect(
      findPortConflicts({ serverPort: 27015, rconPort: 16261, serverName: "second", installPath: "/x" }, used),
    ).toEqual([]);
  });
});

describe("isGamePortPublished", () => {
  const range = { start: 16261, end: 16270 };

  it("needs the game port and the next one inside the range", () => {
    expect(isGamePortPublished(16261, range)).toBe(true);
    expect(isGamePortPublished(16269, range)).toBe(true);
    expect(isGamePortPublished(16270, range)).toBe(false);
    expect(isGamePortPublished(16271, range)).toBe(false);
  });

  it("knows nothing without a range", () => {
    expect(isGamePortPublished(16261, null)).toBeNull();
  });
});
