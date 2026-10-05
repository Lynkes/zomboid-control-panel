import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// PT3 (security sweep 2026-10-05, final round): a start whose server's
// folders are refused -- a data folder that no longer meets the data-folder
// rule after the update, or a config folder with no data folder -- goes
// ahead without the RCON settings ensureRconConfigured() writes into the
// server's ini, and only the panel log said so. POST /start now answers the
// refusal with the start (`folderWarning`) for the Dashboard to show.
const state = vi.hoisted(() => ({ server: null }));

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => state.server),
}));

// A container-managed start: the route's quickest path to its answer.
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: vi.fn(async () => ({ handled: true, success: true, message: "Container starting" })),
}));

const { default: router } = await import("../routes/server.js");
const { acquireLifecycleLock } = await import("../services/lifecycleCoordinator.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

function getHandler(routePath, method) {
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function makeApp() {
  const values = {
    serverManager: {},
    rconService: {
      serverStarting: false,
      connected: false,
      config: { host: "127.0.0.1", port: 27015 },
      setServerStarting: vi.fn(),
      loadConfig: vi.fn(async () => {}),
      checkPortOpen: vi.fn(async () => true),
      connect: vi.fn(async function () {
        this.connected = true;
      }),
      forceResetConnectionState: vi.fn(),
    },
    io: { emit: vi.fn() },
    discordBot: { sendEventNotification: vi.fn().mockResolvedValue() },
    checkServerStatusNow: vi.fn(async () => {}),
  };
  return { get: (key) => values[key] };
}

let root;
let realData;
let refusedData;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-start-warning-"));
  realData = path.join(root, "Zomboid");
  fs.mkdirSync(path.join(realData, "Saves", "Multiplayer", "Victim"), { recursive: true });
  fs.writeFileSync(path.join(realData, "Saves", "Multiplayer", "Victim", "map_t.bin"), "");
  refusedData = path.join(root, "someone-elses-folder");
  fs.mkdirSync(refusedData, { recursive: true });
  fs.writeFileSync(path.join(refusedData, "notes.txt"), "private");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// The route hands its lifecycle lock to the post-start RCON wait, which
// gives it back when it settles; the next start waits for that.
async function lifecycleLockReleased() {
  for (let i = 0; i < 100; i++) {
    const lock = acquireLifecycleLock("test-probe", "s1");
    if (lock) {
      lock.release();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the start never released its lifecycle lock");
}

async function start() {
  const res = createResponse();
  await getHandler("/start", "post")({ user: { role: "admin" }, app: makeApp() }, res);
  await lifecycleLockReleased();
  return res.json.mock.calls[0][0];
}

beforeEach(() => {
  state.server = { id: "s1", name: "Victim", serverName: "Victim", isRemote: false, zomboidDataPath: realData };
});

describe("POST /start answers why the RCON settings weren't written", () => {
  it("with the data folder's refusal", async () => {
    state.server.zomboidDataPath = refusedData;
    const body = await start();
    expect(body.success).toBe(true);
    expect(body.folderWarning.code).toBe(ErrorCode.ZOMBOID_DATA_FOLDER_REFUSED);
  });

  it("with the config folder's refusal when the record has no data folder", async () => {
    state.server.zomboidDataPath = null;
    state.server.serverConfigPath = path.join(realData, "Server");
    const body = await start();
    expect(body.folderWarning.code).toBe(ErrorCode.SERVER_CONFIG_PATH_OUTSIDE_DATA);
  });

  it("and with nothing extra when the folders are usable", async () => {
    const body = await start();
    expect(body.success).toBe(true);
    expect(body).not.toHaveProperty("folderWarning");
  });
});
