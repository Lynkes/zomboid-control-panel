import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// chunks-routes-have-no-tests (Dwight's original finding, predates tonight):
// chunks.js gates three routes on chunks.manage -- /save-path, /delete-chunks
// and /delete-region. Re-checked rather than re-derived (per the dispatch):
// delete-chunks/delete-region turned out to be fully covered by two existing
// files -- chunksRoutesCapability.test.js proves the gate on all three
// routes, chunksDeletionLogic.test.js exhaustively proves delete-chunks/
// delete-region's actual deletion behaviour (B42/B41 detection, cell-aux
// cleanup, region inversion, partial failures, vehicle pruning, the
// SERVER_STATE_UNKNOWN fail-closed guard). /save-path's gate is covered by
// the same file -- its BEHAVIOUR never was, anywhere in the suite (grepped).
// This file is that missing piece: what a request to /save-path actually
// does, not just who's allowed to send it.
//
// HARNESS CHOICE, justified in one line per the card: same runRoute
// (stitch the matched route's own two-handler stack: gate + handler)
// approach chunksDeletionLogic.test.js already established for this exact
// file, not routeRoleSweep's single-layer runner (chunks.js's gate is
// per-route, not router-level, so there's no router.use() layer to reach in
// the first place) and not a full-stack HTTP server (no auth-exemption
// coupling to prove here, unlike the thumbnail fix -- the gate is a plain
// requirePermission check already proven correct in isolation by
// chunksRoutesCapability.test.js).
//
// Real temp directories, not fs mocking -- chunks.js pulls in the logger,
// which does real fs.mkdirSync + winston file transports at module load
// time (see chunksDeletionLogic.test.js's header for the same note).

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  updateServer: vi.fn(),
  setSetting: vi.fn(),
  getRoleByName: mockGetRoleByName,
}));

const { getActiveServer, updateServer, setSetting } = await import("../database/init.js");
const { default: router } = await import("../routes/chunks.js");

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

function postSavePath(body) {
  return runRoute("/save-path", "post", { user: { role: "technician" }, body });
}

describe("POST /save-path", () => {
  let zomboidDir;

  beforeEach(() => {
    getActiveServer.mockReset();
    updateServer.mockReset().mockResolvedValue(undefined);
    setSetting.mockReset().mockResolvedValue(undefined);
    // Named with "Zomboid" so inspectZomboidPath() accepts it purely on the
    // path-marker check -- same trick chunksScan.test.js's fixtures use --
    // without needing real save-artifact files for the "valid path" cases.
    zomboidDir = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-savepath-Zomboid-"));
  });

  afterEach(() => {
    fs.rmSync(zomboidDir, { recursive: true, force: true });
  });

  describe("input validation, before any path even touches disk", () => {
    it("missing path -> 400 CHUNKS_SAVE_PATH_MISSING", async () => {
      const res = await postSavePath({});
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "CHUNKS_SAVE_PATH_MISSING" });
      expect(updateServer).not.toHaveBeenCalled();
      expect(setSetting).not.toHaveBeenCalled();
    });

    it("non-string path -> 400 CHUNKS_SAVE_PATH_MISSING, not a type coercion attempt", async () => {
      const res = await postSavePath({ path: 12345 });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "CHUNKS_SAVE_PATH_MISSING" });
    });

    it("a quote-only path collapses to empty after normalization -> 400 CHUNKS_SAVE_PATH_EMPTY, not CHUNKS_SAVE_PATH_MISSING (this exercises the validated-but-empty branch, distinct from the raw-empty check above)", async () => {
      const res = await postSavePath({ path: '""' });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "CHUNKS_SAVE_PATH_EMPTY" });
    });
  });

  describe("filesystem validation -- resolveCustomOrDefaultDataPath's rejections propagate with their own statusCode and details", () => {
    it("a path that does not exist on disk -> 400, rejection.reason 'not-found'", async () => {
      const missing = path.join(zomboidDir, "does-not-exist");
      const res = await postSavePath({ path: missing });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().rejection).toMatchObject({ reason: "not-found" });
      expect(updateServer).not.toHaveBeenCalled();
      expect(setSetting).not.toHaveBeenCalled();
    });

    it("a path that exists but is a FILE, not a directory -> 400, rejection.reason 'not-a-directory'", async () => {
      const filePath = path.join(zomboidDir, "not-a-dir.txt");
      fs.writeFileSync(filePath, "x");
      const res = await postSavePath({ path: filePath });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().rejection).toMatchObject({ reason: "not-a-directory" });
    });

    it("a real directory with no Zomboid markers at all -> 403 (not 400 -- distinct from the filesystem-shape rejections above), rejection.reason 'no-zomboid-markers'", async () => {
      // A plain temp dir with no "Zomboid" in its name and no save artifacts
      // inside it -- inspectZomboidPath() has nothing to accept it on.
      const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-save-folder-"));
      try {
        const res = await postSavePath({ path: plainDir });
        expect(res.getStatusCode()).toBe(403);
        expect(res.getBody().rejection).toMatchObject({ reason: "no-zomboid-markers" });
      } finally {
        fs.rmSync(plainDir, { recursive: true, force: true });
      }
    });
  });

  describe("a valid path is persisted to the right place", () => {
    it("an active server with an id -> updateServer(id, {zomboidDataPath}), never touches the legacy setting", async () => {
      getActiveServer.mockResolvedValue({ id: "srv-1", name: "Main" });
      const res = await postSavePath({ path: zomboidDir });

      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody()).toMatchObject({
        ok: true,
        target: "server",
        serverId: "srv-1",
        path: path.resolve(zomboidDir),
      });
      expect(updateServer).toHaveBeenCalledWith("srv-1", {
        zomboidDataPath: path.resolve(zomboidDir),
      });
      expect(setSetting).not.toHaveBeenCalled();
    });

    it("no active server at all -> setSetting('zomboidDataPath', ...), never calls updateServer", async () => {
      getActiveServer.mockResolvedValue(null);
      const res = await postSavePath({ path: zomboidDir });

      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody()).toMatchObject({
        ok: true,
        target: "setting",
        path: path.resolve(zomboidDir),
      });
      expect(setSetting).toHaveBeenCalledWith("zomboidDataPath", path.resolve(zomboidDir));
      expect(updateServer).not.toHaveBeenCalled();
    });

    it("an active server row that exists but has no id -> falls back to the legacy setting, same as no active server at all", async () => {
      getActiveServer.mockResolvedValue({ name: "Ghost", id: null });
      const res = await postSavePath({ path: zomboidDir });

      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody()).toMatchObject({ ok: true, target: "setting" });
      expect(setSetting).toHaveBeenCalledWith("zomboidDataPath", path.resolve(zomboidDir));
      expect(updateServer).not.toHaveBeenCalled();
    });
  });

  it("an unexpected error while persisting -> 500 with a sanitized message, not a raw stack leak", async () => {
    getActiveServer.mockResolvedValue({ id: "srv-1" });
    updateServer.mockRejectedValue(new Error("disk full: /var/lib/panel/data.db"));
    const res = await postSavePath({ path: zomboidDir });

    expect(res.getStatusCode()).toBe(500);
    expect(res.getBody().error).toBeTruthy();
  });
});
