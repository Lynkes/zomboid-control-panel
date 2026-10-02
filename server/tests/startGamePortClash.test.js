import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// startServer()'s game port check (ServerManager._findRunningGamePortClash()
// and gamePortInUseError()): a second server configured for a game port
// another RUNNING server already uses is refused with a coded error that
// names that server, in every locale.

const db = vi.hoisted(() => ({ servers: [] }));

vi.mock("../database/init.js", () => ({
  getServers: vi.fn(async () => db.servers.map((server) => ({ ...server }))),
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

const { ServerManager, gamePortInUseError } = await import("../services/serverManager.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, "..", "..", "client", "src", "locales");

const MAIN = {
  id: "main",
  name: "Main",
  serverName: "servertest",
  installPath: "/pz-server",
  zomboidDataPath: "/zomboid",
  serverPort: 16261,
  rconPort: 27015,
};
const SECOND = {
  id: "second",
  name: "Second",
  serverName: "second",
  installPath: "/pz-servers/second",
  zomboidDataPath: "/pz-servers/second_Data",
  serverPort: 16262,
  rconPort: 27016,
};
const mainProcess = {
  pid: 10,
  cmd: "/pz-server/jre64/bin/java zombie.network.GameServer -servername servertest -cachedir=/zomboid",
};

function managerFor(record) {
  const manager = new ServerManager();
  manager._serverRecord = { ...record };
  return manager;
}

afterEach(() => {
  vi.restoreAllMocks();
  db.servers = [];
});

describe("ServerManager._findRunningGamePortClash", () => {
  it("names the running server whose UDP port this one's game port lands on", async () => {
    db.servers = [MAIN, SECOND];
    vi.spyOn(ServerManager.prototype, "scanHostForServerProcesses").mockResolvedValue({
      matched: [mainProcess],
      scanFailed: false,
    });

    // Second's 16262 is Main's game port + 1.
    await expect(managerFor(SECOND)._findRunningGamePortClash()).resolves.toEqual({
      port: 16262,
      serverName: "Main",
    });
  });

  it("lets the start go on when the server sharing the port isn't running", async () => {
    db.servers = [MAIN, SECOND];
    vi.spyOn(ServerManager.prototype, "scanHostForServerProcesses").mockResolvedValue({
      matched: [],
      scanFailed: false,
    });

    await expect(managerFor(SECOND)._findRunningGamePortClash()).resolves.toBeNull();
  });

  it("skips the scan entirely when no other profile shares a port", async () => {
    db.servers = [MAIN, { ...SECOND, serverPort: 16263 }];
    const scan = vi.spyOn(ServerManager.prototype, "scanHostForServerProcesses");

    await expect(managerFor({ ...SECOND, serverPort: 16263 })._findRunningGamePortClash()).resolves.toBeNull();
    expect(scan).not.toHaveBeenCalled();
  });

  it("treats a failed scan as no answer, as the start did before", async () => {
    db.servers = [MAIN, SECOND];
    vi.spyOn(ServerManager.prototype, "scanHostForServerProcesses").mockResolvedValue({
      matched: [],
      scanFailed: true,
    });

    await expect(managerFor(SECOND)._findRunningGamePortClash()).resolves.toBeNull();
  });
});

describe("gamePortInUseError", () => {
  it("is a registered, coded refusal carrying the port and the other server's name", () => {
    const error = gamePortInUseError({ port: 16262, serverName: "Main" });
    expect(error.code).toBe(ErrorCode.SERVER_START_GAME_PORT_IN_USE);
    expect(error.params).toEqual({ port: 16262, name: "Main" });
    expect(error.message).toContain("16262");
    expect(error.message).toContain("Main");
  });

  it("has a sentence in every locale that uses both params and no other", () => {
    const { params } = gamePortInUseError({ port: 16262, serverName: "Main" });
    for (const locale of fs.readdirSync(LOCALES_DIR)) {
      const file = path.join(LOCALES_DIR, locale, "errors.json");
      if (!fs.existsSync(file)) continue;
      const template = JSON.parse(fs.readFileSync(file, "utf8"))[ErrorCode.SERVER_START_GAME_PORT_IN_USE];
      expect(template, locale).toBeTruthy();
      const names = [...template.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort();
      expect(names, locale).toEqual(Object.keys(params).sort());
    }
  });
});
