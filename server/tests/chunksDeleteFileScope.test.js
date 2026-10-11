import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// POST /delete-chunks takes `file` and `source` from the client and joins them
// onto the save folder. It only rejected ".." and absolute paths, so a role
// with chunks.manage but not server.wipe (technician) could send
// { file: "players.db", source: "saveroot" } and delete players.db,
// vehicles.db or WorldDictionary.bin. `source` must now be one the scan
// emits and `file` one of the names the scan emits for that source.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
  getServers: vi.fn(),
  getSetting: vi.fn(),
}));

const { getActiveServer, getServers, getSetting } = await import("../database/init.js");
const { default: router } = await import("../routes/chunks.js");
const { describeChunkFile } = await import("../utils/chunkFiles.js");

function writeFileDeep(p, content = "x") {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function createResponse() {
  const response = {};
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

async function post(routePath, body) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods.post,
  );
  const handlers = layer.route.stack.map((s) => s.handle);
  const req = {
    user: { role: "technician" },
    body: {
      force: true,
      createBackup: false,
      deleteVehicles: false,
      expectedServerId: "server-1",
      ...body,
    },
  };
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

const SAVE_NAME = "TestSave";
let dataRoot;
let savePath;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-filescope-"));
  savePath = path.join(dataRoot, "Saves", "Multiplayer", SAVE_NAME);
  fs.mkdirSync(savePath, { recursive: true });
  getActiveServer.mockReset().mockResolvedValue({
    id: "server-1",
    zomboidDataPath: dataRoot,
    isRemote: false,
  });
  getServers.mockReset().mockResolvedValue([]);
  getSetting.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe("delete-chunks: only files the scan emits can be named", () => {
  const protectedFiles = ["players.db", "vehicles.db", "WorldDictionary.bin", "map_ver.bin", "map_t.bin"];

  function writeProtectedFiles() {
    for (const f of protectedFiles) writeFileDeep(path.join(savePath, f), "keep");
    writeFileDeep(path.join(savePath, "map", "0", "0.bin"), "chunk");
  }

  function expectProtectedFilesIntact() {
    for (const f of protectedFiles) {
      expect(fs.existsSync(path.join(savePath, f)), `${f} must not be deletable`).toBe(true);
    }
  }

  it.each(protectedFiles)("refuses %s named with source saveroot", async (file) => {
    writeProtectedFiles();
    const res = await post("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file, source: "saveroot" }],
    });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()?.code).toBe("DELETE_CHUNKS_INVALID_FILE_PATH");
    expectProtectedFilesIntact();
  });

  it.each(protectedFiles)("refuses %s named with source map, chunkdata or none", async (file) => {
    writeProtectedFiles();
    for (const source of ["map", "chunkdata", undefined]) {
      const res = await post("/delete-chunks", {
        saveName: SAVE_NAME,
        chunks: [{ file, source, x: 0, y: 0 }],
      });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()?.code).toBe("DELETE_CHUNKS_INVALID_FILE_PATH");
    }
    expectProtectedFilesIntact();
  });

  it("refuses a nested name that is not a chunk, and a chunk name under the wrong source", async () => {
    writeProtectedFiles();
    writeFileDeep(path.join(savePath, "chunkdata", "players.db"), "keep");
    writeFileDeep(path.join(savePath, "map", "sub", "players.db"), "keep");
    const attempts = [
      { file: "sub/players.db" },
      { file: "chunkdata/5_5.bin", source: "chunkdata" },
      { file: "map/0/0.bin", source: "map" },
      { file: "0/0.bin", source: "saveroot" },
      { file: "0/0.bin", source: "chunkdata" },
      { file: "map_5_5.bin", source: "chunkdata" },
      { file: "0/0.bin.bak" },
      { file: "0/0.BIN" },
      { file: "0/0.bin\n" },
    ];
    for (const attempt of attempts) {
      const res = await post("/delete-chunks", { saveName: SAVE_NAME, chunks: [attempt] });
      expect(res.getStatusCode(), JSON.stringify(attempt)).toBe(400);
    }
    expectProtectedFilesIntact();
    expect(fs.existsSync(path.join(savePath, "chunkdata", "players.db"))).toBe(true);
    expect(fs.existsSync(path.join(savePath, "map", "0", "0.bin"))).toBe(true);
  });

  it("refuses an unknown source with its own code", async () => {
    writeProtectedFiles();
    for (const source of ["root", "Saveroot", "", 5, {}]) {
      const res = await post("/delete-chunks", {
        saveName: SAVE_NAME,
        chunks: [{ file: "map_5_5.bin", source }],
      });
      expect(res.getStatusCode(), String(source)).toBe(400);
      expect(res.getBody()?.code).toBe("DELETE_CHUNKS_INVALID_SOURCE");
    }
    expectProtectedFilesIntact();
  });

  it("refuses entries that are not objects with a string file", async () => {
    writeProtectedFiles();
    for (const chunk of [null, "0/0.bin", 7, { file: 5 }, { file: ["0/0.bin"] }, { file: { a: 1 } }]) {
      const res = await post("/delete-chunks", { saveName: SAVE_NAME, chunks: [chunk] });
      expect(res.getStatusCode(), JSON.stringify(chunk)).toBe(400);
      expect(res.getBody()?.code).toBe("DELETE_CHUNKS_INVALID_FILE_NAME");
    }
    expect(fs.existsSync(path.join(savePath, "map", "0", "0.bin"))).toBe(true);
  });

  it("deletes nothing when one entry in the request is refused", async () => {
    writeProtectedFiles();
    const res = await post("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [
        { file: "0/0.bin", x: 0, y: 0 },
        { file: "players.db", source: "saveroot" },
      ],
    });
    expect(res.getStatusCode()).toBe(400);
    expect(fs.existsSync(path.join(savePath, "map", "0", "0.bin"))).toBe(true);
    expectProtectedFilesIntact();
  });

  it("still deletes every kind of file the scan emits", async () => {
    const files = {
      b42: path.join(savePath, "map", "12", "34.bin"),
      flat: path.join(savePath, "map", "5_6.bin"),
      flatPrefixed: path.join(savePath, "map", "chunk_7_8.bin"),
      saveroot: path.join(savePath, "map_9_10.bin"),
      chunkdata: path.join(savePath, "chunkdata", "3_4.bin"),
      chunkdataPrefixed: path.join(savePath, "chunkdata", "chunkdata_5_6.bin"),
      chunkdataSuffixed: path.join(savePath, "chunkdata", "7_8_2.bin"),
    };
    for (const f of Object.values(files)) writeFileDeep(f);
    writeFileDeep(path.join(savePath, "players.db"), "keep");

    const res = await post("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [
        { file: "12/34.bin", x: 12, y: 34 },
        { file: "5_6.bin", x: 5, y: 6 },
        { file: "chunk_7_8.bin", x: 7, y: 8 },
        { file: "map_9_10.bin", x: 9, y: 10, source: "saveroot" },
        { file: "3_4.bin", source: "chunkdata", x: 96, y: 128 },
        { file: "chunkdata_5_6.bin", source: "chunkdata" },
        { file: "7_8_2.bin", source: "chunkdata" },
      ],
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 7 }));
    for (const [name, f] of Object.entries(files)) {
      expect(fs.existsSync(f), `${name} should be deleted`).toBe(false);
    }
    expect(fs.existsSync(path.join(savePath, "players.db"))).toBe(true);
  });
});

describe("delete-region: takes no file names from the client", () => {
  it("only removes chunk files whatever else sits in the save folder", async () => {
    const keep = ["players.db", "vehicles.db", "WorldDictionary.bin", "map_ver.bin", "map_t.bin"];
    for (const f of keep) writeFileDeep(path.join(savePath, f), "keep");
    writeFileDeep(path.join(savePath, "map_3_3.bin"), "chunk");

    const res = await post("/delete-region", {
      saveName: SAVE_NAME,
      minX: -1000000,
      maxX: 1000000,
      minY: -1000000,
      maxY: 1000000,
    });

    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(path.join(savePath, "map_3_3.bin"))).toBe(false);
    for (const f of keep) expect(fs.existsSync(path.join(savePath, f))).toBe(true);
  });
});

describe("describeChunkFile", () => {
  it("reads the coordinates from the name", () => {
    expect(describeChunkFile(undefined, "12/34.bin")).toEqual({ source: "map", x: 12, y: 34 });
    expect(describeChunkFile("map", "chunkdata_5_6.bin")).toEqual({ source: "map", x: 5, y: 6 });
    expect(describeChunkFile("saveroot", "map_9_10.bin")).toEqual({ source: "saveroot", x: 9, y: 10 });
    expect(describeChunkFile("chunkdata", "3_4_5.bin")).toEqual({ source: "chunkdata", cellX: 3, cellY: 4 });
    expect(describeChunkFile(null, "0_0.bin")).toEqual({ source: "map", x: 0, y: 0 });
  });

  it("rejects what the scan never emits", () => {
    expect(describeChunkFile("saveroot", "players.db")).toEqual({ error: "file" });
    expect(describeChunkFile("saveroot", "0_0.bin")).toEqual({ error: "file" });
    expect(describeChunkFile("chunkdata", "../0_0.bin")).toEqual({ error: "file" });
    expect(describeChunkFile("map", "..\\0\\0.bin")).toEqual({ error: "file" });
    expect(describeChunkFile("map", "0/0/0.bin")).toEqual({ error: "file" });
    expect(describeChunkFile("map", 5)).toEqual({ error: "file" });
    expect(describeChunkFile("zpop", "0_0.bin")).toEqual({ error: "source" });
    expect(describeChunkFile("__proto__", "0_0.bin")).toEqual({ error: "source" });
  });
});
