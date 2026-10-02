import { describe, expect, it } from "vitest";
import type { UsedServerPorts } from "@/lib/api";
import {
  effectiveDataFolder,
  findDataFolderConflicts,
  findPortConflicts,
  isGamePortPublished,
  joinHostPath,
  uniqueServerName,
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

  it("is PZ_SAVE_PATH for the install it belongs to, or for every install when it names none", () => {
    expect(effectiveDataFolder("/pz-server/", null, env)).toBe("/zomboid");
    expect(effectiveDataFolder("/srv/second", null, { installPath: null, dataPath: "/zomboid" })).toBe("/zomboid");
  });
});

describe("findDataFolderConflicts", () => {
  it("names the profiles already using the folder, however it is spelled", () => {
    const windows = { ...main, id: "win", name: "Win", installPath: "D:\\Servers\\PZ", dataPath: "D:\\Servers\\PZ_Data" };
    expect(
      findDataFolderConflicts({ dataPath: "d:/servers/pz_data/", serverName: "second", installPath: "D:\\Servers\\PZ" }, [
        main,
        windows,
      ]),
    ).toEqual([{ serverId: "win", serverName: "Win", path: "D:\\Servers\\PZ_Data" }]);
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
