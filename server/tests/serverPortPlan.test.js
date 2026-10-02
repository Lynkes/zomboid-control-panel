import path from "path";
import { describe, expect, it } from "vitest";
import {
  collectUsedPorts,
  findPortConflicts,
  getAllInOneLayout,
  getEnvironmentDataPath,
  isGamePortPublished,
  parsePortRange,
  suggestFreePorts,
  suggestHostServersRoot,
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
        dataPath: null,
        gamePort: 16261,
        udpPort: 16262,
        rconPort: 27015,
      },
    ]);
  });

  it("lists each profile's data folder, and the game's default for a profile that names none", () => {
    const used = collectUsedPorts(
      [
        { id: "a", serverName: "a", installPath: "/srv/a", zomboidDataPath: "/srv/a_Data" },
        { id: "b", serverName: "b", installPath: "/srv/b" },
      ],
      { defaultDataPath: "/home/pz/Zomboid" },
    );
    expect(used.map((entry) => entry.dataPath)).toEqual(["/srv/a_Data", "/home/pz/Zomboid"]);
  });
});

describe("getEnvironmentDataPath", () => {
  it("is null without PZ_SAVE_PATH", () => {
    expect(getEnvironmentDataPath({ PZ_SERVER_PATH: "/pz-server" })).toBeNull();
  });

  it("ties PZ_SAVE_PATH to the PZ_SERVER_PATH install, or to every install without one", () => {
    expect(getEnvironmentDataPath({ PZ_SERVER_PATH: "/pz-server", PZ_SAVE_PATH: "/zomboid" })).toEqual({
      installPath: "/pz-server",
      dataPath: "/zomboid",
    });
    expect(getEnvironmentDataPath({ PZ_SAVE_PATH: "/zomboid" })).toEqual({ installPath: null, dataPath: "/zomboid" });
  });
});

describe("suggestHostServersRoot", () => {
  it("is the active local install's parent folder", () => {
    const servers = [
      { id: "r", isRemote: true, isActive: true, installPath: "/elsewhere/pz" },
      { id: "a", installPath: "/opt/zomboid-panel/data/pzserver" },
      { id: "b", installPath: "/srv/games/second/" },
    ];
    expect(suggestHostServersRoot(servers, path.posix)).toBe("/opt/zomboid-panel/data");
    servers[2].isActive = true;
    expect(suggestHostServersRoot(servers, path.posix)).toBe("/srv/games");
  });

  it("reads a Windows install with either separator and keeps a drive root", () => {
    expect(suggestHostServersRoot([{ installPath: "D:\\Servers\\PZ\\" }], path.win32)).toBe("D:\\Servers");
    expect(suggestHostServersRoot([{ installPath: "D:/Servers/PZ" }], path.win32)).toBe("D:\\Servers");
    expect(suggestHostServersRoot([{ installPath: "C:\\PZServer" }], path.win32)).toBe("C:\\");
  });

  // Custom launcher mode stores the launcher file as installPath: its folder
  // is the install folder, and proposing folders inside it would put the
  // new server in the active server's game files.
  it("takes a custom launcher's folder as the install folder", () => {
    expect(
      suggestHostServersRoot([{ isActive: true, installPath: "D:\\Servers\\PZ\\StartServer_Charon.bat" }], path.win32),
    ).toBe("D:\\Servers");
    expect(suggestHostServersRoot([{ installPath: "D:/Servers/PZ/ProjectZomboid64.EXE" }], path.win32)).toBe("D:\\Servers");
    expect(suggestHostServersRoot([{ isActive: true, installPath: "/opt/pz/start-server.sh" }], path.posix)).toBe("/opt");
    // A folder whose name only contains the extension is still a folder.
    expect(suggestHostServersRoot([{ installPath: "/opt/pz.sh.d/server" }], path.posix)).toBe("/opt/pz.sh.d");
  });

  it("is null without a local profile that has an absolute install folder", () => {
    expect(suggestHostServersRoot([], path.posix)).toBeNull();
    expect(suggestHostServersRoot([{ isRemote: true, installPath: "/srv/pz" }], path.posix)).toBeNull();
    expect(suggestHostServersRoot([{ installPath: "relative/pz" }], path.posix)).toBeNull();
    expect(suggestHostServersRoot([{ installPath: "" }], path.posix)).toBeNull();
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
