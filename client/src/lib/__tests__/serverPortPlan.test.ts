import { describe, expect, it } from "vitest";
import type { ServerSetupPlan, UsedServerPorts } from "@/lib/api";
import {
  effectiveDataFolder,
  findDataFolderConflicts,
  findPortConflicts,
  hostIgnoresCase,
  isGamePortPublished,
  isLeftoverFolder,
  isServerSetupPlan,
  joinHostPath,
  serversRootOf,
  uniqueServerName,
  type ServersRoot,
} from "../serverPortPlan";

const main: UsedServerPorts = {
  id: "main",
  name: "Main",
  serverName: "servertest",
  installPath: "/pz-server",
  dataPath: "/zomboid",
  gamePort: 16261,
  udpPort: 16262,
  rconPort: 27015,
};

describe("findPortConflicts (client)", () => {
  it("matches the server's rules: game, UDP and RCON collisions, by protocol", () => {
    expect(
      findPortConflicts(
        { serverPort: 16261, rconPort: 27015, serverName: "second", installPath: "/pz-servers/second" },
        [main],
      ).map((conflict) => `${conflict.kind}:${conflict.port}`),
    ).toEqual(["game:16261", "udp:16262", "rcon:27015"]);
    expect(
      findPortConflicts({ serverPort: 27015, rconPort: 16261, serverName: "second", installPath: "/x" }, [main]),
    ).toEqual([]);
  });

  it("ignores the same server set up again and a port field cleared mid-edit", () => {
    expect(
      findPortConflicts({ serverPort: 16261, rconPort: 27015, serverName: "ServerTest", installPath: "/pz-server/" }, [main]),
    ).toEqual([]);
    expect(
      findPortConflicts({ serverPort: NaN, rconPort: NaN, serverName: "second", installPath: "/x" }, [main]),
    ).toEqual([]);
  });
});

describe("isGamePortPublished (client)", () => {
  it("needs both UDP ports inside the published range", () => {
    const range = { start: 16261, end: 16270 };
    expect(isGamePortPublished(16269, range)).toBe(true);
    expect(isGamePortPublished(16270, range)).toBe(false);
    expect(isGamePortPublished(NaN, range)).toBe(false);
    expect(isGamePortPublished(16261, null)).toBeNull();
  });
});

describe("uniqueServerName", () => {
  it("keeps a free name and numbers a taken one", () => {
    expect(uniqueServerName("second", [main])).toBe("second");
    expect(uniqueServerName("servertest", [main])).toBe("servertest2");
    expect(
      uniqueServerName("servertest", [main, { ...main, id: "b", serverName: "servertest2" }]),
    ).toBe("servertest3");
  });
});

describe("uniqueServerName with a root", () => {
  const root: ServersRoot = { path: "/srv", separator: "/", entries: ["pz", "servertest2_Data"], ignoreCase: false };

  it("skips a name whose folder or data folder is already in the root, or another profile's", () => {
    // A leftover servertest2_Data would hand the new server an old world.
    expect(uniqueServerName("servertest", [main], root)).toBe("servertest3");
    const other = { ...main, id: "other", serverName: "other", installPath: "/srv/servertest3", dataPath: "/data/other" };
    expect(uniqueServerName("servertest", [main, other], root)).toBe("servertest4");
    // Not a profile's name, but its folder is there.
    expect(uniqueServerName("pz", [main], root)).toBe("pz2");
  });

  it("compares folder names without case on a Windows host only", () => {
    expect(uniqueServerName("Second", [main], { ...root, entries: ["second"] })).toBe("Second");
    expect(uniqueServerName("Second", [main], { ...root, entries: ["second"], ignoreCase: true })).toBe("Second2");
  });
});

describe("isLeftoverFolder", () => {
  const root: ServersRoot = { path: "D:\\Servers", separator: "\\", entries: ["PZ", "PZ_Data", "old_Data"], ignoreCase: true };
  const windowsMain = { ...main, installPath: "D:\\Servers\\PZ", dataPath: "D:\\Servers\\PZ_Data" };

  it("is a folder already in the root that no profile uses", () => {
    expect(isLeftoverFolder("D:\\Servers\\old_Data", root, [windowsMain])).toBe(true);
    expect(isLeftoverFolder("d:/servers/OLD_DATA/", root, [windowsMain])).toBe(true);
  });

  it("is not a profile's folder, a new folder, a folder elsewhere, or anything without a root", () => {
    expect(isLeftoverFolder("D:\\Servers\\PZ_Data", root, [windowsMain])).toBe(false);
    expect(isLeftoverFolder("D:\\Servers\\second_Data", root, [windowsMain])).toBe(false);
    expect(isLeftoverFolder("E:\\old_Data", root, [windowsMain])).toBe(false);
    expect(isLeftoverFolder("D:\\Servers\\old_Data", null, [windowsMain])).toBe(false);
    expect(isLeftoverFolder("", root, [windowsMain])).toBe(false);
  });

  it("keeps case on Linux", () => {
    const linux: ServersRoot = { path: "/srv", separator: "/", entries: ["old_Data"], ignoreCase: false };
    expect(isLeftoverFolder("/srv/old_Data", linux, [main])).toBe(true);
    expect(isLeftoverFolder("/srv/OLD_DATA", linux, [main])).toBe(false);
  });
});

describe("isServerSetupPlan, hostIgnoresCase and serversRootOf", () => {
  const plan: ServerSetupPlan = {
    usedPorts: [main],
    suggestedPorts: { gamePort: 16263, rconPort: 27016, withinPublishedRange: null },
    allInOne: null,
    hostLayout: { serversRoot: "D:\\Servers", separator: "\\" },
    serversRootEntries: ["PZ"],
    environmentDataPath: null,
  };
  const allInOne = { serversRoot: "/pz-servers", publishedGamePorts: null };

  // The demo build answers every GET it doesn't mock with {success, demo}.
  it("tells a setup plan from any other answer", () => {
    expect(isServerSetupPlan(plan)).toBe(true);
    expect(isServerSetupPlan({ success: true, demo: true })).toBe(false);
    expect(isServerSetupPlan({ usedPorts: [] })).toBe(false);
    expect(isServerSetupPlan(null)).toBe(false);
    expect(isServerSetupPlan("plan")).toBe(false);
  });

  it("ignores case on a Windows host only", () => {
    expect(hostIgnoresCase(plan)).toBe(true);
    expect(hostIgnoresCase({ ...plan, hostLayout: { serversRoot: "/srv", separator: "/" } })).toBe(false);
    // The all-in-one image is Linux.
    expect(hostIgnoresCase({ ...plan, hostLayout: null, allInOne })).toBe(false);
    expect(hostIgnoresCase(null)).toBe(false);
  });

  it("picks the extra-servers volume in the all-in-one image and the install's parent elsewhere", () => {
    expect(serversRootOf(plan)).toEqual({ path: "D:\\Servers", separator: "\\", entries: ["PZ"], ignoreCase: true });
    expect(serversRootOf({ ...plan, hostLayout: null, allInOne })).toEqual({
      path: "/pz-servers",
      separator: "/",
      entries: ["PZ"],
      ignoreCase: false,
    });
    expect(serversRootOf({ ...plan, hostLayout: null, allInOne: { ...allInOne, serversRoot: null } })).toBeNull();
    expect(serversRootOf({ ...plan, hostLayout: { serversRoot: null, separator: "/" } })).toBeNull();
    expect(serversRootOf(null)).toBeNull();
  });
});

describe("joinHostPath", () => {
  it("joins with one separator, the host's", () => {
    expect(joinHostPath("/pz-servers/", "second")).toBe("/pz-servers/second");
    expect(joinHostPath("D:\\Servers", "second", "\\")).toBe("D:\\Servers\\second");
  });

  it("keeps a drive or filesystem root's single separator", () => {
    expect(joinHostPath("C:\\", "second", "\\")).toBe("C:\\second");
    expect(joinHostPath("/", "second")).toBe("/second");
  });
});

describe("effectiveDataFolder", () => {
  const env = { installPath: "/pz-server", dataPath: "/zomboid" };

  it("is the custom folder when one is set", () => {
    expect(effectiveDataFolder("/pz-server", " /data/second ", env)).toBe("/data/second");
  });

  it("is <install>_Data beside the install, without a trailing separator in between", () => {
    expect(effectiveDataFolder("D:\\Servers\\PZ\\", null, null)).toBe("D:\\Servers\\PZ_Data");
    expect(effectiveDataFolder("/srv/second", "  ", env)).toBe("/srv/second_Data");
    expect(effectiveDataFolder("", null, null)).toBe("");
  });

  // The server's path.join(dirname, basename + "_Data") for a root.
  it("keeps a drive or filesystem root's separator, like the server", () => {
    expect(effectiveDataFolder("C:\\", null, null)).toBe("C:\\_Data");
    expect(effectiveDataFolder("C:/", null, null)).toBe("C:/_Data");
    expect(effectiveDataFolder("/", null, null)).toBe("/_Data");
    expect(effectiveDataFolder("C:", null, null)).toBe("C:_Data");
  });

  it("matches PZ_SAVE_PATH's install without case on a Windows host only", () => {
    const windowsEnv = { installPath: "D:\\PZ", dataPath: "D:\\Zomboid" };
    expect(effectiveDataFolder("d:\\pz", null, windowsEnv, true)).toBe("D:\\Zomboid");
    expect(effectiveDataFolder("/PZ-server", null, env, false)).toBe("/PZ-server_Data");
  });

  it("is PZ_SAVE_PATH for the install it belongs to, or for every install when it names none", () => {
    expect(effectiveDataFolder("/pz-server/", null, env)).toBe("/zomboid");
    expect(effectiveDataFolder("/srv/second", null, { installPath: null, dataPath: "/zomboid" })).toBe("/zomboid");
  });
});

describe("findDataFolderConflicts", () => {
  it("names the profiles already using the folder, however a Windows host spells it", () => {
    const windows = { ...main, id: "win", name: "Win", installPath: "D:\\Servers\\PZ", dataPath: "D:\\Servers\\PZ_Data" };
    expect(
      findDataFolderConflicts(
        { dataPath: "d:/servers/pz_data/", serverName: "second", installPath: "D:\\Servers\\PZ" },
        [main, windows],
        true,
      ),
    ).toEqual([{ serverId: "win", serverName: "Win", path: "D:\\Servers\\PZ_Data" }]);
  });

  // Linux folders that differ by case are two folders, as the server's
  // isSameDirectory() says.
  it("tells folders that differ by case apart on Linux", () => {
    const linux = { ...main, dataPath: "/srv/PZ_Data" };
    expect(findDataFolderConflicts({ dataPath: "/srv/pz_data", serverName: "second", installPath: "/x" }, [linux])).toEqual(
      [],
    );
    expect(
      findDataFolderConflicts({ dataPath: "/srv/PZ_Data/", serverName: "second", installPath: "/x" }, [linux]),
    ).toHaveLength(1);
  });

  it("is quiet for a free folder, the same server set up again, a profile with no folder and an empty one", () => {
    expect(findDataFolderConflicts({ dataPath: "/pz-servers/second_Data", serverName: "second", installPath: "/x" }, [main])).toEqual([]);
    expect(findDataFolderConflicts({ dataPath: "/zomboid", serverName: "ServerTest", installPath: "/pz-server" }, [main])).toEqual([]);
    expect(
      findDataFolderConflicts({ dataPath: "/zomboid", serverName: "second", installPath: "/x" }, [{ ...main, dataPath: null }]),
    ).toEqual([]);
    expect(findDataFolderConflicts({ dataPath: "", serverName: "second", installPath: "/x" }, [main])).toEqual([]);
  });
});
