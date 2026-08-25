import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import initSqlJs from "sql.js";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// chunksRoutesCapability.test.js proves the requirePermission gate on
// delete-chunks/delete-region. It deliberately never executes the deletion
// logic behind that gate. THIS file proves the deletion logic itself is
// correct -- that it deletes the right files and only the right files.
// These are the two routes in this app that destroy player world data
// irreversibly.
//
// Real temp directories, not fs mocking -- chunks.js pulls in the logger,
// which does real fs.mkdirSync + winston file transports at module load
// time, so mocking "fs" wholesale breaks logger import for the whole file.
// chunksBrowse.test.js already established real temp dirs as this
// codebase's answer to that; this file follows the same convention.
//
// Two things verified empirically before relying on them (see the git
// history of this file's task): chmod'ing a file read-only does NOT block
// fs.promises.unlink on this Windows/Node combination, and neither does an
// open r+ handle held in the same process -- both silently succeed. A
// directory in place of the expected file DOES reliably throw a real,
// non-ENOENT error (EPERM) on unlink, so that's what the partial-failure
// tests use to force a genuine failure deterministically.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
}));

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/chunks.js");

// ── sql.js setup for a real vehicles.db fixture ────────────────────────────
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
  for (const r of rows) {
    stmt.run([r.wx, r.wy, r.x, r.y, r.worldversion ?? 1, r.data ?? null]);
  }
  stmt.free();
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

async function readVehicleIds(dbPath) {
  const SQL = await getSQL();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const stmt = db.prepare("SELECT id, x, y, wx, wy FROM vehicles ORDER BY id");
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  db.close();
  return rows;
}

// ── fixture helpers ─────────────────────────────────────────────────────
function writeFileDeep(p, content = "x") {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function writeDirDeep(p) {
  fs.mkdirSync(p, { recursive: true });
}

// ── request/response plumbing (same shape as chunksRoutesCapability.test.js) ──
function createResponse() {
  const response = { status: () => response, json: () => response };
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

// Deliberately does NOT walk chunks.js's router.use() remote-server guard
// (unlike chunksRoutesCapability.test.js's gate-only helper, or
// permissionsRoutes.test.js's whole-stack walk) -- that middleware calls
// `next()` without returning/awaiting it, which is fine for Express's real
// callback-driven dispatch but breaks a hand-rolled recursive-next chain: an
// un-awaited next() call is a promise nobody in the chain waits on, so the
// outer await resolves as soon as that one layer's own body finishes, not
// after the real handler (which does the actual file I/O) has run to
// completion. requirePermission's gate and every handler in chunks.js
// properly `return next()` / return their own promise, so stitching just
// the matched route's own two-handler stack together is both correct and
// sufficient here -- the remote-server guard isn't what this file exists to
// prove, and getActiveServer is already fixed to isRemote:false throughout.
function getRouteHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
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

function postAs(routePath, body) {
  return runRoute(routePath, "post", {
    user: { role: "technician" },
    body: { force: true, createBackup: false, deleteVehicles: false, ...body },
  });
}

const SAVE_NAME = "TestSave";
let dataRoot;
let savePath;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-deletion-"));
  savePath = path.join(dataRoot, "Saves", "Multiplayer", SAVE_NAME);
  fs.mkdirSync(savePath, { recursive: true });
  getActiveServer.mockReset().mockResolvedValue({
    id: "server-1",
    zomboidDataPath: dataRoot,
    isRemote: false,
  });
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe("delete-chunks: files that must survive (B42)", () => {
  it("a partial cell deletion leaves the untouched sibling chunk, an unrelated cell's chunk, and the cell's aux files intact -- then finishing the cell off removes the aux files without touching the unrelated cell", async () => {
    // Cell (0,0) spans chunk coords [0,31]x[0,31] at the B42 divisor of 32.
    const chunkA = path.join(savePath, "map", "0", "0.bin"); // cell (0,0) -- deleted first
    const chunkB = path.join(savePath, "map", "0", "1.bin"); // cell (0,0) -- survives phase 1, deleted phase 2
    const chunkC = path.join(savePath, "map", "40", "5.bin"); // cell (1,0) -- must NEVER be touched
    writeFileDeep(chunkA, "a");
    writeFileDeep(chunkB, "b");
    writeFileDeep(chunkC, "c");

    const auxFiles = [
      path.join(savePath, "chunkdata", "chunkdata_0_0.bin"),
      path.join(savePath, "zpop", "zpop_0_0.bin"),
      path.join(savePath, "metagrid", "metacell_0_0.bin"),
      path.join(savePath, "apop", "apop_0_0.bin"),
    ];
    for (const f of auxFiles) writeFileDeep(f, "aux");

    // Phase 1: delete only chunk A. Cell (0,0) is NOT empty (chunk B survives
    // in it), so its aux files must survive too.
    const res1 = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
    });
    expect(res1.getStatusCode()).toBe(200);
    expect(res1.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));

    expect(fs.existsSync(chunkA)).toBe(false); // the one we asked for -- gone
    expect(fs.existsSync(chunkB)).toBe(true); // sibling in the same cell -- must survive
    expect(fs.existsSync(chunkC)).toBe(true); // different cell entirely -- must survive
    for (const f of auxFiles) {
      expect(fs.existsSync(f), `${f} should still exist -- cell (0,0) is not empty yet`).toBe(true);
    }

    // Phase 2: delete the last surviving chunk in cell (0,0). NOW the cell
    // is empty, so its aux files must be swept -- but the unrelated cell's
    // chunk must still never be touched.
    const res2 = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0/1.bin", x: 0, y: 1 }],
    });
    expect(res2.getStatusCode()).toBe(200);
    expect(res2.getBody()).toEqual(
      expect.objectContaining({ success: true, deleted: 1, cellFilesRemoved: 4 }),
    );

    expect(fs.existsSync(chunkB)).toBe(false);
    expect(fs.existsSync(chunkC)).toBe(true); // still untouched
    for (const f of auxFiles) {
      expect(fs.existsSync(f), `${f} should be gone -- cell (0,0) is now empty`).toBe(false);
    }
  });
});

describe("B42 vs B41 layout detection", () => {
  it("delete-chunks on a B41 flat save deletes the flat file and never runs B42 cell-aux cleanup on it", async () => {
    // Flat file directly inside map/ -- no numeric subdirectories, and no
    // B42 indicator files at the save root, so detectSaveIsB42Sync must
    // read this as B41.
    const flatChunk = path.join(savePath, "map", "0_0.bin");
    writeFileDeep(flatChunk, "b41");

    // A B42-shaped aux file that would be wrongly swept by
    // cleanupEmptyCellFiles if (and only if) this save were misdetected as
    // B42 -- cell math for (0,0) at the B41 divisor (30) would still cover
    // chunk (0,0), so this is a real regression trap, not a decoy.
    const spuriousAux = path.join(savePath, "chunkdata", "chunkdata_0_0.bin");
    writeFileDeep(spuriousAux, "aux");

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0_0.bin", x: 0, y: 0 }],
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(
      expect.objectContaining({ success: true, deleted: 1, cellFilesRemoved: 0 }),
    );
    expect(fs.existsSync(flatChunk)).toBe(false);
    expect(fs.existsSync(spuriousAux), "B41 saves must never run B42 cell-aux cleanup").toBe(true);
  });

  it("delete-region on a B42 save only deletes chunks inside the region (both directions of invert)", async () => {
    const inRegion = path.join(savePath, "map", "2", "2.bin"); // x=2,y=2 -- inside [0,5]x[0,5]
    const outRegionSameDir = path.join(savePath, "map", "2", "8.bin"); // x=2,y=8 -- outside
    const outRegionOtherDir = path.join(savePath, "map", "9", "9.bin"); // x=9,y=9 -- outside
    writeFileDeep(inRegion, "a");
    writeFileDeep(outRegionSameDir, "b");
    writeFileDeep(outRegionOtherDir, "c");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
      invert: false,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(inRegion)).toBe(false);
    expect(fs.existsSync(outRegionSameDir)).toBe(true);
    expect(fs.existsSync(outRegionOtherDir)).toBe(true);
  });

  it("delete-region with invert:true deletes everything OUTSIDE the region instead", async () => {
    const inRegion = path.join(savePath, "map", "2", "2.bin");
    const outRegionSameDir = path.join(savePath, "map", "2", "8.bin");
    const outRegionOtherDir = path.join(savePath, "map", "9", "9.bin");
    writeFileDeep(inRegion, "a");
    writeFileDeep(outRegionSameDir, "b");
    writeFileDeep(outRegionOtherDir, "c");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
      invert: true,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 2 }));
    expect(fs.existsSync(inRegion), "inside the region -- must survive an inverted delete").toBe(true);
    expect(fs.existsSync(outRegionSameDir)).toBe(false);
    expect(fs.existsSync(outRegionOtherDir)).toBe(false);
  });

  it("delete-region on a B41 flat save (files directly in map/, no subdirectories) uses the flat-file branch, not the B42 subdirectory scan", async () => {
    const inRegion = path.join(savePath, "map", "3_3.bin"); // x=3,y=3 -- inside [0,5]x[0,5]
    const outRegion = path.join(savePath, "map", "20_20.bin"); // outside
    writeFileDeep(inRegion, "a");
    writeFileDeep(outRegion, "b");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(inRegion)).toBe(false);
    expect(fs.existsSync(outRegion)).toBe(true);
  });
});

describe("partial failure: does the response report what actually happened?", () => {
  it("delete-chunks: an undeletable chunk is excluded from the deleted count, surfaced in errors, and left on disk -- not silently counted as gone", async () => {
    const goodChunk = path.join(savePath, "map", "0", "0.bin"); // cell (0,0) -- really deletable
    const badChunkPath = path.join(savePath, "map", "40", "0.bin"); // cell (1,0) -- forced failure
    writeFileDeep(goodChunk, "a");
    // A directory where the route expects a file is a deterministic,
    // OS-independent way to force a real (non-ENOENT) unlink failure --
    // chmod-readonly and an open r+ handle both silently failed to block
    // fs.promises.unlink when checked directly against this environment.
    writeDirDeep(badChunkPath);

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [
        { file: "0/0.bin", x: 0, y: 0 },
        { file: "40/0.bin", x: 40, y: 0 },
      ],
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    // Documenting existing behaviour, not asserting it's the ideal shape:
    // the top-level `success: true` here means "the request was processed",
    // not "everything requested was deleted" -- the honest signal is the
    // accurate `deleted` count plus a populated `errors` array, both of
    // which delete-chunks does provide.
    expect(body.success).toBe(true);
    expect(body.deleted).toBe(1);
    expect(body.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("40/0.bin")]),
    );
    expect(fs.existsSync(goodChunk)).toBe(false);
    expect(fs.existsSync(badChunkPath), "the chunk that failed to delete must still be there").toBe(true);
  });

  it("delete-region: an undeletable chunk is excluded from the deleted count, surfaced in errors, and left on disk -- fixed to match delete-chunks' shape (was previously silent; see git history)", async () => {
    const goodChunk = path.join(savePath, "map", "2", "2.bin");
    const badChunkPath = path.join(savePath, "map", "2", "3.bin");
    writeFileDeep(goodChunk, "a");
    writeDirDeep(badChunkPath);

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.success).toBe(true);
    // Both chunks matched the region and were attempted; only one actually
    // succeeded. The count correctly reflects that, and -- unlike before --
    // the second one now shows up in errors instead of only a server log.
    expect(body.deleted).toBe(1);
    expect(body.errors).toEqual(expect.arrayContaining([expect.stringContaining("2/3.bin")]));
    expect(fs.existsSync(goodChunk)).toBe(false);
    expect(fs.existsSync(badChunkPath), "the chunk that failed to delete must still be there").toBe(true);
  });

  it("delete-region: a clean delete with no failures omits errors entirely, not an empty array -- nothing in the client reads this response today (deleteRegion has zero callers), but the shape must still match delete-chunks' convention exactly", async () => {
    const onlyChunk = path.join(savePath, "map", "2", "2.bin");
    writeFileDeep(onlyChunk, "a");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.success).toBe(true);
    expect(body.deleted).toBe(1);
    // res.json() serializes through JSON.stringify in real Express, which
    // drops a key whose value is undefined entirely -- a real client never
    // sees an `errors: []` (or even an `errors` key at all) on a clean
    // delete. This harness hands back the pre-serialization object, so
    // `undefined` here is the correct, equivalent check.
    expect(body.errors).toBeUndefined();
  });
});

describe("legacy flat-file regex: anchored to reject aux-family filenames", () => {
  // Regression for the accidental unanchored tail-match on zpop_/apop_/
  // isoregiondata_-style names: (?:map_|chunkdata_|chunk_)?(\d+)_(\d+)(?:_\d+)?\.bin$
  // had no `^`, so `zpop_5_5.bin` matched via the empty alternative even
  // though "zpop_" was never one of the intended prefixes (see the comment
  // one line above the regex listing the real formats). Real zpop_/apop_
  // files never live inside map/ -- they have their own top-level sibling
  // folders -- but this pins the fix at the regex level regardless of real
  // save layout, in case anything is ever misplaced there by hand or by a
  // future bug.
  it("delete-region ignores an aux-family filename sitting in map/, even though it falls inside the requested region", async () => {
    const realChunk = path.join(savePath, "map", "3_3.bin"); // x=3,y=3 -- real B41 flat chunk
    const auxLookalike = path.join(savePath, "map", "zpop_4_4.bin"); // x=4,y=4 if matched -- must NOT be
    writeFileDeep(realChunk, "a");
    writeFileDeep(auxLookalike, "b");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 10,
      minY: 0,
      maxY: 10,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(realChunk)).toBe(false);
    expect(fs.existsSync(auxLookalike), "zpop_4_4.bin must survive -- it is not a chunk file").toBe(true);
  });
});

describe("DELETE_CHUNKS_TOO_MANY sends { count } on the wire, not just an unparameterized message", () => {
  it("reports the actual submitted chunk count when it exceeds the 100,000 cap", async () => {
    const chunks = Array.from({ length: 100001 }, (_, i) => ({
      file: `${i}/0.bin`,
      x: i,
      y: 0,
    }));
    const res = await postAs("/delete-chunks", { saveName: SAVE_NAME, chunks });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({
      code: "DELETE_CHUNKS_TOO_MANY",
      params: { count: 100001 },
    });
  });
});

describe("vehicles.db pruning", () => {
  it("deleting a chunk prunes vehicles matching it by tile coords OR by drifted chunk coords, and leaves an unrelated vehicle alone", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin"); // chunk (0,0), B42 tilesPerChunk=8 -> tile box [0,8)x[0,8)
    writeFileDeep(chunk, "a");

    const dbPath = path.join(savePath, "vehicles.db");
    await createVehiclesDb(dbPath, [
      { wx: 0, wy: 0, x: 3, y: 3 }, // tile coords land inside the deleted chunk's box -- prune
      { wx: 0, wy: 0, x: 999, y: 999 }, // tile coords drifted out, but chunk coords still match -- prune via the fallback pass
      { wx: 5, wy: 5, x: 500, y: 500 }, // neither tile nor chunk coords match -- must survive
    ]);

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
      deleteVehicles: true,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1, vehiclesDeleted: 2 }));

    const remaining = await readVehicleIds(dbPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toEqual(expect.objectContaining({ wx: 5, wy: 5 }));
  });
});

// Every test above passes force:true (postAs's default), which skips the
// running-server guard entirely -- so none of them ever exercised it. These
// do: a real serverManager.getServerProcessDetails() call can resolve
// {running:false, scanFailed:true} when the detection scan itself fails
// (timeout, PowerShell/exec error -- see serverManager.js's own comments).
// Before this fix, delete-chunks/delete-region checked only `.running`, so a
// failed scan was read as "confirmed stopped" and the delete proceeded --
// exactly the corruption scenario each handler's own comment warns about
// (mutating save files a still-running server holds open). /wipe and
// /delete-files already fail closed on this exact flag (SERVER_STATE_UNKNOWN);
// these two siblings didn't.
function postAsWithServerManager(routePath, body, serverManager) {
  return runRoute(routePath, "post", {
    user: { role: "technician" },
    app: { get: (key) => (key === "serverManager" ? serverManager : null) },
    body: { force: false, createBackup: false, deleteVehicles: false, ...body },
  });
}

describe("delete-chunks/delete-region: an undetermined server state must refuse, not be read as 'stopped'", () => {
  it("delete-chunks refuses with SERVER_STATE_UNKNOWN when the running-scan itself failed (scanFailed:true), and never touches the file", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");
    const serverManager = {
      getServerProcessDetails: async () => ({ running: false, scanFailed: true }),
    };

    const res = await postAsWithServerManager(
      "/delete-chunks",
      { saveName: SAVE_NAME, chunks: [{ file: "0/0.bin", x: 0, y: 0 }] },
      serverManager,
    );

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
    expect(fs.existsSync(chunk)).toBe(true);
  });

  it("delete-region refuses with SERVER_STATE_UNKNOWN when the running-scan itself failed (scanFailed:true), and never touches the file", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");
    const serverManager = {
      getServerProcessDetails: async () => ({ running: false, scanFailed: true }),
    };

    const res = await postAsWithServerManager(
      "/delete-region",
      { saveName: SAVE_NAME, minX: 0, maxX: 10, minY: 0, maxY: 10 },
      serverManager,
    );

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
    expect(fs.existsSync(chunk)).toBe(true);
  });

  it("delete-chunks refuses with SERVER_STATE_UNKNOWN rather than silently proceeding when the running-check itself throws", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");
    const serverManager = {
      getServerProcessDetails: async () => {
        throw new Error("boom-process-scan");
      },
    };

    const res = await postAsWithServerManager(
      "/delete-chunks",
      { saveName: SAVE_NAME, chunks: [{ file: "0/0.bin", x: 0, y: 0 }] },
      serverManager,
    );

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
    expect(fs.existsSync(chunk)).toBe(true);
  });

  it("delete-chunks still refuses on a confirmed-running server (running:true, scanFailed:false) -- unaffected by this fix", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");
    const serverManager = {
      getServerProcessDetails: async () => ({
        running: true,
        scanFailed: false,
        matched: [{ pid: "123", cmd: "java ... -servername TestSave" }],
      }),
    };

    const res = await postAsWithServerManager(
      "/delete-chunks",
      { saveName: SAVE_NAME, chunks: [{ file: "0/0.bin", x: 0, y: 0 }] },
      serverManager,
    );

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({ code: "server_running" });
    expect(fs.existsSync(chunk)).toBe(true);
  });

  it("delete-chunks proceeds normally when the scan confirms the server is stopped (running:false, scanFailed:false)", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");
    const serverManager = {
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
    };

    const res = await postAsWithServerManager(
      "/delete-chunks",
      { saveName: SAVE_NAME, chunks: [{ file: "0/0.bin", x: 0, y: 0 }] },
      serverManager,
    );

    expect(res.getStatusCode()).toBe(200);
    expect(fs.existsSync(chunk)).toBe(false);
  });
});
