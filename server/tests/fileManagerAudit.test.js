import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import express from "express";
import { makeServerTree, makeTempDir, removeDir, write } from "./helpers/fileManagerFixtures.js";

// The Server Files audit trail (spec §A9): one row per mutation, download
// and denial; file content never reaches a row or the log; denials coalesce;
// appendFileAudit never throws; rows show up in Debug › Activity as
// source=files. The rows go to the real lowdb file_audit collection (this
// test file's own temp data folder).

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  const roles = {
    admin: { name: "admin", capabilities: ["files.manage", "diagnostics.manage", "bridge.setup"] },
  };
  return {
    ...actual,
    getRoleByName: async (name) => roles[name] || null,
    getServer: async (id) => dbState.servers.find((s) => String(s.id) === String(id)) || null,
    getServers: async () => dbState.servers,
    getAllSettings: async () => dbState.settings,
    getActiveServer: async () => dbState.servers.find((s) => s.isActive) || null,
  };
});

const { default: filesRoutes } = await import("../routes/files.js");
const { default: debugRoutes } = await import("../routes/debug.js");
const { appendFileAudit, getFileAudit, getDb } = await import("../database/init.js");
const { invalidateRootCache } = await import("../services/fileManagerRoots.js");
const { _resetRunStateCacheForTests } = await import("../services/fileManagerRunState.js");
const { _resetDenialCoalescingForTests, writeAudit } = await import("../services/fileManagerAudit.js");
const service = await import("../services/fileManagerService.js");
const { onLog } = await import("../utils/logger.js");

const SENTINEL = "SENTINEL-CONTENT-7f3a9c";
let server;
let baseUrl;
let base;
let tree;
let logLines = [];
let stopLog;

async function call(method, url, { body, headers = {}, raw } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      "x-test-role": "admin",
      ...headers,
    },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text };
}

async function rows() {
  return getFileAudit({ limit: 1000 });
}

async function settle() {
  // Audit rows are written from `finally` after the response went out.
  await new Promise((resolve) => setTimeout(resolve, 30));
}

const P = "/api/files/profiles/p1";

beforeAll(async () => {
  const app = express();
  app.put("/api/files/profiles/:profileId/text", express.json({ limit: "6mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    req.user = { userId: "u1", username: "kate", role: req.get("x-test-role") || "admin" };
    next();
  });
  app.set("serverManager", { getServerProcessDetails: async () => ({ running: false, scanFailed: false }) });
  app.use("/api/files", filesRoutes);
  app.use("/api/debug", debugRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  stopLog = onLog((entry) => logLines.push(String(entry.message)));
});

afterAll(async () => {
  stopLog?.();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  base = makeTempDir();
  tree = makeServerTree(base);
  dbState.servers = [tree.profile];
  dbState.settings = {};
  invalidateRootCache();
  _resetRunStateCacheForTests();
  _resetDenialCoalescingForTests();
  service._resetPreviewsForTests();
  service._resetTransferSlotsForTests();
  const db = await getDb();
  db.data.file_audit = [];
  logLines = [];
});

afterEach(() => {
  removeDir(base);
});

describe("one row each", () => {
  it("a mutation, a failed mutation, a download and a denial each write exactly one row", async () => {
    expect((await call("POST", `${P}/mkdir`, { body: { root: "data", path: "", name: "newdir", confirm: [] } })).status).toBe(201);
    await settle();
    expect((await rows()).map((r) => [r.op, r.result])).toEqual([["files.mkdir", "ok"]]);

    expect((await call("POST", `${P}/mkdir`, { body: { root: "data", path: "", name: "newdir", confirm: [] } })).status).toBe(409);
    await settle();
    const [failed] = await rows();
    expect(failed).toMatchObject({ op: "files.mkdir", result: "failed", code: "FM_EXISTS", rootId: "data", paths: ["newdir"] });

    expect((await call("GET", `${P}/download?root=data&path=Logs%2Fserver.txt`)).status).toBe(200);
    await settle();
    expect((await rows())[0]).toMatchObject({ op: "files.download", result: "ok", bytes: 9 });

    expect((await call("GET", `${P}/text?root=data&path=backups%2Fworld-1.zip`)).status).toBe(403);
    await settle();
    const denied = (await rows())[0];
    expect(denied).toMatchObject({ op: "files.denied", result: "denied", code: "FM_PATH_PROTECTED", paths: ["backups/world-1.zip"] });
    expect(denied.actor).toMatchObject({ userId: "u1", username: "kate", role: "admin" });
    expect(await rows()).toHaveLength(4);

    // Listing and viewing aren't audited.
    await call("GET", `${P}/list?root=data&path=`);
    await call("GET", `${P}/text?root=data&path=Logs%2Fserver.txt`);
    await settle();
    expect(await rows()).toHaveLength(4);
  });

  it("file content never reaches a row or the log", async () => {
    const created = await call("PUT", `${P}/text`, {
      body: { root: "data", path: "Logs/secret.txt", content: `line ${SENTINEL}\n`, etag: null, eol: "lf", bom: false, confirm: [] },
    });
    expect(created.status).toBe(201);
    const uploaded = await call("POST", `${P}/upload`, {
      raw: `${SENTINEL} upload`,
      headers: { "content-type": "application/octet-stream", "x-file-root": "data", "x-file-dir": "Logs", "x-file-name": "up.txt" },
    });
    expect(uploaded.status).toBe(201);
    await call("GET", `${P}/download?root=data&path=Logs%2Fup.txt`);
    await settle();
    const all = await rows();
    expect(all.map((r) => r.op).sort()).toEqual(["files.create", "files.download", "files.upload"]);
    expect(JSON.stringify(all)).not.toContain(SENTINEL);
    expect(logLines.some((line) => line.includes("files.upload"))).toBe(true);
    expect(logLines.join("\n")).not.toContain(SENTINEL);
    expect(all.find((r) => r.op === "files.create").sha256After).toMatch(/^[0-9a-f]{64}$/);
  });

  it("denials coalesce per user, path and code for 60 s", async () => {
    for (let i = 0; i < 3; i++) await call("GET", `${P}/text?root=data&path=backups%2Fworld-1.zip`);
    await call("GET", `${P}/list?root=data&path=%2E%2E`);
    await settle();
    const denied = (await rows()).filter((r) => r.op === "files.denied");
    expect(denied.map((r) => r.code).sort()).toEqual(["FM_INVALID_PATH", "FM_PATH_PROTECTED"]);
  });

  it("control characters are stripped from paths and at most 20 are kept", async () => {
    const paths = Array.from({ length: 25 }, (_, i) => `Logs/f${i}.txt`);
    for (const p of paths) write(path.join(tree.data, p), "x");
    const preview = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths } });
    expect(preview.status).toBe(200);
    const res = await call("POST", `${P}/delete`, { body: { root: "data", previewId: preview.body.previewId, mode: "trash", confirm: [] } });
    expect(res.status).toBe(200);
    await settle();
    const row = (await rows())[0];
    expect(row.op).toBe("files.delete.trash");
    expect(row.paths).toHaveLength(20);
    expect(row.pathsTruncated).toBe(true);
    expect(row.trashIds).toHaveLength(20);

    await writeAudit({ op: "files.write", paths: ["a\u0000b\u001bc\u007fd"], actor: null });
    expect((await rows())[0].paths).toEqual(["abcd"]);
  });
});

describe("robustness", () => {
  it("appendFileAudit and writeAudit never throw", async () => {
    await expect(appendFileAudit(null)).resolves.toBeNull();
    await expect(appendFileAudit("nope")).resolves.toBeNull();
    await expect(writeAudit(null)).resolves.toBeNull();
    const circular = { op: "files.write" };
    circular.self = circular;
    await expect(writeAudit({ op: "files.write", paths: [circular] })).resolves.not.toThrow;
  });
});

describe("Debug › Activity", () => {
  it("source=files lists the rows", async () => {
    await call("POST", `${P}/mkdir`, { body: { root: "data", path: "", name: "activity", confirm: [] } });
    await settle();
    const res = await call("GET", "/api/debug/activity?source=files");
    expect(res.status).toBe(200);
    expect(res.body.entries[0]).toMatchObject({ source: "files", action: "files.mkdir", success: true, detail: "kate: data:activity" });
    const all = await call("GET", "/api/debug/activity?source=all");
    expect(all.body.entries.some((e) => e.source === "files")).toBe(true);
    expect(fs.existsSync(path.join(tree.data, "activity"))).toBe(true);
  });
});
