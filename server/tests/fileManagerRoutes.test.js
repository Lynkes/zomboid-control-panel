import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import fs from "fs";
import path from "path";
import express from "express";
import unzipper from "unzipper";
import { makeServerTree, makeTempDir, removeDir, write } from "./helpers/fileManagerFixtures.js";

// /api/files over real HTTP (spec §A2, §A8, §A10): the gates in their
// order, the confirmation protocol, delete previews and jobs per user,
// bridge.setup on remote folders, .ini secrets masked on every way out and
// put back on every way in, and no-store on every response.

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  const roles = {
    admin: { name: "admin", capabilities: ["files.manage", "bridge.setup", "serverfiles.manage"] },
    filesonly: { name: "filesonly", capabilities: ["files.manage"] },
    custom: { name: "custom", capabilities: ["players.view", "serverfiles.manage", "bridge.setup"] },
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
const { invalidateRootCache } = await import("../services/fileManagerRoots.js");
const { _resetRunStateCacheForTests } = await import("../services/fileManagerRunState.js");
const { _waitForJobForTests, _resetJobsForTests } = await import("../services/fileManagerJobs.js");
const service = await import("../services/fileManagerService.js");
const { _resetDenialCoalescingForTests } = await import("../services/fileManagerAudit.js");
const { _resetZipSlotsForTests } = await import("../services/fileManagerZip.js");

let server;
let baseUrl;
let base;
let tree;
const processState = { running: false, scanFailed: false };

async function call(method, url, { role = "admin", userId = "u1", body, headers = {}, raw } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(role ? { "x-test-role": role, "x-test-user": userId } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    buffer,
    body: type.includes("application/json") && buffer.length ? JSON.parse(buffer.toString("utf8")) : null,
  };
}

const P = "/api/files/profiles/p1";

beforeAll(async () => {
  const app = express();
  app.put("/api/files/profiles/:profileId/text", express.json({ limit: "6mb" }));
  app.use(express.json({ limit: "1mb" }));
  // Stand-in for authService.middleware(): who is calling comes from headers.
  app.use((req, _res, next) => {
    if (req.get("x-test-auth-disabled")) {
      req.user = { userId: null, username: null, role: "admin", authDisabled: true };
    } else if (req.get("x-test-role")) {
      const id = req.get("x-test-user") || "u1";
      req.user = { userId: id, username: `user-${id}`, role: req.get("x-test-role") };
    }
    next();
  });
  app.set("serverManager", { getServerProcessDetails: async () => ({ ...processState, matched: [], owned: [] }) });
  app.use("/api/files", filesRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  base = makeTempDir();
  tree = makeServerTree(base);
  dbState.servers = [tree.profile];
  dbState.settings = {};
  processState.running = false;
  processState.scanFailed = false;
  invalidateRootCache();
  _resetRunStateCacheForTests();
  _resetJobsForTests();
  _resetDenialCoalescingForTests();
  _resetZipSlotsForTests();
  service._resetPreviewsForTests();
  service._resetTransferSlotsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  removeDir(base);
});

function concretePath(routePath) {
  return `/api/files${routePath.replace(":profileId", "p1").replace(":jobId", "0".repeat(32))}`;
}

describe("gates", () => {
  it("every route refuses a role without files.manage", async () => {
    const routes = filesRoutes.stack.filter((layer) => layer.route).flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) => ({ method: method.toUpperCase(), path: layer.route.path })),
    );
    expect(routes.length).toBeGreaterThanOrEqual(22);
    for (const route of routes) {
      const res = await call(route.method, concretePath(route.path), {
        role: "custom",
        body: route.method === "GET" ? undefined : {},
      });
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
      expect(res.body.code, `${route.method} ${route.path}`).toBe("PERMISSION_DENIED");
    }
  });

  it("refuses while logins are off, and a token in the URL", async () => {
    const off = await call("GET", "/api/files/profiles", { role: null, headers: { "x-test-auth-disabled": "1" } });
    expect(off.status).toBe(403);
    expect(off.body.code).toBe("FM_AUTH_DISABLED");
    const token = await call("GET", `${P}/list?root=data&path=&token=abc`);
    expect(token.status).toBe(400);
    expect(token.body.code).toBe("FM_TOKEN_IN_URL");
  });

  it("refuses a wrong content type (415) and repeated query keys (400)", async () => {
    const wrong = await call("POST", `${P}/mkdir`, { raw: "root=data", headers: { "content-type": "text/plain" } });
    expect(wrong.status).toBe(415);
    expect(wrong.body.code).toBe("FM_UNSUPPORTED_MEDIA_TYPE");
    const upload = await call("POST", `${P}/upload`, { raw: "x", headers: { "content-type": "text/plain", "x-file-root": "data", "x-file-name": "a.txt" } });
    expect(upload.status).toBe(415);
    const repeated = await call("GET", `${P}/list?root=data&path=a&path=b`);
    expect(repeated.status).toBe(400);
    expect(repeated.body).toMatchObject({ code: "FM_INVALID_REQUEST", params: { field: "path" } });
  });

  it("unknown profiles and roots", async () => {
    expect((await call("GET", "/api/files/profiles/nope/list?root=data")).body.code).toBe("FM_PROFILE_NOT_FOUND");
    expect((await call("GET", "/api/files/profiles/bad%20id/list?root=data")).body.code).toBe("FM_INVALID_REQUEST");
    const unknownRoot = await call("GET", `${P}/list?root=etc&path=`);
    expect(unknownRoot.status).toBe(404);
    expect(unknownRoot.body.code).toBe("FM_ROOT_UNKNOWN");
    dbState.servers = [{ ...tree.profile, zomboidDataPath: path.join(base, "missing") }];
    invalidateRootCache();
    const unavailable = await call("GET", `${P}/list?root=data&path=`);
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ code: "FM_ROOT_UNAVAILABLE", params: { reason: "missing" } });
  });

  it("every response is no-store, and errors never carry a path", async () => {
    const list = await call("GET", `${P}/list?root=data&path=`);
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const missing = await call("GET", `${P}/text?root=data&path=nope.txt`);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(missing.body)).not.toContain(base);
    const profiles = await call("GET", "/api/files/profiles");
    expect(profiles.headers.get("cache-control")).toBe("no-store");
    expect(profiles.body.profiles[0].roots.map((r) => r.id)).toEqual(["install", "data"]);
    expect(profiles.body.profiles[0].bookmarks.map((b) => b.kind)).toEqual(
      expect.arrayContaining(["serverSettings", "worldSave", "playerDb", "logs"]),
    );
  });
});

describe("confirmations", () => {
  it("asks once with every reason, then accepts the retry", async () => {
    processState.scanFailed = true;
    const read = await call("GET", `${P}/text?root=install&path=start-server.sh`);
    const body = { root: "install", path: "start-server.sh", content: "#!/bin/sh\necho hi\n", etag: read.body.etag, eol: "lf", bom: false, confirm: [] };
    const first = await call("PUT", `${P}/text`, { body });
    expect(first.status).toBe(409);
    expect(first.body.code).toBe("FM_CONFIRMATION_REQUIRED");
    expect(first.body.params.required).toEqual(["serverRunning", "executable"]);
    expect(first.body.details).toEqual({ serverState: "unknown", executable: { names: ["start-server.sh"] } });
    const retry = await call("PUT", `${P}/text`, { body: { ...body, confirm: first.body.params.required } });
    expect(retry.status).toBe(200);
    expect(retry.body.hints).toEqual(expect.arrayContaining(["restartToApply", "steamUpdateOverwrites"]));
  });
});

describe("delete previews and jobs", () => {
  async function preview(paths, userId = "u1") {
    const res = await call("POST", `${P}/delete/preview`, { userId, body: { root: "data", paths } });
    expect(res.status).toBe(200);
    return res.body;
  }

  it("a preview belongs to its user, expires, and goes stale when the item changes", async () => {
    write(path.join(tree.data, "Logs", "a.txt"), "a");
    const p = await preview(["Logs/a.txt"]);
    expect(p.previewId).toMatch(/^[0-9a-f]{32}$/);
    const otherUser = await call("POST", `${P}/delete`, { userId: "u2", body: { root: "data", previewId: p.previewId, mode: "trash", confirm: [] } });
    expect(otherUser.body.code).toBe("FM_PREVIEW_EXPIRED");

    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 6 * 60 * 1000);
    const expired = await call("POST", `${P}/delete`, { body: { root: "data", previewId: p.previewId, mode: "trash", confirm: [] } });
    vi.restoreAllMocks();
    expect(expired.body.code).toBe("FM_PREVIEW_EXPIRED");

    const q = await preview(["Logs/a.txt"]);
    const later = new Date(Date.now() + 5000);
    fs.writeFileSync(path.join(tree.data, "Logs", "a.txt"), "changed");
    fs.utimesSync(path.join(tree.data, "Logs", "a.txt"), later, later);
    const stale = await call("POST", `${P}/delete`, { body: { root: "data", previewId: q.previewId, mode: "trash", confirm: [] } });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("FM_PREVIEW_STALE");
  });

  it("typed confirmation must match, and only the job's owner can read it", async () => {
    write(path.join(tree.data, "Logs", "b.txt"), "b");
    write(path.join(tree.data, "Logs", "c.txt"), "c");
    const p = await preview(["Logs/b.txt", "Logs/c.txt"]);
    const mismatch = await call("POST", `${P}/delete`, {
      body: { root: "data", previewId: p.previewId, mode: "permanent", confirm: ["permanent"], typedConfirmation: "b.txt" },
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe("FM_TYPED_CONFIRMATION_MISMATCH");
    const noToken = await call("POST", `${P}/delete`, {
      body: { root: "data", previewId: p.previewId, mode: "permanent", confirm: [], typedConfirmation: "2" },
    });
    expect(noToken.body.params.required).toEqual(["permanent"]);
    const started = await call("POST", `${P}/delete`, {
      body: { root: "data", previewId: p.previewId, mode: "permanent", confirm: ["permanent"], typedConfirmation: "2" },
    });
    expect(started.status).toBe(202);
    await _waitForJobForTests(started.body.jobId);
    const notMine = await call("GET", `/api/files/jobs/${started.body.jobId}`, { userId: "u2" });
    expect(notMine.status).toBe(404);
    expect(notMine.body.code).toBe("FM_JOB_NOT_FOUND");
    const mine = await call("GET", `/api/files/jobs/${started.body.jobId}`);
    expect(mine.body).toMatchObject({ kind: "permanentDelete", state: "done" });
    expect(fs.existsSync(path.join(tree.data, "Logs", "b.txt"))).toBe(false);
  });
});

describe("remote folders", () => {
  it("need bridge.setup on top of files.manage", async () => {
    const res = await call("PUT", `${P}/remote-roots`, { role: "filesonly", body: { installPath: null, dataPath: null } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PERMISSION_DENIED");
    const admin = await call("PUT", `${P}/remote-roots`, { body: { installPath: null, dataPath: null } });
    expect(admin.body).toMatchObject({ code: "FM_ROOT_UNAVAILABLE", params: { reason: "remoteNotActive" } });
  });
});

describe(".ini secrets", () => {
  const ini = "Server/servertest.ini";

  it("are masked in the editor and put back on save", async () => {
    const read = await call("GET", `${P}/text?root=data&path=${encodeURIComponent(ini)}`);
    expect(read.body.masked).toBe(true);
    expect(read.body.hints).toEqual(expect.arrayContaining(["secretsMasked", "panelRewritesKeys"]));
    expect(read.body.content).not.toContain("hunter2secret");
    const edited = read.body.content.replace("PVP=true", "PVP=false");
    const saved = await call("PUT", `${P}/text`, {
      body: { root: "data", path: ini, content: edited, etag: read.body.etag, eol: read.body.eol, bom: read.body.bom, confirm: [] },
    });
    expect(saved.status).toBe(200);
    const onDisk = fs.readFileSync(path.join(tree.config, "servertest.ini"), "utf8");
    expect(onDisk).toBe("PVP=false\r\nRCONPassword=hunter2secret\r\nPassword=\r\n");
    const removed = await call("PUT", `${P}/text`, {
      body: { root: "data", path: ini, content: "PVP=true\n", etag: saved.body.etag, eol: "crlf", bom: false, confirm: [] },
    });
    expect(removed.status).toBe(400);
    expect(removed.body.code).toBe("RAW_INI_SECRET_LINE_REMOVED");
  });

  it("are masked in downloads and zips", async () => {
    const dl = await call("GET", `${P}/download?root=data&path=${encodeURIComponent(ini)}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("x-file-masked")).toBe("1");
    expect(dl.headers.get("content-disposition")).toContain('filename="servertest.ini"');
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(dl.buffer.toString("utf8")).not.toContain("hunter2secret");
    expect(dl.buffer.toString("utf8")).toContain("RCONPassword=");

    const zip = await call("POST", `${P}/zip`, { body: { root: "data", paths: ["Server"] } });
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    const dir = await unzipper.Open.buffer(zip.buffer);
    const entry = dir.files.find((f) => f.path === "Server/servertest.ini");
    const text = (await entry.buffer()).toString("utf8");
    expect(text).toContain("RCONPassword=");
    expect(text).not.toContain("hunter2secret");
  });

  it("are put back when a masked download is uploaded over the live file", async () => {
    const dl = await call("GET", `${P}/download?root=data&path=${encodeURIComponent(ini)}`);
    const masked = dl.buffer.toString("utf8").replace("PVP=true", "PVP=false");
    const res = await call("POST", `${P}/upload`, {
      raw: masked,
      headers: {
        "content-type": "application/octet-stream",
        "x-file-root": "data",
        "x-file-dir": "Server",
        "x-file-name": "servertest.ini",
        "x-file-overwrite-etag": dl.headers.get("x-file-etag"),
        "x-file-confirm": "overwrite",
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.replaced.trashId).toMatch(/^\d{8}T/);
    expect(fs.readFileSync(path.join(tree.config, "servertest.ini"), "utf8")).toBe(
      "PVP=false\r\nRCONPassword=hunter2secret\r\nPassword=\r\n",
    );
  });
});

describe("uploads over HTTP", () => {
  it("needs Content-Length and stays under the limit", async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${P}/upload`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "transfer-encoding": "chunked",
          "x-test-role": "admin",
          "x-file-root": "data",
          "x-file-name": "chunked.txt",
        },
      });
      req.on("response", (response) => {
        let data = "";
        response.on("data", (c) => (data += c));
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
      });
      req.on("error", reject);
      req.write("abc");
      req.end();
    });
    expect(res.status).toBe(411);
    expect(res.body.code).toBe("FM_LENGTH_REQUIRED");
  });

  it("lands a file and reports its hash", async () => {
    const res = await call("POST", `${P}/upload`, {
      raw: "hello",
      headers: { "content-type": "application/octet-stream", "x-file-root": "data", "x-file-dir": "Logs", "x-file-name": encodeURIComponent("é new.txt") },
    });
    expect(res.status).toBe(201);
    expect(res.body.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(fs.readFileSync(path.join(tree.data, "Logs", "é new.txt"), "utf8")).toBe("hello");
  });
});

describe("flows", () => {
  it("move: per-item results, never into itself", async () => {
    write(path.join(tree.data, "a", "one.txt"), "1");
    write(path.join(tree.data, "a", "inner", "x.txt"), "x");
    write(path.join(tree.data, "b", "two.txt"), "2");
    const res = await call("POST", `${P}/move`, { body: { root: "data", paths: ["a/one.txt", "a", "missing.txt"], destDir: "a/inner", confirm: [] } });
    expect(res.status).toBe(200);
    expect(res.body.moved).toEqual([{ from: "a/one.txt", to: "a/inner/one.txt" }]);
    expect(res.body.failed.map((f) => [f.path, f.code])).toEqual([
      ["a", "FM_MOVE_INTO_SELF"],
      ["missing.txt", "FM_NOT_FOUND"],
    ]);
    expect(fs.existsSync(path.join(tree.data, "a", "inner", "one.txt"))).toBe(true);
  });

  it("copy: default name, and replacing needs the overwrite token", async () => {
    const first = await call("POST", `${P}/copy`, { body: { root: "data", path: "Logs/server.txt", destDir: "Logs", confirm: [] } });
    expect(first.status).toBe(201);
    expect(first.body.entry.name).toBe("server (copy).txt");
    const again = await call("POST", `${P}/copy`, { body: { root: "data", path: "Logs/server.txt", destDir: "Logs", newName: "server (copy).txt", confirm: [] } });
    expect(again.body).toMatchObject({ code: "FM_CONFIRMATION_REQUIRED", params: { required: ["overwrite"] } });
    const replaced = await call("POST", `${P}/copy`, {
      body: { root: "data", path: "Logs/server.txt", destDir: "Logs", newName: "server (copy).txt", confirm: ["overwrite"] },
    });
    expect(replaced.status).toBe(201);
  });

  it("search: substring on names, never inside sealed or link folders", async () => {
    write(path.join(tree.data, "mods", "MyMod", "readme-servertest.txt"), "x");
    const res = await call("GET", `${P}/search?root=data&path=&q=servertest`);
    expect(res.status).toBe(200);
    const paths = res.body.results.map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(["Server/servertest.ini", "mods/MyMod/readme-servertest.txt", "db/servertest.db"]));
    expect(res.body.truncated).toBe(false);
    expect((await call("GET", `${P}/search?root=data&path=&q=a`)).body.code).toBe("FM_INVALID_REQUEST");
    const regexy = await call("GET", `${P}/search?root=data&path=&q=${encodeURIComponent(".*(a+)+$")}`);
    expect(regexy.status).toBe(200);
    expect(regexy.body.results).toEqual([]);
  });

  it("upload preflight: one answer per file and the batch's tokens", async () => {
    processState.scanFailed = true;
    const res = await call("POST", `${P}/upload/preflight`, {
      body: {
        root: "install",
        dir: "",
        files: [
          { relPath: "start-server.sh", size: 10 },
          { relPath: "new/folder/readme.txt", size: 5 },
          { relPath: "media/lua/server/PanelBridge.lua", size: 5 },
          { relPath: "bad:name.txt", size: 1 },
        ],
        confirm: [],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.required).toEqual(["serverRunning", "overwrite", "executable"]);
    const [script, nested, bridge, bad] = res.body.files;
    expect(script).toMatchObject({ ok: true, willReplace: true });
    expect(script.currentEtag).toMatch(/^s:/);
    expect(nested).toMatchObject({ ok: true, willReplace: false });
    expect(bridge).toMatchObject({ ok: false, code: "FM_PATH_PROTECTED" });
    expect(bad).toMatchObject({ ok: false, code: "FM_INVALID_NAME", params: { reason: "colon" } });
  });

  it("Trash over HTTP: list, restore, purge with a typed count", async () => {
    write(path.join(tree.data, "Logs", "t1.txt"), "1");
    write(path.join(tree.data, "Logs", "t2.txt"), "2");
    const p = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["Logs/t1.txt", "Logs/t2.txt"] } });
    const del = await call("POST", `${P}/delete`, { body: { root: "data", previewId: p.body.previewId, mode: "trash", confirm: [] } });
    expect(del.body.trashed).toHaveLength(2);
    const list = await call("GET", `${P}/trash?root=data`);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.totalBytes).toBe(2);
    const restored = await call("POST", `${P}/trash/restore`, { body: { root: "data", trashId: del.body.trashed[0].trashId } });
    expect(restored.status).toBe(200);
    expect(fs.existsSync(path.join(tree.data, "Logs", "t1.txt"))).toBe(true);
    const purge = await call("POST", `${P}/trash/purge`, { body: { root: "data", all: true, typedConfirmation: "1", confirm: ["permanent"] } });
    expect(purge.status).toBe(202);
    await _waitForJobForTests(purge.body.jobId);
    expect((await call("GET", `${P}/trash?root=data`)).body.items).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("a case-only rename works on Windows", async () => {
    const res = await call("POST", `${P}/rename`, { body: { root: "data", path: "Logs/server.txt", newName: "Server.txt", confirm: [] } });
    expect(res.status).toBe(200);
    expect(fs.readdirSync(path.join(tree.data, "Logs"))).toContain("Server.txt");
  });

  it("profile with live state, and the audit listing", async () => {
    processState.running = true;
    const profile = await call("GET", `${P}?fresh=1`);
    expect(profile.body.profile).toMatchObject({ id: "p1", serverState: "running", provider: "native", remote: null });
    await call("POST", `${P}/mkdir`, { body: { root: "data", path: "", name: "audited", confirm: [] } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const audit = await call("GET", "/api/files/audit?profileId=p1&limit=5");
    expect(audit.body.entries[0]).toMatchObject({ op: "files.mkdir", profileId: "p1", paths: ["audited"] });
    expect((await call("GET", "/api/files/audit?limit=501")).body.code).toBe("FM_INVALID_REQUEST");
  });
});
