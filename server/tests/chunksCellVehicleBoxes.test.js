import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import initSqlJs from "sql.js";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// A chunkdata entry stands for a whole cell, and the scan positions it at the
// cell's top-left chunk. The Map Cleanup canvas keys chunks by x_y, so a
// selection rectangle over that chunk selects the chunkdata entry along with
// the map chunk. With "Delete vehicles" on, the route used to expand that
// entry to the cell's full 32x32-chunk box whatever else was in the cell, so
// vehicles in chunks nobody selected (in a cell whose map files survived) were
// deleted. The whole-cell box now applies only when no chunk of the cell is
// left on disk.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
  getServers: vi.fn(),
  getSetting: vi.fn(),
}));

const { getActiveServer, getServers, getSetting } = await import("../database/init.js");
const { default: router } = await import("../routes/chunks.js");

let sqlPromise = null;
function getSQL() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: () => path.resolve(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm"),
    });
  }
  return sqlPromise;
}

async function createVehiclesDb(dbPath, rows) {
  const SQL = await getSQL();
  const db = new SQL.Database();
  db.run(
    "CREATE TABLE vehicles (id INTEGER PRIMARY KEY AUTOINCREMENT, wx INTEGER, wy INTEGER, x FLOAT, y FLOAT, worldversion INTEGER, data BLOB)",
  );
  const stmt = db.prepare(
    "INSERT INTO vehicles (wx, wy, x, y, worldversion, data) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) stmt.run([r.wx, r.wy, r.x, r.y, 1, null]);
  stmt.free();
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

async function readVehicleNames(dbPath) {
  const SQL = await getSQL();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const stmt = db.prepare("SELECT wx, wy FROM vehicles ORDER BY id");
  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push(`${r.wx},${r.wy}`);
  }
  stmt.free();
  db.close();
  return rows;
}

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

async function postAs(routePath, body) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods.post,
  );
  const handlers = layer.route.stack.map((s) => s.handle);
  const req = {
    user: { role: "technician" },
    body: {
      force: true,
      createBackup: false,
      deleteVehicles: true,
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
let dbPath;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-cellbox-"));
  savePath = path.join(dataRoot, "Saves", "Multiplayer", SAVE_NAME);
  fs.mkdirSync(savePath, { recursive: true });
  dbPath = path.join(savePath, "vehicles.db");
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

// B42: cell (1,1) is chunks 32..63 on both axes, 8 tiles per chunk.
const vehicleInChunk = (wx, wy) => ({ wx, wy, x: wx * 8 + 3, y: wy * 8 + 3 });

describe("delete-chunks: a chunkdata entry's whole-cell vehicle box", () => {
  it("B42: a selection over the cell's corner chunk only removes the vehicles of the deleted chunks while other chunks of the cell survive", async () => {
    writeFileDeep(path.join(savePath, "map", "32", "32.bin"));
    writeFileDeep(path.join(savePath, "map", "33", "32.bin"));
    writeFileDeep(path.join(savePath, "map", "40", "40.bin")); // survives, same cell
    writeFileDeep(path.join(savePath, "chunkdata", "1_1.bin"));
    await createVehiclesDb(dbPath, [
      vehicleInChunk(32, 32), // deleted chunk
      vehicleInChunk(33, 32), // deleted chunk
      vehicleInChunk(37, 37), // same cell, not selected, no chunk file selected for it
      vehicleInChunk(40, 40), // same cell, its chunk survives
    ]);

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [
        { file: "32/32.bin", x: 32, y: 32 },
        { file: "33/32.bin", x: 33, y: 32 },
        { file: "1_1.bin", x: 32, y: 32, source: "chunkdata", cellX: 1, cellY: 1 },
      ],
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(
      expect.objectContaining({ success: true, deleted: 3, vehiclesDeleted: 2 }),
    );
    expect(fs.existsSync(path.join(savePath, "map", "40", "40.bin"))).toBe(true);
    expect(await readVehicleNames(dbPath)).toEqual(["37,37", "40,40"]);
  });

  it("B42: a chunkdata entry on its own, with the cell's map files still there, removes no vehicles", async () => {
    writeFileDeep(path.join(savePath, "map", "40", "40.bin"));
    writeFileDeep(path.join(savePath, "chunkdata", "1_1.bin"));
    await createVehiclesDb(dbPath, [vehicleInChunk(32, 32), vehicleInChunk(37, 37)]);

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "1_1.bin", x: 32, y: 32, source: "chunkdata" }],
    });

    expect(res.getBody()).toEqual(
      expect.objectContaining({ success: true, deleted: 1, vehiclesDeleted: 0 }),
    );
    expect(await readVehicleNames(dbPath)).toEqual(["32,32", "37,37"]);
  });

  it("B42: when the whole cell goes (no chunk left), the chunkdata entry still clears the whole cell's vehicles", async () => {
    writeFileDeep(path.join(savePath, "map", "32", "32.bin"));
    writeFileDeep(path.join(savePath, "map", "40", "40.bin"));
    writeFileDeep(path.join(savePath, "map", "70", "70.bin")); // another cell
    writeFileDeep(path.join(savePath, "chunkdata", "1_1.bin"));
    await createVehiclesDb(dbPath, [
      vehicleInChunk(37, 37), // inside the cell, in no deleted chunk's own box
      vehicleInChunk(63, 63), // last chunk of the cell
      vehicleInChunk(64, 64), // next cell
      vehicleInChunk(31, 31), // previous cell
    ]);

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [
        { file: "32/32.bin", x: 32, y: 32 },
        { file: "40/40.bin", x: 40, y: 40 },
        { file: "1_1.bin", x: 32, y: 32, source: "chunkdata", cellX: 1, cellY: 1 },
      ],
    });

    expect(res.getBody()).toEqual(
      expect.objectContaining({ success: true, deleted: 3, vehiclesDeleted: 2 }),
    );
    expect(await readVehicleNames(dbPath)).toEqual(["64,64", "31,31"]);
  });

  it("B42: the cell is taken from the chunkdata file name, not from the cellX/cellY the client sent", async () => {
    writeFileDeep(path.join(savePath, "chunkdata", "1_1.bin"));
    await createVehiclesDb(dbPath, [vehicleInChunk(37, 37), vehicleInChunk(5, 5)]);

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "1_1.bin", x: 0, y: 0, source: "chunkdata", cellX: 0, cellY: 0 }],
    });

    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    // Cell (1,1), as the file name says, has nothing left: its vehicles go.
    // Cell (0,0), as the request claimed, is untouched.
    expect(await readVehicleNames(dbPath)).toEqual(["5,5"]);
  });

  it("B41: another chunk of the cell on disk (flat map_X_Y.bin) keeps the cell's other vehicles", async () => {
    // B41 cell (1,1) is chunks 30..59 on both axes, 10 tiles per chunk. No
    // numeric map/ folders and no B42 indicator file, so this reads as B41.
    writeFileDeep(path.join(savePath, "map", "map_30_30.bin"));
    writeFileDeep(path.join(savePath, "map", "map_40_40.bin")); // survives
    writeFileDeep(path.join(savePath, "chunkdata", "1_1.bin"));
    await createVehiclesDb(dbPath, [
      { wx: 30, wy: 30, x: 305, y: 305 }, // deleted chunk
      { wx: 35, wy: 35, x: 355, y: 355 }, // same cell, not selected
    ]);

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [
        { file: "map_30_30.bin", x: 30, y: 30 },
        { file: "1_1.bin", x: 30, y: 30, source: "chunkdata", cellX: 1, cellY: 1 },
      ],
    });

    expect(res.getBody()).toEqual(
      expect.objectContaining({ success: true, deleted: 2, vehiclesDeleted: 1 }),
    );
    expect(await readVehicleNames(dbPath)).toEqual(["35,35"]);
  });

  it("B41: when no chunk of the cell is left, the whole cell's vehicles go", async () => {
    writeFileDeep(path.join(savePath, "map", "map_30_30.bin"));
    writeFileDeep(path.join(savePath, "map", "map_90_90.bin")); // another cell
    writeFileDeep(path.join(savePath, "chunkdata", "1_1.bin"));
    await createVehiclesDb(dbPath, [
      { wx: 35, wy: 35, x: 355, y: 355 },
      { wx: 60, wy: 60, x: 605, y: 605 }, // next cell
    ]);

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [
        { file: "map_30_30.bin", x: 30, y: 30 },
        { file: "1_1.bin", x: 30, y: 30, source: "chunkdata", cellX: 1, cellY: 1 },
      ],
    });

    expect(res.getBody()).toEqual(
      expect.objectContaining({ success: true, deleted: 2, vehiclesDeleted: 1 }),
    );
    expect(await readVehicleNames(dbPath)).toEqual(["60,60"]);
  });
});

describe("delete-region: a chunkdata entry's whole-cell vehicle box", () => {
  it("a region over the cell's corner chunk leaves the cell's other vehicles alone while map files of the cell survive outside the region", async () => {
    writeFileDeep(path.join(savePath, "map", "32", "32.bin"));
    writeFileDeep(path.join(savePath, "map", "40", "40.bin")); // outside the region
    writeFileDeep(path.join(savePath, "chunkdata", "1_1.bin"));
    await createVehiclesDb(dbPath, [vehicleInChunk(32, 32), vehicleInChunk(37, 37)]);

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 32,
      maxX: 33,
      minY: 32,
      maxY: 32,
    });

    expect(res.getBody()).toEqual(
      expect.objectContaining({ success: true, deleted: 2, vehiclesDeleted: 1 }),
    );
    expect(fs.existsSync(path.join(savePath, "map", "40", "40.bin"))).toBe(true);
    expect(await readVehicleNames(dbPath)).toEqual(["37,37"]);
  });

  it("a region that takes the whole cell clears the whole cell's vehicles", async () => {
    writeFileDeep(path.join(savePath, "map", "32", "32.bin"));
    writeFileDeep(path.join(savePath, "map", "40", "40.bin"));
    writeFileDeep(path.join(savePath, "map", "70", "70.bin")); // another cell
    writeFileDeep(path.join(savePath, "chunkdata", "1_1.bin"));
    await createVehiclesDb(dbPath, [vehicleInChunk(37, 37), vehicleInChunk(70, 70)]);

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 32,
      maxX: 63,
      minY: 32,
      maxY: 63,
    });

    expect(res.getBody()).toEqual(
      expect.objectContaining({ success: true, deleted: 3, vehiclesDeleted: 1 }),
    );
    expect(await readVehicleNames(dbPath)).toEqual(["70,70"]);
  });
});
