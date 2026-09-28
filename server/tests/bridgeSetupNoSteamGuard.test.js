import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";

// I8 at setup time: the game folder decides the PanelBridge delivery, so the
// setup wizard (/install) and quick setup (/quick-setup) must not create a
// profile -- or write launch scripts -- that start without Steam in a folder
// another profile gets PanelBridge for from the Steam Workshop. That launch
// would archive the shared loose file and skip its own ini: no bridge at all.
// Proven through the real route handlers, with the same harness as
// steamcmdRoutesLifecycleLockGuard.test.js (no process scan, no network).

const getServersMock = vi.fn(async () => []);

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(async () => {}),
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  getActiveServer: vi.fn(async () => null),
  getServers: (...args) => getServersMock(...args),
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

vi.mock("https", () => ({
  default: {
    get: () => {
      const req = new EventEmitter();
      req.destroy = () => {};
      queueMicrotask(() => req.emit("error", new Error("mock network unavailable")));
      return req;
    },
  },
}));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    exec: (...args) => {
      args[args.length - 1](new Error("mock exec unavailable"));
      return new EventEmitter();
    },
  };
});

const { default: router } = await import("../routes/server.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function call(routePath, body) {
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods.post);
  const stack = layer.route.stack;
  const response = createResponse();
  await stack[stack.length - 1].handle({ app: { get: () => undefined }, body }, response);
  return response;
}

let root;
let steamcmdPath;
let installPath;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-setup-nosteam-"));
  steamcmdPath = path.join(root, "steamcmd");
  installPath = path.join(root, "install");
  fs.mkdirSync(steamcmdPath, { recursive: true });
  fs.mkdirSync(installPath, { recursive: true });
  // Quick setup only proceeds on a folder that already holds server files.
  fs.writeFileSync(path.join(installPath, "StartServer64.bat"), "");
  getServersMock.mockReset().mockResolvedValue([
    { id: "workshop-home", name: "Workshop Home", installPath, isRemote: false, bridgeDelivery: "workshop" },
  ]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// minMemory: 0 is refused by a validation that runs after the guard, so a
// 400 INVALID_MIN_MEMORY proves the request got past it without starting
// any real work.
describe.each([
  ["/install", () => ({ steamcmdPath, installPath, serverName: "NewServer", minMemory: 0 })],
  ["/quick-setup", () => ({ installPath, serverName: "NewServer", minMemory: 0 })],
])("POST %s on a Steam Workshop game folder", (routePath, body) => {
  it("refuses useNoSteam with the coded 409", async () => {
    const response = await call(routePath, { ...body(), useNoSteam: true });
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_NOSTEAM_CONFLICTS_WITH_WORKSHOP_BRIDGE" }),
    );
  });

  it("lets a Steam-mode setup through", async () => {
    const response = await call(routePath, body());
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: "INVALID_MIN_MEMORY" }));
  });

  it("lets useNoSteam through on a panel-installed folder", async () => {
    getServersMock.mockResolvedValue([{ id: "local-home", installPath, isRemote: false }]);
    const response = await call(routePath, { ...body(), useNoSteam: true });
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: "INVALID_MIN_MEMORY" }));
  });
});
