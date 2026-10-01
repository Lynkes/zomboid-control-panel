import { describe, expect, it } from "vitest";
import type { UsedServerPorts } from "@/lib/api";
import {
  findPortConflicts,
  isGamePortPublished,
  joinContainerPath,
  uniqueServerName,
} from "../serverPortPlan";

const main: UsedServerPorts = {
  id: "main",
  name: "Main",
  serverName: "servertest",
  installPath: "/pz-server",
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

describe("joinContainerPath", () => {
  it("joins with one slash", () => {
    expect(joinContainerPath("/pz-servers/", "second")).toBe("/pz-servers/second");
  });
});
