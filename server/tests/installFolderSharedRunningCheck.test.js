import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";

// Quick Setup reuses the active server's install folder on purpose, so two
// profiles can share one game folder. /steam-update, /install and
// /quick-setup checked only the FIRST profile with that path
// (resolveTargetServerForRunningCheck): with A stopped and B (same folder)
// running, an update on A's folder passed the running check and SteamCMD
// patched the files of the running B. Every profile using the folder is
// checked now; a running other profile is named with its own code.

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(async () => {}),
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const scanHostForServerProcesses = vi.fn();
vi.mock("../services/serverManager.js", async () => {
  const actual = await vi.importActual("../services/serverManager.js");
  return {
    ...actual,
    ServerManager: vi.fn().mockImplementation(function () {
      this.scanHostForServerProcesses = scanHostForServerProcesses;
    }),
  };
});

// No real SteamCMD: a spawned child that never finishes.
const spawnMock = vi.fn(() => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
});
vi.mock("child_process", async () => {
  const actual = await vi.importActual("child_process");
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

const { default: router } = await import("../routes/server.js");
const { getServers, getSetting } = await import("../database/init.js");
const { getActiveSteamOperations } = await import("../services/activeSteamOperations.js");

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

const io = { emit: vi.fn(), to: vi.fn() };
io.to.mockReturnValue(io);
const fakeReq = (body) => ({ app: { get: (key) => (key === "io" ? io : undefined) }, body });

let root;
let installDir;
let steamcmdDir;

const profiles = () => [
  { id: 1, name: "Alpha", installPath: installDir, serverName: "ServerA" },
  { id: 2, name: "Bravo", installPath: installDir, serverName: "ServerB" },
];
const bravoRunning = () => ({
  scanFailed: false,
  matched: [
    { pid: 222, cmd: `java zombie.network.GameServer -servername "ServerB" -cachedir="${root}/b-data"` },
  ],
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-shared-folder-"));
  installDir = path.join(root, "pz-server");
  steamcmdDir = path.join(root, "steamcmd");
  fs.mkdirSync(path.join(installDir, "jre64"), { recursive: true });
  fs.mkdirSync(steamcmdDir, { recursive: true });
  fs.writeFileSync(path.join(steamcmdDir, process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh"), "");
  getServers.mockReset().mockResolvedValue(profiles());
  getSetting.mockReset().mockImplementation(async (key) => (key === "steamcmdPath" ? steamcmdDir : null));
  scanHostForServerProcesses.mockReset().mockResolvedValue({ scanFailed: false, matched: [] });
  spawnMock.mockClear();
});

afterEach(() => {
  getActiveSteamOperations().clear();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("routes that write into a game folder check every profile using it", () => {
  it("/steam-update refuses with a named 409 while another profile on the folder runs", async () => {
    scanHostForServerProcesses.mockResolvedValue(bravoRunning());

    const response = createResponse();
    await getHandler("/steam-update")(
      fakeReq({ steamcmdPath: steamcmdDir, installPath: installDir, branch: "public" }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INSTALL_FOLDER_SHARED_SERVER_RUNNING", params: { name: "Bravo" } }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("/steam-update still starts when every profile on the folder is stopped", async () => {
    const response = createResponse();
    await getHandler("/steam-update")(
      fakeReq({ steamcmdPath: steamcmdDir, installPath: installDir, branch: "public" }),
      response,
    );

    expect(response.status).not.toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(scanHostForServerProcesses).toHaveBeenCalledTimes(2);
  });

  // Adversary pass: the running profile writes the folder differently.
  it("/steam-update finds the running profile when its path has a trailing separator", async () => {
    getServers.mockResolvedValue([
      profiles()[0],
      { ...profiles()[1], installPath: `${installDir}${path.sep}` },
    ]);
    scanHostForServerProcesses.mockResolvedValue(bravoRunning());

    const response = createResponse();
    await getHandler("/steam-update")(
      fakeReq({ steamcmdPath: steamcmdDir, installPath: installDir, branch: "public" }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INSTALL_FOLDER_SHARED_SERVER_RUNNING" }),
    );
  });

  it("/quick-setup refuses with a named 409 while another profile on the folder runs", async () => {
    scanHostForServerProcesses.mockResolvedValue(bravoRunning());

    const response = createResponse();
    await getHandler("/quick-setup")(
      fakeReq({ installPath: installDir, serverName: "ServerC" }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INSTALL_FOLDER_SHARED_SERVER_RUNNING", params: { name: "Bravo" } }),
    );
  });

  it("/install refuses with a named 409 while another profile on the folder runs", async () => {
    scanHostForServerProcesses.mockResolvedValue(bravoRunning());

    const response = createResponse();
    await getHandler("/install")(
      fakeReq({ steamcmdPath: steamcmdDir, installPath: installDir, serverName: "ServerC", branch: "public" }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INSTALL_FOLDER_SHARED_SERVER_RUNNING", params: { name: "Bravo" } }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
