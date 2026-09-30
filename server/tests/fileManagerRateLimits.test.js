import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import rateLimit from "express-rate-limit";
import { makeServerTree, makeTempDir, removeDir, write } from "./helpers/fileManagerFixtures.js";

// Server Files behind the rate limiters exactly as server/index.js mounts
// them (the source block is lifted out of index.js and run against a test
// app, so an edit there changes this test), and index.js's HTTP servers:
// deleting files one at a time must not use up the budget of server
// Start/Stop/Restart, Undo of a bulk delete is one request, and an upload
// that takes longer than Node's 5-minute default isn't cut off (while every
// other request still is).

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  const roles = { admin: { name: "admin", capabilities: ["files.manage", "bridge.setup"] } };
  return {
    ...actual,
    getRoleByName: async (name) => roles[name] || null,
    getServer: async (id) => dbState.servers.find((s) => String(s.id) === String(id)) || null,
    getServers: async () => dbState.servers,
    getAllSettings: async () => dbState.settings,
    getActiveServer: async () => dbState.servers.find((s) => s.isActive) || null,
  };
});

const { ErrorCode } = await import("../utils/errorCodes.js");
const { default: filesRoutes, FILE_UPLOAD_REQUEST_TIMEOUT_MS } = await import("../routes/files.js");
const { PANEL_SERVER_TIMEOUTS, installRequestBodyDeadline } = await import("../utils/requestBodyDeadline.js");
const { invalidateRootCache } = await import("../services/fileManagerRoots.js");
const { _resetRunStateCacheForTests } = await import("../services/fileManagerRunState.js");
const service = await import("../services/fileManagerService.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

function lift(startMarker, endMarker) {
  const start = indexSource.indexOf(startMarker);
  const end = indexSource.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`marker not found in index.js: ${startMarker} / ${endMarker}`);
  return indexSource.slice(start, end + endMarker.length);
}
const limiterBlock = lift("const strictLimiter = rateLimit({", 'app.post("/api/files/profiles/:profileId/zip", fmTransferLimiter);');

let server;
let baseUrl;
let base;
let tree;
const P = "/api/files/profiles/p1";

async function call(method, url, body) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { "content-type": "application/json", "x-test-role": "admin", "x-test-user": "u1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed };
}

beforeEach(async () => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    if (req.get("x-test-role")) req.user = { userId: req.get("x-test-user"), username: "kate", role: req.get("x-test-role") };
    next();
  });
  new Function("app", "rateLimit", "ErrorCode", limiterBlock)(app, rateLimit, ErrorCode);
  // The dashboard's Restart button.
  app.post("/api/server/restart", (_req, res) => res.json({ success: true }));
  app.set("serverManager", { getServerProcessDetails: async () => ({ running: false, scanFailed: false, matched: [], owned: [] }) });
  app.use("/api/files", filesRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  base = makeTempDir();
  tree = makeServerTree(base);
  dbState.servers = [tree.profile];
  invalidateRootCache();
  _resetRunStateCacheForTests();
  service._resetPreviewsForTests();
  service._resetTransferSlotsForTests();
});

afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  removeDir(base);
});

async function trashDelete(paths) {
  const preview = await call("POST", `${P}/delete/preview`, { root: "data", paths });
  if (preview.status !== 200) return preview;
  return call("POST", `${P}/delete`, { root: "data", previewId: preview.body.previewId, mode: "trash", confirm: preview.body.required });
}

describe("Server Files deletes have their own rate limit", () => {
  it("ten deletes one at a time leave Restart server alone", async () => {
    for (let i = 0; i < 12; i++) write(path.join(tree.data, "Logs", `old-${i}.txt`), "x");
    for (let i = 0; i < 10; i++) expect((await trashDelete([`Logs/old-${i}.txt`])).status).toBe(200);
    expect((await call("POST", "/api/server/restart")).status).toBe(200);
  });

  it("past the limit, a delete is refused with FM_RATE_LIMITED like the other file limiters", async () => {
    let refused = null;
    for (let i = 0; i < 40 && !refused; i++) {
      const res = await call("POST", `${P}/delete`, { root: "data", previewId: "0".repeat(32), mode: "trash", confirm: [] });
      if (res.status === 429) refused = res;
    }
    expect(refused?.body?.code).toBe(ErrorCode.FM_RATE_LIMITED);
  });
});

describe("a folder upload", () => {
  // Live QA: the per-file uploads shared the 120/min transfer bucket with
  // the preflight, downloads and zips, so a folder upload paused at its
  // 120th file (a 1000-file upload waited about 8 minutes), though spec §A7
  // has pauses start above about 250 files (the global apiLimiter).
  async function uploadOne(name) {
    const res = await fetch(`${baseUrl}${P}/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-test-role": "admin",
        "x-test-user": "u1",
        "x-file-root": "data",
        "x-file-dir": "Logs",
        "x-file-name": name,
      },
      body: "x",
    });
    const text = await res.text();
    return { status: res.status, retryAfter: res.headers.get("retry-after"), body: text ? JSON.parse(text) : null };
  }

  it("sends 250 files in a minute without a pause, and leaves downloads their own bucket", async () => {
    const files = Array.from({ length: 250 }, (_, i) => ({ relPath: `f${i}.txt`, size: 1 }));
    expect((await call("POST", `${P}/upload/preflight`, { root: "data", dir: "Logs", files })).status).toBe(200);
    const statuses = [];
    // Two at a time, like the client.
    for (let i = 0; i < 250; i += 2) {
      const pair = await Promise.all([uploadOne(`f${i}.txt`), uploadOne(`f${i + 1}.txt`)]);
      statuses.push(...pair.map((r) => r.status));
    }
    expect(statuses.filter((s) => s !== 201)).toEqual([]);
    const over = await uploadOne("f250.txt");
    expect(over.status).toBe(429);
    expect(over.body.code).toBe(ErrorCode.FM_RATE_LIMITED);
    expect(Number(over.retryAfter)).toBeGreaterThan(0);
    const download = await fetch(`${baseUrl}${P}/download?root=data&path=Logs/f0.txt`, { headers: { "x-test-role": "admin", "x-test-user": "u1" } });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("x");
  }, 60000);
});

describe("Undo of a bulk delete", () => {
  it("restores 100 items in one request, within the mutation limit", async () => {
    const paths = [];
    for (let i = 0; i < 100; i++) {
      write(path.join(tree.data, "Logs", "bulk", `f${i}.txt`), `${i}`);
      paths.push(`Logs/bulk/f${i}.txt`);
    }
    const deleted = await trashDelete(paths);
    expect(deleted.status).toBe(200);
    const restore = await call("POST", `${P}/trash/restore`, {
      root: "data",
      trashIds: deleted.body.trashed.map((item) => item.trashId),
      confirm: [],
    });
    expect(restore.status).toBe(200);
    expect(restore.body.restored).toHaveLength(100);
    expect(restore.body.failed).toEqual([]);
    expect(fs.readdirSync(path.join(tree.data, "Logs", "bulk"))).toHaveLength(100);
  });
});

describe("index.js's HTTP servers", () => {
  it("time each request's arrival themselves: Node's one server-wide requestTimeout is off, headersTimeout kept", () => {
    expect(FILE_UPLOAD_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    const code = indexSource.replace(/\/\/[^\n]*/g, "");
    // Given where each server is created, so none escapes it.
    expect(code).toMatch(/const httpServer = installRequestBodyDeadline\(createServer\(PANEL_SERVER_TIMEOUTS, app\)\);/);
    expect(code).toMatch(/httpsServer = installRequestBodyDeadline\(createHttpsServer\(\{ \.\.\.certs, \.\.\.PANEL_SERVER_TIMEOUTS \}, app\)\);/);
    expect(code).not.toMatch(/createServer\(app\)|createHttpsServer\(certs, app\)|requestTimeout: FILE_UPLOAD_REQUEST_TIMEOUT_MS/);
    // With requestTimeout 0, Node's own headersTimeout default drops to 0
    // (off) as well: it has to be named.
    const s = http.createServer(PANEL_SERVER_TIMEOUTS);
    expect(s.requestTimeout).toBe(0);
    expect(s.headersTimeout).toBe(60_000);
  });

  it("an upload may stream past the deadline every other request keeps, and only an upload", async () => {
    // index.js's app shape (express.json() for everything, the limiters,
    // /api/files) with the 5-minute deadline shrunk to 1 s: each body
    // trickles for about 2 s.
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use((req, _res, next) => {
      if (req.get("x-test-role")) req.user = { userId: "u1", username: "kate", role: req.get("x-test-role") };
      next();
    });
    app.post("/api/auth/login", (_req, res) => res.json({ ok: true }));
    app.set("serverManager", { getServerProcessDetails: async () => ({ running: false, scanFailed: false, matched: [], owned: [] }) });
    app.use("/api/files", filesRoutes);
    const s = installRequestBodyDeadline(http.createServer(PANEL_SERVER_TIMEOUTS, app), { deadlineMs: 1000 });
    await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
    const trickle = (url, headers) =>
      new Promise((resolve) => {
        const req = http.request(`http://127.0.0.1:${s.address().port}${url}`, { method: "POST", headers: { "content-length": "30", ...headers } });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on("error", () => resolve("reset"));
        const parts = ['{"u":"0123', "4567890123", '45678901"}'];
        const timer = setInterval(() => {
          const part = parts.shift();
          if (parts.length === 0) {
            clearInterval(timer);
            req.end(part);
          } else req.write(part);
        }, 700);
      });
    try {
      const upload = trickle(`${P}/upload`, {
        "content-type": "application/octet-stream",
        "x-test-role": "admin",
        "x-file-root": "data",
        "x-file-dir": "",
        "x-file-name": "slow.txt",
      });
      const login = trickle("/api/auth/login", { "content-type": "application/json" });
      expect(await upload).toBe(201);
      expect(await login).not.toBe(200);
      expect(fs.readFileSync(path.join(tree.data, "slow.txt"), "utf8")).toHaveLength(30);
    } finally {
      s.closeAllConnections?.();
      await new Promise((resolve) => s.close(resolve));
    }
  }, 30000);
});
