import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// PT1 (security sweep 2026-10-05, final round): Map Cleanup's
// delete-with-backup creates <data folder>/backups/<save>_chunks_<stamp>
// (and every missing folder above it) before it deletes anything. It did so
// in whatever data folder the active server named, so it was one more way
// for the panel to create folders in a folder that isn't a data folder. It
// creates them now only in one that meets the data-folder rule
// (services/zomboidDataPath.js), and refuses before deleting otherwise.
vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
  getServers: vi.fn(),
  getSetting: vi.fn(),
}));

const { getActiveServer, getServers, getSetting } = await import("../database/init.js");
const { default: router } = await import("../routes/chunks.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

function createResponse() {
  let statusCode = 200;
  let body = null;
  const response = {
    status: (code) => {
      statusCode = code;
      return response;
    },
    json: (payload) => {
      body = payload;
      return response;
    },
    getStatusCode: () => statusCode,
    getBody: () => body,
  };
  return response;
}

async function post(routePath, body) {
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods.post);
  const handlers = layer.route.stack.map((s) => s.handle);
  const res = createResponse();
  const req = {
    user: { role: "technician" },
    body: { force: true, createBackup: true, deleteVehicles: false, expectedServerId: "server-1", ...body },
    app: { get: () => null },
  };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

function write(file, content = "x") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

let dataRoot;
let chunk;

function useDataFolder(folder) {
  getActiveServer.mockReset().mockResolvedValue({ id: "server-1", zomboidDataPath: folder, isRemote: false });
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-mapcleanup-backup-"));
  getServers.mockReset().mockResolvedValue([]);
  getSetting.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe("Map Cleanup's delete-with-backup creates backups/ only in a data folder that passes", () => {
  it("refuses, before deleting, in a folder holding files the game doesn't keep there", async () => {
    // A world folder with chunks but no save files, next to someone's files.
    chunk = path.join(dataRoot, "Saves", "Multiplayer", "Victim", "map", "0", "0.bin");
    write(chunk, "chunk");
    write(path.join(dataRoot, "notes.txt"), "private");
    useDataFolder(dataRoot);

    for (const [route, body] of [
      ["/delete-chunks", { saveName: "Victim", chunks: [{ file: "0/0.bin", x: 0, y: 0, source: "map" }] }],
      ["/delete-region", { saveName: "Victim", minX: 0, maxX: 10, minY: 0, maxY: 10 }],
    ]) {
      const res = await post(route, body);
      expect(res.getStatusCode(), route).toBe(400);
      expect(res.getBody()?.code, route).toBe(ErrorCode.ZOMBOID_DATA_PATH_NOT_DATA_FOLDER);
      expect(fs.existsSync(path.join(dataRoot, "backups")), route).toBe(false);
      expect(fs.existsSync(chunk), route).toBe(true);
    }
  });

  it("still backs up and deletes in a real one", async () => {
    const world = path.join(dataRoot, "Saves", "Multiplayer", "Victim");
    chunk = path.join(world, "map", "0", "0.bin");
    write(chunk, "chunk");
    write(path.join(world, "map_t.bin"), "t");
    write(path.join(dataRoot, "notes.txt"), "the operator's own");
    useDataFolder(dataRoot);

    const res = await post("/delete-chunks", {
      saveName: "Victim",
      chunks: [{ file: "0/0.bin", x: 0, y: 0, source: "map" }],
    });
    expect(res.getStatusCode()).toBe(200);
    expect(fs.existsSync(chunk)).toBe(false);
    expect(fs.readdirSync(path.join(dataRoot, "backups")).some((name) => name.startsWith("Victim_chunks_"))).toBe(true);
  });
});
