import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// PATHS-1 (security sweep 2026-10-05): /install and /quick-setup
// (server.install, which technician holds) save the data folder they are
// sent -- or the <install>_Data folder beside a caller-chosen install folder
// -- and /quick-setup writes Server/<name>.ini into it on the spot. Neither
// checked it beyond "absolute, no ..", so any folder on this computer could
// become a server's data folder and get a Server folder written into it.
// Both now hold it to the rule every data-folder setter shares
// (services/zomboidDataPath.js) before doing anything. Same handler-level
// harness as quickSetupHostPathTranslation.test.js.

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  createServer: vi.fn(async (config) => ({ id: "created-1", ...config })),
  setActiveServer: vi.fn(async () => null),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
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

vi.mock("../utils/containerMountInfo.js", async () => {
  const actual = await vi.importActual("../utils/containerMountInfo.js");
  return {
    ...actual,
    inspectSelfContainerMounts: vi.fn(async () => ({ available: false, reason: "no-docker-socket" })),
  };
});

const { default: router } = await import("../routes/server.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeReq(body) {
  return { app: { get: () => ({ emit: vi.fn(), to: () => ({ emit: vi.fn() }) }) }, body };
}

let root;
let installDir;
let hostDir;
let previousSavePath;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-data-rule-install-"));
  installDir = path.join(root, "pz-server");
  fs.mkdirSync(path.join(installDir, "jre64"), { recursive: true });
  hostDir = path.join(root, "unrelated-host-dir");
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(hostDir, "private-notes.txt"), "not a PZ file\n");
  previousSavePath = process.env.PZ_SAVE_PATH;
  delete process.env.PZ_SAVE_PATH;
});

afterEach(() => {
  if (previousSavePath === undefined) delete process.env.PZ_SAVE_PATH;
  else process.env.PZ_SAVE_PATH = previousSavePath;
  fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("POST /quick-setup", () => {
  it("refuses a host folder as the data folder, and writes nothing into it", async () => {
    const response = createResponse();
    await getHandler("/quick-setup")(
      fakeReq({ installPath: installDir, serverName: "TestServer", zomboidDataPath: hostDir, rconPassword: "pw" }),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe(ErrorCode.ZOMBOID_DATA_PATH_NOT_DATA_FOLDER);
    expect(fs.readdirSync(hostDir)).toEqual(["private-notes.txt"]);
  });

  it("refuses the <install>_Data default too when it already holds other files", async () => {
    const defaultData = `${installDir}_Data`;
    fs.mkdirSync(defaultData, { recursive: true });
    fs.writeFileSync(path.join(defaultData, "private-notes.txt"), "x");
    const response = createResponse();
    await getHandler("/quick-setup")(
      fakeReq({ installPath: installDir, serverName: "TestServer", rconPassword: "pw" }),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe(ErrorCode.ZOMBOID_DATA_PATH_NOT_DATA_FOLDER);
    expect(fs.existsSync(path.join(defaultData, "Server"))).toBe(false);
  });

  it("still sets up a data folder that doesn't exist yet", async () => {
    const fresh = path.join(root, "fresh-data");
    const response = createResponse();
    await getHandler("/quick-setup")(
      fakeReq({ installPath: installDir, serverName: "TestServer", zomboidDataPath: fresh, rconPassword: "pw" }),
      response,
    );
    expect(response.status).not.toHaveBeenCalledWith(400);
    expect(fs.existsSync(path.join(fresh, "Server", "TestServer.ini"))).toBe(true);
  });
});

describe("POST /install", () => {
  it("refuses a host folder as the data folder before anything else", async () => {
    // serverPort 1 would be refused further down: the data folder is judged
    // first, before SteamCMD is ever started.
    const response = createResponse();
    await getHandler("/install")(
      fakeReq({
        steamcmdPath: path.join(root, "steamcmd", "steamcmd.exe"),
        installPath: installDir,
        serverName: "TestServer",
        zomboidDataPath: hostDir,
        serverPort: 1,
      }),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe(ErrorCode.ZOMBOID_DATA_PATH_NOT_DATA_FOLDER);
  });
});
