import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";

// "I pick Stable when installing but it still installs 42.19" (Discord,
// 2026-10-05). Since Build 42 went stable, Steam keeps a "42.19" branch for
// servers that want to stay on it. Stable sent no -beta at all, and with no
// -beta SteamCMD keeps the branch the install's appmanifest last asked for
// (UserConfig BetaKey), so a folder that was ever on "42.19" (or on
// "unstable" while that was 42.19) stayed there. Stable is now asked for by
// name, SteamCMD refreshes its app info first, and POST /install clears a
// manifest mounted on another branch the way POST /steam-update already did.
// Same child_process.spawn-mocking harness as installExitZeroErrorLine.test.js.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
}));

vi.mock("../services/serverManager.js", async () => {
  const actual = await vi.importActual("../services/serverManager.js");
  return {
    ...actual,
    ServerManager: vi.fn().mockImplementation(function () {
      this.scanHostForServerProcesses = vi.fn(async () => ({ scanFailed: false, matched: [] }));
    }),
  };
});

function createResponse() {
  const response = {};
  response.status = () => response;
  response.json = () => response;
  return response;
}

function getRouteHandler(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function fakeIoCapturingComplete() {
  let resolveComplete;
  const completePromise = new Promise((resolve) => {
    resolveComplete = resolve;
  });
  const io = {
    emit: vi.fn((event, payload) => {
      if (event === "install:complete") resolveComplete(payload);
    }),
  };
  io.to = vi.fn(() => io);
  return { io, completePromise };
}

const MANIFEST_ON_4219 = `"AppState"
{
	"appid"		"380870"
	"buildid"		"24929695"
	"UserConfig"
	{
		"BetaKey"		"42.19"
	}
	"MountedConfig"
	{
		"BetaKey"		"42.19"
	}
}
`;

describe("getBetaArgs: every branch is asked for by name", () => {
  it("names public for Stable, and passes other branches through", async () => {
    const { getBetaArgs } = await import("../routes/server.js");
    for (const stable of ["stable", "public", "", undefined, null]) {
      expect(getBetaArgs(stable)).toEqual(["-beta", "public"]);
    }
    expect(getBetaArgs("unstable")).toEqual(["-beta", "unstable"]);
    expect(getBetaArgs("42.19")).toEqual(["-beta", "42.19"]);
    expect(getBetaArgs(true)).toEqual(["-beta", "unstable"]);
  });
});

describe("POST /api/server/install: Stable installs the public branch", () => {
  let tmpRoot;
  let installPath;
  let steamcmdPath;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-stable-branch-"));
    installPath = path.join(tmpRoot, "server");
    steamcmdPath = path.join(tmpRoot, "steamcmd");
    fs.mkdirSync(installPath, { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, "data"), { recursive: true });
    fs.mkdirSync(steamcmdPath, { recursive: true });
    const steamcmdExeName = process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh";
    fs.writeFileSync(path.join(steamcmdPath, steamcmdExeName), "");
    fs.writeFileSync(path.join(installPath, "ProjectZomboid64.json"), "{}");
    spawnMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function install(branch, onSpawn) {
    spawnMock.mockImplementation((exe, args) => {
      onSpawn?.(args);
      const fakeProc = new EventEmitter();
      fakeProc.stdout = new EventEmitter();
      fakeProc.stderr = new EventEmitter();
      queueMicrotask(() => {
        fakeProc.stdout.emit("data", Buffer.from("Success! App '380870' fully installed.\n"));
        fakeProc.emit("close", 0);
      });
      return fakeProc;
    });
    const { default: router } = await import("../routes/server.js");
    const { io, completePromise } = fakeIoCapturingComplete();
    await getRouteHandler(router, "/install", "post")(
      {
        body: {
          steamcmdPath,
          installPath,
          serverName: "TestServer",
          branch,
          zomboidDataPath: path.join(tmpRoot, "data"),
          adminPassword: "adminpw",
          rconPort: 27015,
          serverPort: 16261,
          minMemory: 2,
          maxMemory: 4,
        },
        app: { get: (k) => (k === "io" ? io : undefined) },
      },
      createResponse(),
    );
    return completePromise;
  }

  it("runs SteamCMD with fresh app info and -beta public", async () => {
    let args;
    await install("public", (spawnArgs) => {
      args = spawnArgs;
    });
    const updateAt = args.indexOf("+app_update");
    expect(args.slice(updateAt, updateAt + 4)).toEqual(["+app_update", "380870", "-beta", "public"]);
    const infoAt = args.indexOf("+app_info_update");
    expect(infoAt).toBeGreaterThan(-1);
    expect(args[infoAt + 1]).toBe("1");
    expect(infoAt).toBeLessThan(updateAt);
  });

  it("moves aside a manifest left on the 42.19 branch before SteamCMD runs", async () => {
    const steamapps = path.join(installPath, "steamapps");
    fs.mkdirSync(steamapps, { recursive: true });
    const manifestPath = path.join(steamapps, "appmanifest_380870.acf");
    fs.writeFileSync(manifestPath, MANIFEST_ON_4219);

    let manifestAtSpawn;
    await install("public", () => {
      manifestAtSpawn = fs.existsSync(manifestPath);
    });

    expect(manifestAtSpawn).toBe(false);
    const backups = fs.readdirSync(steamapps).filter((name) => name.startsWith("appmanifest_380870.acf.bak-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(steamapps, backups[0]), "utf-8")).toBe(MANIFEST_ON_4219);
  });

  it("keeps the manifest of a folder already on the branch being installed", async () => {
    const steamapps = path.join(installPath, "steamapps");
    fs.mkdirSync(steamapps, { recursive: true });
    const manifestPath = path.join(steamapps, "appmanifest_380870.acf");
    fs.writeFileSync(manifestPath, MANIFEST_ON_4219);

    let manifestAtSpawn;
    let args;
    await install("42.19", (spawnArgs) => {
      manifestAtSpawn = fs.existsSync(manifestPath);
      args = spawnArgs;
    });

    expect(manifestAtSpawn).toBe(true);
    expect(args).toContain("42.19");
  });
});
