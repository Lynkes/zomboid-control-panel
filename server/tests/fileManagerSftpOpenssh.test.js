import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { Readable } from "stream";
import express from "express";
import unzipper from "unzipper";
import { canSymlinkFiles } from "./helpers/fileManagerFixtures.js";
import { SFTP_SERVER_IS_MSYS, SFTP_SERVER_REQUIRED, sftpServerSkipReason, startOpensshSftpServer } from "./helpers/opensshSftpServer.js";

// Server Files over a REAL OpenSSH sftp-server (helpers/opensshSftpServer.js):
// the panel's own ssh2-sftp-client, the real SFTP backend, the real routes,
// and OpenSSH's own answers to every request. The transfer tests are the
// ones fileManagerSftpRealSsh.test.js runs against an in-memory model of
// OpenSSH, with each of that server's knobs replaced by the real thing:
// a refused WRITE by `sftp-server -P write`, a host that refuses SETSTAT by
// `-P setstat,fsetstat`, a slow link by delayed replies, and the request log
// by sftp-server's own DEBUG1 log. Owner and permission checks need a POSIX
// host (Git for Windows' MSYS sftp-server fakes both) and a chown needs root,
// so those run where they can. After every test, each file and folder handle
// the panel opened must have been closed: sftp-server names any it had to
// close itself when the connection went.

const dbState = vi.hoisted(() => ({ servers: [], settings: {}, audit: [] }));

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  const roles = { admin: { name: "admin", capabilities: ["files.manage", "bridge.setup"] } };
  return {
    ...actual,
    getRoleByName: async (name) => roles[name] || null,
    getServer: async (id) => dbState.servers.find((s) => String(s.id) === String(id)) || null,
    getServers: async () => dbState.servers,
    getAllSettings: async () => dbState.settings,
    getSetting: async (key) => dbState.settings[key],
    setSetting: async (key, value) => {
      dbState.settings = { ...dbState.settings, [key]: value };
    },
    getActiveServer: async () => dbState.servers.find((s) => s.isActive) || null,
    appendFileAudit: async (row) => {
      dbState.audit.unshift(row);
      return row;
    },
  };
});

const { default: filesRoutes } = await import("../routes/files.js");
const { createSftpBackend, closeFileManagerSftpPool } = await import("../services/fileManagerSftpBackend.js");
const { _setFileManagerSftpTestHooks } = await import("../services/fileManagerSftpPool.js");
const { invalidateRootCache } = await import("../services/fileManagerRoots.js");
const { _resetRunStateCacheForTests } = await import("../services/fileManagerRunState.js");
const { _resetJobsForTests, _waitForJobForTests } = await import("../services/fileManagerJobs.js");
const { _resetZipSlotsForTests } = await import("../services/fileManagerZip.js");
const { _resetDenialCoalescingForTests } = await import("../services/fileManagerAudit.js");
const { getDataPaths } = await import("../utils/paths.js");
const service = await import("../services/fileManagerService.js");
const { FmError, FM_LIMITS } = await import("../services/fileManagerContract.js");

const ORIGINAL = "PVP=true\nPublicName=My server\nMaxPlayers=16\n";
const P = "/api/files/profiles/r1";
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
// A host where chmod and file modes mean something.
const POSIX_HOST = !SFTP_SERVER_IS_MSYS;

const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");

let srv;
let backend;
let root;
let server;
let baseUrl;
// Remote spellings, as the backend uses them.
let ROOT;
let INI;

async function codeOf(promise) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FmError) return err.code;
    throw err;
  }
  return "ok";
}

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
  const type = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    buffer,
    body: type.includes("application/json") && buffer.length ? JSON.parse(buffer.toString("utf8")) : null,
  };
}

function upload(dir, name, content, extra = {}) {
  return call("POST", `${P}/upload`, {
    raw: content,
    headers: {
      "content-type": "application/octet-stream",
      "x-file-root": "data",
      "x-file-dir": encodeURIComponent(dir),
      "x-file-name": encodeURIComponent(name),
      ...extra,
    },
  });
}

// Served files by path below the Zomboid folder.
const file = (rel) => srv.fs.readFile(`Zomboid/${rel}`)?.toString("utf8") ?? null;
const exists = (rel) => srv.fs.exists(`Zomboid/${rel}`);
const seed = (rel, content) => srv.fs.writeFile(`Zomboid/${rel}`, content);
const localOf = (rel) => srv.local(`Zomboid/${rel}`);
const tempsIn = (rel) => srv.fs.children(`Zomboid/${rel}`).filter((n) => /\.(zcpupload|zcptmp)$/.test(n));
const trashIds = () => srv.fs.children("Zomboid/.zcp-trash").filter((n) => /^\d{8}T\d{6}Z-/.test(n));

// A new pool, so the next request spawns sftp-servers with the handle's
// current -P list.
async function reconnect() {
  await closeFileManagerSftpPool();
  _setFileManagerSftpTestHooks({ timeouts: { transferIdleMs: 5000, opMs: 10000, readyMs: 10000 } });
  invalidateRootCache();
  backend = createSftpBackend({ settings: srv.settings });
  root = await backend.describeRoot({ id: "data", path: ROOT, warnings: [] });
}

const suite = sftpServerSkipReason ? describe.skip : describe;
if (sftpServerSkipReason) {
  (SFTP_SERVER_REQUIRED ? describe : describe.skip)(`Server Files over real OpenSSH (${sftpServerSkipReason})`, () => {
    it("needs an sftp-server binary", () => {
      throw new Error(sftpServerSkipReason);
    });
  });
}

beforeAll(async () => {
  const app = express();
  app.put("/api/files/profiles/:profileId/text", express.json({ limit: "6mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    if (req.get("x-test-role")) req.user = { userId: "u1", username: "kate", role: req.get("x-test-role") };
    next();
  });
  app.set("serverManager", { getServerProcessDetails: async () => ({ running: false, matched: [], owned: [] }) });
  app.use("/api/files", filesRoutes);
  server = http.createServer(app);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

beforeEach(async () => {
  if (sftpServerSkipReason) return;
  srv = await startOpensshSftpServer();
  ROOT = srv.remote("Zomboid");
  INI = `${ROOT}/Server/servertest.ini`;
  seed("Server/servertest.ini", ORIGINAL);
  seed("Logs/server.txt", "log line\n");
  seed("Logs/old/older.txt", "older\n");
  seed("Lua/panelbridge/servertest/status.json", "{}");
  await reconnect();
  dbState.servers = [{ id: "r1", name: "Remote", serverName: "servertest", isActive: true, provider: "remote-sftp", isRemote: true }];
  dbState.settings = {
    ...srv.settings,
    panelBridgeSftpConfigPath: `${ROOT}/Server`,
    panelBridgeSftpBridgePath: `${ROOT}/Lua/panelbridge/servertest`,
  };
  dbState.audit = [];
  invalidateRootCache();
  _resetRunStateCacheForTests();
  _resetJobsForTests();
  _resetZipSlotsForTests();
  _resetDenialCoalescingForTests();
  service._resetPreviewsForTests();
  service._resetTransferSlotsForTests();
});

afterEach(async () => {
  if (sftpServerSkipReason) return;
  await closeFileManagerSftpPool();
  _setFileManagerSftpTestHooks();
  vi.restoreAllMocks();
  // Every file and folder handle the panel opened, it closed: a pooled
  // connection lives on between requests, and sftp-server has a handle cap.
  await srv.settle();
  const leaked = srv.leakedHandles();
  await srv.close();
  expect(leaked).toEqual([]);
});

const resolve = (rel, intent = "read") => backend.resolve(root, rel ? rel.split("/") : [], intent);

suite("real OpenSSH: uploads and duplicates land", () => {
  it("a new file", async () => {
    const body = Buffer.from("hello from the browser\n");
    const result = await backend.receiveUpload(await resolve("Server", "list"), "notes.txt", Readable.from([body]), { declaredSize: body.length });
    expect(result.sha256).toBe(sha(body));
    expect(file("Server/notes.txt")).toBe(body.toString());
    expect(tempsIn("Server")).toEqual([]);
  });

  it("a large one, in many WRITEs", async () => {
    const body = crypto.randomBytes(3 * 1024 * 1024 + 17);
    const result = await backend.receiveUpload(await resolve("", "list"), "world.bin", Readable.from([body]), { declaredSize: body.length });
    expect(result.sha256).toBe(sha(body));
    expect(srv.fs.readFile("Zomboid/world.bin").equals(body)).toBe(true);
    expect(srv.log.filter((e) => e.op === "WRITE").length).toBeGreaterThan(3);
  });

  it("Replace by upload", async () => {
    const etag = (await backend.stat(await resolve("Server/servertest.ini"))).etag;
    const body = Buffer.from("PVP=false\n");
    const result = await backend.receiveUpload(await resolve("Server", "list"), "servertest.ini", Readable.from([body]), {
      declaredSize: body.length,
      overwriteEtag: etag,
    });
    expect(file("Server/servertest.ini")).toBe("PVP=false\n");
    expect(result.replacedTrashId).toMatch(/^\d{8}T\d{6}Z-/);
    expect(tempsIn("Server")).toEqual([]);
  });

  it("Duplicate, of an empty file and of a large one", async () => {
    await backend.copyFile(await resolve("Server/servertest.ini"), await resolve("Server", "list"), "servertest (copy).ini");
    expect(file("Server/servertest (copy).ini")).toBe(ORIGINAL);
    seed("empty.txt", "");
    await backend.copyFile(await resolve("empty.txt"), await resolve("", "list"), "empty (copy).txt");
    expect(file("empty (copy).txt")).toBe("");
    const big = crypto.randomBytes(2 * 1024 * 1024 + 5);
    srv.fs.writeFile("Zomboid/big.bin", big);
    await backend.copyFile(await resolve("big.bin"), await resolve("", "list"), "big (copy).bin");
    expect(srv.fs.readFile("Zomboid/big (copy).bin").equals(big)).toBe(true);
  });
});

suite("real OpenSSH: a remote disk that refuses writes (sftp-server -P write)", () => {
  beforeEach(async () => {
    srv.denyRequests = ["write"];
    await reconnect();
  });

  it("a save fails and leaves the live file and its Trash intact", async () => {
    const r = await resolve("Server/servertest.ini", "write");
    expect(await codeOf(backend.writeBytesCas(r, Buffer.from("PVP=false\n"), { expectedHash: `h:${sha(ORIGINAL)}` }))).not.toBe("ok");
    expect(file("Server/servertest.ini")).toBe(ORIGINAL);
    expect(tempsIn("Server")).toEqual([]);
    expect(trashIds()).toEqual([]);
  });

  it("a new file isn't created empty", async () => {
    const r = await resolve("Server/new.txt", "create");
    expect(await codeOf(backend.writeBytesCas(r, Buffer.from("x=1\n"), { expectedHash: null }))).not.toBe("ok");
    expect(exists("Server/new.txt")).toBe(false);
    expect(tempsIn("Server")).toEqual([]);
  });

  it("an upload fails instead of landing short", async () => {
    const body = Buffer.from("hello\n");
    expect(
      await codeOf(backend.receiveUpload(await resolve("Server", "list"), "up.txt", Readable.from([body]), { declaredSize: body.length })),
    ).not.toBe("ok");
    expect(exists("Server/up.txt")).toBe(false);
    expect(tempsIn("Server")).toEqual([]);
  });

  it("a duplicate fails instead of landing short", async () => {
    expect(
      await codeOf(backend.copyFile(await resolve("Server/servertest.ini"), await resolve("Server", "list"), "servertest (copy).ini")),
    ).not.toBe("ok");
    expect(exists("Server/servertest (copy).ini")).toBe(false);
    expect(tempsIn("Server")).toEqual([]);
  });
});

suite("real OpenSSH: downloads", () => {
  it("a file the login can see but not open is refused before the download starts (sftp-server -P open)", async () => {
    srv.denyRequests = ["open"];
    await reconnect();
    expect(await codeOf(backend.openReadStream(await resolve("Logs/server.txt")))).toBe("FM_OS_PERMISSION_DENIED");
    const res = await call("GET", `${P}/download?root=data&path=Logs/server.txt`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FM_OS_PERMISSION_DENIED");
  });

  it.runIf(POSIX_HOST && !IS_ROOT)("a file mode 000 is refused the same way", async () => {
    seed("Logs/private.log", "secret log\n");
    fs.chmodSync(localOf("Logs/private.log"), 0o000);
    try {
      expect(await codeOf(backend.openReadStream(await resolve("Logs/private.log")))).toBe("FM_OS_PERMISSION_DENIED");
      const res = await call("GET", `${P}/download?root=data&path=Logs/private.log`);
      expect(res.status).toBe(403);
    } finally {
      fs.chmodSync(localOf("Logs/private.log"), 0o644);
    }
  });

  it("a readable one streams, whole", async () => {
    const big = crypto.randomBytes(1024 * 1024 + 3);
    srv.fs.writeFile("Zomboid/Logs/big.bin", big);
    const handle = await backend.openReadStream(await resolve("Logs/big.bin"));
    const chunks = [];
    for await (const chunk of handle.stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(big)).toBe(true);
    const res = await call("GET", `${P}/download?root=data&path=Logs/big.bin`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(big.length));
    expect(res.buffer.equals(big)).toBe(true);
  });
});

suite("real OpenSSH: what a save keeps", () => {
  it.runIf(POSIX_HOST)("the file's mode, and sha256Before for the audit", async () => {
    fs.chmodSync(localOf("Server/servertest.ini"), 0o640);
    const r = await resolve("Server/servertest.ini", "write");
    const result = await backend.writeBytesCas(r, Buffer.from("PVP=false\n"), { expectedHash: `h:${sha(ORIGINAL)}` });
    expect(result.sha256Before).toBe(sha(ORIGINAL));
    expect(fs.statSync(localOf("Server/servertest.ini")).mode & 0o777).toBe(0o640);
  });

  it.runIf(POSIX_HOST)("the file's mode on a host that refuses SETSTAT, and 0644 for new files", async () => {
    srv.denyRequests = ["setstat", "fsetstat"];
    await reconnect();
    // Whatever the test runner's own umask made of the seeded file.
    fs.chmodSync(localOf("Server/servertest.ini"), 0o644);
    const r = await resolve("Server/servertest.ini", "write");
    await backend.writeBytesCas(r, Buffer.from("PVP=false\n"), { expectedHash: `h:${sha(ORIGINAL)}` });
    expect(file("Server/servertest.ini")).toBe("PVP=false\n");
    expect(fs.statSync(localOf("Server/servertest.ini")).mode & 0o777).toBe(0o644);
    await backend.writeBytesCas(await resolve("Server/servertest_spawnregions.lua", "create"), Buffer.from("x"), { expectedHash: null });
    expect(fs.statSync(localOf("Server/servertest_spawnregions.lua")).mode & 0o777).toBe(0o644);
    await backend.receiveUpload(await resolve("Server", "list"), "up.lua", Readable.from([Buffer.from("u")]), { declaredSize: 1 });
    expect(fs.statSync(localOf("Server/up.lua")).mode & 0o777).toBe(0o644);
  });

  it.runIf(POSIX_HOST && IS_ROOT)("a root login leaves the game user's files and folders the game user's", async () => {
    fs.chownSync(localOf("Server/servertest.ini"), 1001, 1001);
    fs.mkdirSync(localOf("game"));
    fs.chownSync(localOf("game"), 1001, 1001);
    await backend.writeBytesCas(await resolve("Server/servertest.ini", "write"), Buffer.from("PVP=false\n"), {
      expectedHash: `h:${sha(ORIGINAL)}`,
    });
    await backend.writeBytesCas(await resolve("game/created.txt", "create"), Buffer.from("y"), { expectedHash: null });
    await backend.mkdir(await resolve("game", "list"), "made");
    await backend.receiveUpload(await resolve("game", "list"), "up.txt", Readable.from([Buffer.from("u")]), { declaredSize: 1 });
    const owner = (rel) => {
      const st = fs.statSync(localOf(rel));
      return `${st.uid}:${st.gid}`;
    };
    expect([owner("Server/servertest.ini"), owner("game/created.txt"), owner("game/made"), owner("game/up.txt")]).toEqual(
      Array(4).fill("1001:1001"),
    );
  });

  it("New file, New folder and a save still land on a host that refuses SETSTAT", async () => {
    srv.denyRequests = ["setstat", "fsetstat"];
    await reconnect();
    await backend.writeBytesCas(await resolve("Logs/created.txt", "create"), Buffer.from("y"), { expectedHash: null });
    await backend.mkdir(await resolve("Logs", "list"), "made");
    await backend.writeBytesCas(await resolve("Server/servertest.ini", "write"), Buffer.from("PVP=false\n"), {
      expectedHash: `h:${sha(ORIGINAL)}`,
    });
    expect(file("Logs/created.txt")).toBe("y");
    expect(fs.statSync(localOf("Logs/made")).isDirectory()).toBe(true);
    expect(file("Server/servertest.ini")).toBe("PVP=false\n");
  });

  it.runIf(canSymlinkFiles())("a readable previous version of a file edited through a link", async () => {
    seed("Server/real.ini", ORIGINAL);
    fs.rmSync(localOf("Server/servertest.ini"));
    fs.symlinkSync("real.ini", localOf("Server/servertest.ini"), "file");
    const r = await resolve("Server/servertest.ini", "write");
    const { previousTrashId } = await backend.writeBytesCas(r, Buffer.from("PVP=false\n"), { expectedHash: `h:${sha(ORIGINAL)}` });
    const read = await backend.trashReadBytes(root, previousTrashId, { maxBytes: 1000 });
    expect(read.buffer.toString()).toBe(ORIGINAL);
    expect(file("Server/real.ini")).toBe("PVP=false\n");
    expect(fs.lstatSync(localOf("Server/servertest.ini")).isSymbolicLink()).toBe(true);
  });

  it("Replace by upload puts the new file in place before Trash retention runs", async () => {
    // An 8-day-old Trash item holding a lot of files.
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const id = `${old.getUTCFullYear()}${pad(old.getUTCMonth() + 1)}${pad(old.getUTCDate())}T000000Z-deadbeef`;
    for (let i = 0; i < 50; i++) seed(`.zcp-trash/${id}/payload/oldmod/f${i}.lua`, "x");
    seed(
      `.zcp-trash/${id}/meta.json`,
      JSON.stringify({ v: 1, originalPath: "oldmod", type: "dir", bytes: 50, files: 50, deletedAt: old.toISOString(), deletedBy: {}, reason: "deleted" }),
    );
    const etag = (await backend.stat(await resolve("Server/servertest.ini"))).etag;
    srv.log.length = 0;
    await backend.receiveUpload(await resolve("Server", "list"), "servertest.ini", Readable.from([Buffer.from("PVP=false\n")]), {
      declaredSize: 10,
      overwriteEtag: etag,
    });
    const landed = srv.log.findIndex((e) => e.op === "RENAME" && e.path.endsWith("-> " + INI));
    const firstExpiry = srv.log.findIndex((e) => e.op === "REMOVE" && e.path.includes(id));
    expect(landed).toBeGreaterThan(-1);
    expect(firstExpiry).toBeGreaterThan(landed);
    expect(exists(`.zcp-trash/${id}`)).toBe(false);
  });
});

suite("real OpenSSH: stalls, a killed sftp-server, a dropped connection", () => {
  const readAll = async (stream) => Buffer.concat(await stream.toArray());

  beforeEach(async () => {
    srv.fs.writeFile("Zomboid/big.bin", crypto.randomBytes(4 * 1024 * 1024));
    await closeFileManagerSftpPool();
    _setFileManagerSftpTestHooks({ timeouts: { transferIdleMs: 1500, opMs: 8000, readyMs: 10000 } });
    backend = createSftpBackend({ settings: srv.settings });
    root = await backend.describeRoot({ id: "data", path: ROOT, warnings: [] });
  });
  afterEach(() => srv.stall(false));

  it("a download the server stops answering times out, and the next one works", async () => {
    const handle = await backend.openReadStream(await resolve("big.bin"));
    let got = 0;
    const stalled = (async () => {
      for await (const chunk of handle.stream) {
        got += chunk.length;
        if (got > 512 * 1024) srv.stall(true);
      }
    })();
    expect(await codeOf(stalled)).toBe("FM_SFTP_TIMEOUT");
    srv.stall(false);
    expect((await readAll((await backend.openReadStream(await resolve("big.bin"))).stream)).length).toBe(4 * 1024 * 1024);
  });

  it("an sftp-server killed between requests costs no request a timeout", async () => {
    await readAll((await backend.openReadStream(await resolve("Logs/server.txt"))).stream);
    srv.killSessions();
    await srv.settle();
    const started = Date.now();
    expect((await backend.readBytes(await resolve("Server/servertest.ini"), { maxBytes: 100 })).buffer.toString()).toBe(ORIGINAL);
    await backend.mkdir(await resolve("", "list"), "made");
    expect((await readAll((await backend.openReadStream(await resolve("big.bin"))).stream)).length).toBe(4 * 1024 * 1024);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("an sftp-server killed mid-download fails that download only", async () => {
    const handle = await backend.openReadStream(await resolve("big.bin"));
    let got = 0;
    let killed = false;
    const cut = (async () => {
      for await (const chunk of handle.stream) {
        got += chunk.length;
        if (got > 512 * 1024 && !killed) {
          killed = true;
          srv.killSessions();
        }
      }
    })();
    expect(await codeOf(cut)).not.toBe("ok");
    await srv.settle();
    const started = Date.now();
    expect((await resolve("Logs/server.txt")).stat.type).toBe("file");
    expect((await readAll((await backend.openReadStream(await resolve("big.bin"))).stream)).length).toBe(4 * 1024 * 1024);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("a dropped connection is reopened for the next request", async () => {
    await resolve("Logs/server.txt");
    srv.dropConnections();
    await srv.settle();
    expect((await resolve("Logs/server.txt")).stat.type).toBe("file");
    await backend.mkdir(await resolve("", "list"), "made");
  });
});

suite("real OpenSSH: a zip the client abandons", () => {
  const zipTemps = () => {
    try {
      return fs.readdirSync(path.join(getDataPaths().dataDir, "file-manager-tmp")).filter((n) => n.startsWith(".central-"));
    } catch {
      return [];
    }
  };

  // Live QA: a client that read a little of a remote zip and went away
  // left its zip slot taken until the panel restarted (every later zip by
  // that user, local ones too, was a 429), with its SFTP read open and its
  // central-directory temp file behind. The write that never settled is
  // pinned in plain node by fileManagerZip.test.js; this checks the rest
  // over a real sftp-server: the slot, the remote handle (afterEach), the
  // temp file and one audit row per zip.
  it("gives its slot, its remote read and its temp file back, every time", async () => {
    srv.fs.writeFile("Zomboid/Logs/huge.bin", crypto.randomBytes(24 * 1024 * 1024));
    for (let attempt = 0; attempt < 6; attempt++) {
      const gone = new AbortController();
      const response = await fetch(`${baseUrl}${P}/zip`, {
        method: "POST",
        signal: gone.signal,
        headers: { "content-type": "application/json", "x-test-role": "admin" },
        body: JSON.stringify({ root: "data", paths: ["Logs"] }),
      });
      expect(response.status).toBe(200);
      const reader = response.body.getReader();
      let got = 0;
      while (got < [0, 65536, 524288][attempt % 3]) {
        const { value, done } = await reader.read();
        if (done) break;
        got += value.length;
      }
      gone.abort();
      let next = null;
      for (const started = Date.now(); Date.now() - started < 5000; ) {
        next = await call("POST", `${P}/zip`, { body: { root: "data", paths: ["Server"] } });
        if (next.status === 200) break;
        await new Promise((done) => setTimeout(done, 100));
      }
      expect(next?.status, `attempt ${attempt}: the next zip`).toBe(200);
    }
    for (const started = Date.now(); zipTemps().length && Date.now() - started < 3000; ) {
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(zipTemps()).toEqual([]);
    const rows = dbState.audit.filter((row) => row.op === "files.zip");
    expect(rows.filter((row) => row.result === "aborted")).toHaveLength(6);
    expect(rows.filter((row) => row.result === "ok")).toHaveLength(6);
    // afterEach: no remote handle left open.
  }, 60000);
});

suite("real OpenSSH: big folders over a slow link", () => {
  it("a folder that takes longer than one operation's timeout to list still lists", async () => {
    for (let i = 0; i < 1500; i++) seed(`map/map_${i}.bin`, "");
    await closeFileManagerSftpPool();
    _setFileManagerSftpTestHooks({ timeouts: { transferIdleMs: 5000, opMs: 600, readyMs: 10000 } });
    backend = createSftpBackend({ settings: srv.settings });
    root = await backend.describeRoot({ id: "data", path: ROOT, warnings: [] });
    const dir = await resolve("map", "list");
    srv.latencyMs = 60;
    const started = Date.now();
    const listed = await backend.list(dir, { limit: 1000 });
    expect(Date.now() - started).toBeGreaterThan(600);
    expect(listed.total).toBe(1500);
  }, 60000);
});

suite("real OpenSSH: listings", () => {
  it("every name of a folder bigger than one READDIR reply", async () => {
    for (let i = 0; i < 250; i++) seed(`many/f${String(i).padStart(3, "0")}.txt`, "x");
    const listed = await backend.list(await resolve("many", "list"), { limit: 1000 });
    expect(listed.total).toBe(250);
    const walked = [];
    for await (const e of backend.walk(await resolve("many", "list"), {})) walked.push(e.name);
    expect(walked).toHaveLength(250);
  });

  it("an empty folder", async () => {
    srv.fs.mkdir("Zomboid/empty");
    const listed = await backend.list(await resolve("empty", "list"), {});
    expect(listed).toMatchObject({ total: 0, entries: [] });
  });
});

suite("real OpenSSH: search", () => {
  it("walks breadth first: shallow folders before one deep subtree", async () => {
    for (let i = 0; i < 20; i++) seed(`Saves/Multiplayer/servertest/map/${i}/c.bin`, "");
    seed("Server/servertest_SandboxVars.lua", "SandboxVars = {}\n");
    const order = [];
    for await (const entry of backend.walk(await resolve("", "list"), {})) order.push(entry.rel);
    const settings = order.indexOf("Server/servertest_SandboxVars.lua");
    const deep = order.findIndex((rel) => rel.startsWith("Saves/Multiplayer/servertest/map/"));
    expect(settings).toBeGreaterThan(-1);
    expect(settings).toBeLessThan(deep);
  });
});

suite("real OpenSSH: Windows short names", () => {
  it("are refused like missing entries, so no rule can be sidestepped with one", async () => {
    srv.fs.mkdir("Zomboid/.zcp-trash");
    srv.fs.mkdir("Zomboid/.ssh");
    // On an NTFS-backed server (Git for Windows' sftp-server here) these
    // open the long-named folders for real, when the volume makes 8.3 names.
    const probes = ["Lua/PANELB~1/servertest/commands.json", "ZCP-TR~1/x", "SSH~1/id_ed25519"];
    for (const rel of probes) {
      expect(await codeOf(resolve(rel, "create")), rel).toBe("FM_NOT_FOUND");
    }
    const forged = await call("PUT", `${P}/text`, {
      body: { root: "data", path: "Lua/PANELB~1/servertest/commands.json", content: "{}", etag: null, eol: "lf", bom: false, confirm: [] },
    });
    expect(forged.status).toBe(404);
    expect(exists("Lua/panelbridge/servertest/commands.json")).toBe(false);
    seed("Server/notes~old.txt", "x");
    expect(await codeOf(resolve("Server/notes~old.txt"))).toBe("ok");
  });
});

suite("real OpenSSH: through the service", () => {
  it("a folder upload's preflight looks each level up once, not once per file", async () => {
    const N = 40;
    for (let i = 0; i < N; i++) seed(`mods/MyMod/media/lua/client/f${i}.lua`, "-- x\n");
    await call("GET", `${P}/list?root=data&path=mods`);
    srv.log.length = 0;
    const files = Array.from({ length: N }, (_, i) => ({ relPath: `MyMod/media/lua/client/f${i}.lua`, size: 5 }));
    const res = await call("POST", `${P}/upload/preflight`, { body: { root: "data", dir: "mods", files } });
    expect(res.status).toBe(200);
    expect(res.body.files.every((f) => f.ok && f.willReplace && f.currentEtag)).toBe(true);
    expect(srv.log.length / N).toBeLessThan(3);
  });

  it("the preflight's etags are the ones an upload accepts", async () => {
    const res = await call("POST", `${P}/upload/preflight`, { body: { root: "data", dir: "Server", files: [{ relPath: "servertest.ini", size: 10 }] } });
    const up = await upload("Server", "servertest.ini", "PVP=false\n", {
      "x-file-overwrite-etag": res.body.files[0].currentEtag,
      "x-file-confirm": "overwrite",
    });
    expect(up.status).toBe(201);
    expect(file("Server/servertest.ini")).toBe("PVP=false\n");
  });

  it("remote Trash items removed by retention get a files.trash.expire audit row", async () => {
    const pv = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["Logs/server.txt"] } });
    const del = await call("POST", `${P}/delete`, { body: { root: "data", previewId: pv.body.previewId, mode: "trash", confirm: pv.body.required } });
    const trashId = del.body.trashed[0].trashId;
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + (FM_LIMITS.TRASH_RETENTION_DAYS + 1) * 24 * 3600 * 1000);
    try {
      const listed = await call("GET", `${P}/trash?root=data`);
      expect(listed.body.items).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
    const row = dbState.audit.find((entry) => entry.op === "files.trash.expire");
    expect(row).toMatchObject({ actor: { username: "system" }, backend: "sftp", rootId: "data", trashIds: [trashId], result: "ok" });
    expect(exists(`.zcp-trash/${trashId}`)).toBe(false);
  });

  it("a remote save's audit row names the version it replaced", async () => {
    const opened = await call("GET", `${P}/text?root=data&path=Logs/server.txt`);
    const saved = await call("PUT", `${P}/text`, {
      body: { root: "data", path: "Logs/server.txt", content: "edited\n", etag: opened.body.etag, eol: "lf", bom: false, confirm: [] },
    });
    expect(saved.status).toBe(200);
    const row = dbState.audit.find((entry) => entry.op === "files.write");
    expect(row.sha256Before).toBe(sha("log line\n"));
    expect(row.sha256After).toBe(sha("edited\n"));
  });
});

suite("real OpenSSH: every /api/files route end to end", () => {
  it("the profile: the derived Zomboid folder, free space, no password", async () => {
    const res = await call("GET", `${P}?fresh=1`);
    expect(res.status).toBe(200);
    const data = res.body.profile.roots.find((r) => r.id === "data");
    expect(data).toMatchObject({ backend: "sftp", available: true, displayPath: ROOT });
    expect(typeof data.freeBytes).toBe("number");
    expect(JSON.stringify(res.body)).not.toContain(srv.settings.panelBridgeSftpPassword);
  });

  it("list, stat, text read and search", async () => {
    const list = await call("GET", `${P}/list?root=data&path=Logs`);
    expect(list.status).toBe(200);
    expect(list.body.entries.map((e) => e.name)).toEqual(["old", "server.txt"]);
    const stat = await call("GET", `${P}/stat?root=data&path=Logs/server.txt`);
    expect(stat.body.entry).toMatchObject({ name: "server.txt", type: "file", size: 9 });
    const text = await call("GET", `${P}/text?root=data&path=Logs/server.txt`);
    expect(text.status).toBe(200);
    expect(text.body.content).toBe("log line\n");
    const search = await call("GET", `${P}/search?root=data&path=&q=older`);
    expect(search.status).toBe(200);
    expect(search.body.results.map((e) => e.path)).toEqual(["Logs/old/older.txt"]);
    const bridge = await call("GET", `${P}/list?root=data&path=Lua/panelbridge/servertest`);
    expect(bridge.body.dir.protection).toMatchObject({ area: "bridgeIo" });
  });

  it("a masked .ini save keeps the password, and its previous version reads back masked", async () => {
    seed("Server/servertest.ini", "PVP=true\nPassword=hunter2\n");
    const text = await call("GET", `${P}/text?root=data&path=Server/servertest.ini&mode=edit`);
    expect(text.status).toBe(200);
    expect(text.body.masked).toBe(true);
    expect(text.body.content).not.toContain("hunter2");
    const saved = await call("PUT", `${P}/text`, {
      body: {
        root: "data",
        path: "Server/servertest.ini",
        content: text.body.content.replace("PVP=true", "PVP=false"),
        etag: text.body.etag,
        eol: text.body.eol,
        bom: text.body.bom,
        confirm: ["serverRunning"],
      },
    });
    expect(saved.status).toBe(200);
    expect(file("Server/servertest.ini")).toBe("PVP=false\nPassword=hunter2\n");
    expect(tempsIn("Server")).toEqual([]);
    const earlier = await call("GET", `${P}/trash/text?root=data&trashId=${saved.body.previousVersion.trashId}`);
    expect(earlier.status).toBe(200);
    expect(earlier.body.content).toMatch(/^PVP=true$/m);
    expect(earlier.body.content).not.toContain("hunter2");
  });

  it("a masked .ini downloaded and uploaded back keeps the password", async () => {
    seed("Server/servertest.ini", "PVP=true\nPassword=hunter2\n");
    const text = await call("GET", `${P}/text?root=data&path=Server/servertest.ini&mode=edit`);
    const pre = await call("POST", `${P}/upload/preflight`, { body: { root: "data", dir: "Server", files: [{ relPath: "servertest.ini", size: 10 }] } });
    const up = await upload("Server", "servertest.ini", text.body.content.replace("PVP=true", "PVP=false"), {
      "x-file-overwrite-etag": pre.body.files[0].currentEtag,
      "x-file-confirm": "overwrite",
    });
    expect(up.status).toBe(201);
    expect(file("Server/servertest.ini")).toBe("PVP=false\nPassword=hunter2\n");
  });

  it("upload: new, taken, replace; a folder upload makes its folders", async () => {
    const created = await upload("Logs", "new.txt", "uploaded");
    expect(created.status).toBe(201);
    expect(file("Logs/new.txt")).toBe("uploaded");
    const taken = await upload("Logs", "new.txt", "again");
    expect(taken.status).toBe(409);
    const replaced = await upload("Logs", "new.txt", "replaced!", {
      "x-file-overwrite-etag": created.body.entry.etag,
      "x-file-confirm": "overwrite",
    });
    expect(replaced.status).toBe(201);
    expect(file("Logs/new.txt")).toBe("replaced!");
    expect(replaced.body.replaced.trashId).toMatch(/^\d{8}T\d{6}Z-/);

    const pre = await call("POST", `${P}/upload/preflight`, {
      body: { root: "data", dir: "mods", files: [{ relPath: "MyMod/media/lua/client/a.lua", size: 3 }, { relPath: "MyMod/mod.info", size: 4 }] },
    });
    expect(pre.status).toBe(200);
    expect(pre.body.files.every((f) => f.ok && !f.willReplace)).toBe(true);
    const deep = await upload("mods/MyMod/media/lua/client", "a.lua", "-- a", { "x-file-mkdirs": "1" });
    expect(deep.status).toBe(201);
    const info = await upload("mods/MyMod", "mod.info", "name", { "x-file-mkdirs": "1" });
    expect(info.status).toBe(201);
    expect(file("mods/MyMod/media/lua/client/a.lua")).toBe("-- a");
    expect(file("mods/MyMod/mod.info")).toBe("name");
    expect(tempsIn("mods/MyMod")).toEqual([]);
  });

  it("New folder, rename, case-only rename, move and duplicate", async () => {
    const made = await call("POST", `${P}/mkdir`, { body: { root: "data", path: "Logs", name: "archive", confirm: [] } });
    expect(made.status).toBe(201);
    expect(fs.statSync(localOf("Logs/archive")).isDirectory()).toBe(true);

    const renamed = await call("POST", `${P}/rename`, { body: { root: "data", path: "Logs/server.txt", newName: "console.txt", confirm: [] } });
    expect(renamed.status).toBe(200);
    expect(file("Logs/console.txt")).toBe("log line\n");
    expect(srv.fs.children("Zomboid/Logs")).toEqual(["archive", "console.txt", "old"]);

    const cased = await call("POST", `${P}/rename`, { body: { root: "data", path: "Logs/console.txt", newName: "Console.txt", confirm: [] } });
    expect(cased.status).toBe(200);
    expect(cased.body.entry.name).toBe("Console.txt");
    expect(srv.fs.children("Zomboid/Logs")).toEqual(["Console.txt", "archive", "old"]);
    expect(tempsIn("Logs")).toEqual([]);

    const clash = await call("POST", `${P}/rename`, { body: { root: "data", path: "Logs/Console.txt", newName: "old", confirm: [] } });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("FM_EXISTS");

    const moved = await call("POST", `${P}/move`, { body: { root: "data", paths: ["Logs/Console.txt"], destDir: "Logs/archive", confirm: [] } });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ moved: [{ from: "Logs/Console.txt", to: "Logs/archive/Console.txt" }], failed: [] });
    expect(file("Logs/archive/Console.txt")).toBe("log line\n");

    const folder = await call("POST", `${P}/move`, { body: { root: "data", paths: ["Logs/old"], destDir: "Logs/archive", confirm: [] } });
    expect(folder.body.failed).toEqual([]);
    expect(file("Logs/archive/old/older.txt")).toBe("older\n");

    const copy = await call("POST", `${P}/copy`, { body: { root: "data", path: "Logs/archive/Console.txt", destDir: "Logs", confirm: [] } });
    expect(copy.status).toBe(201);
    expect(file("Logs/Console (copy).txt")).toBe("log line\n");
    seed("Logs/archive/Console.txt", "changed\n");
    const again = await call("POST", `${P}/copy`, {
      body: { root: "data", path: "Logs/archive/Console.txt", destDir: "Logs", newName: "Console (copy).txt", confirm: [] },
    });
    expect(again.status).toBe(409);
    const confirmed = await call("POST", `${P}/copy`, {
      body: { root: "data", path: "Logs/archive/Console.txt", destDir: "Logs", newName: "Console (copy).txt", confirm: again.body.params.required },
    });
    expect(confirmed.status).toBe(201);
    expect(file("Logs/Console (copy).txt")).toBe("changed\n");
  });

  it("delete to Trash, restore, restore under another name, purge, and delete for good", async () => {
    const preview = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["Logs"] } });
    expect(preview.status).toBe(200);
    expect(preview.body.items[0]).toMatchObject({ path: "Logs", type: "dir", files: 2, dirs: 2, bytes: 15 });
    const del = await call("POST", `${P}/delete`, {
      body: { root: "data", previewId: preview.body.previewId, mode: "trash", confirm: preview.body.required },
    });
    expect(del.status).toBe(200);
    expect(exists("Logs")).toBe(false);
    const trash = await call("GET", `${P}/trash?root=data`);
    expect(trash.body.items.find((i) => i.originalPath === "Logs")).toMatchObject({ type: "dir", files: 2 });
    const restored = await call("POST", `${P}/trash/restore`, { body: { root: "data", trashId: del.body.trashed[0].trashId } });
    expect(restored.status).toBe(200);
    expect(file("Logs/old/older.txt")).toBe("older\n");
    expect(trashIds()).toEqual([]);

    const pv2 = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["Logs/server.txt"] } });
    const del2 = await call("POST", `${P}/delete`, { body: { root: "data", previewId: pv2.body.previewId, mode: "trash", confirm: pv2.body.required } });
    seed("Logs/server.txt", "taken\n");
    const clash = await call("POST", `${P}/trash/restore`, { body: { root: "data", trashId: del2.body.trashed[0].trashId } });
    expect(clash.status).toBe(409);
    const renamed = await call("POST", `${P}/trash/restore`, {
      body: { root: "data", trashId: del2.body.trashed[0].trashId, restoreAs: "server (restored).txt" },
    });
    expect(renamed.status).toBe(200);
    expect(file("Logs/server (restored).txt")).toBe("log line\n");

    const pv3 = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["Logs/server.txt"] } });
    await call("POST", `${P}/delete`, { body: { root: "data", previewId: pv3.body.previewId, mode: "trash", confirm: pv3.body.required } });
    expect(trashIds()).toHaveLength(1);
    const purge = await call("POST", `${P}/trash/purge`, { body: { root: "data", all: true, confirm: ["permanent"], typedConfirmation: "1" } });
    expect([200, 202]).toContain(purge.status);
    if (purge.status === 202) await _waitForJobForTests(purge.body.jobId);
    expect(trashIds()).toEqual([]);

    const pv4 = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["Logs/old"] } });
    const gone = await call("POST", `${P}/delete`, {
      body: { root: "data", previewId: pv4.body.previewId, mode: "permanent", confirm: [...pv4.body.required, "permanent"], typedConfirmation: "old" },
    });
    expect(gone.status).toBe(202);
    await _waitForJobForTests(gone.body.jobId);
    const job = await call("GET", `/api/files/jobs/${gone.body.jobId}`);
    expect(job.body.state).toBe("done");
    expect(exists("Logs/old")).toBe(false);
  });

  it("a restore whose folder is gone makes it again", async () => {
    const pv = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["Logs/old/older.txt"] } });
    const del = await call("POST", `${P}/delete`, { body: { root: "data", previewId: pv.body.previewId, mode: "trash", confirm: pv.body.required } });
    fs.rmSync(localOf("Logs/old"), { recursive: true });
    const restored = await call("POST", `${P}/trash/restore`, { body: { root: "data", trashId: del.body.trashed[0].trashId, confirm: [] } });
    expect(restored.status).toBe(200);
    expect(file("Logs/old/older.txt")).toBe("older\n");
  });

  it("names beyond ASCII: upload, list, rename, download", async () => {
    const up = await upload("Logs", "journal d'été 🧟.txt", "zombies");
    expect(up.status).toBe(201);
    const list = await call("GET", `${P}/list?root=data&path=Logs`);
    expect(list.body.entries.map((e) => e.name)).toContain("journal d'été 🧟.txt");
    const renamed = await call("POST", `${P}/rename`, {
      body: { root: "data", path: "Logs/journal d'été 🧟.txt", newName: "日本語のログ.txt", confirm: [] },
    });
    expect(renamed.status).toBe(200);
    const dl = await call("GET", `${P}/download?root=data&path=${encodeURIComponent("Logs/日本語のログ.txt")}`);
    expect(dl.buffer.toString()).toBe("zombies");
  });

  it("zip download and download", async () => {
    seed("Server/servertest.ini", "PVP=true\nPassword=hunter2\n");
    const zip = await call("POST", `${P}/zip`, { body: { root: "data", paths: ["Logs", "Server"] } });
    expect(zip.status).toBe(200);
    const dir = await unzipper.Open.buffer(zip.buffer);
    const byName = Object.fromEntries(await Promise.all(dir.files.filter((f) => f.type === "File").map(async (f) => [f.path, (await f.buffer()).toString()])));
    expect(byName).toMatchObject({ "Logs/server.txt": "log line\n", "Logs/old/older.txt": "older\n" });
    expect(byName["Server/servertest.ini"]).toMatch(/^PVP=true$/m);
    expect(byName["Server/servertest.ini"]).not.toContain("hunter2");
    const dl = await call("GET", `${P}/download?root=data&path=Logs/server.txt`);
    expect(dl.status).toBe(200);
    expect(dl.buffer.toString()).toBe("log line\n");
    expect(dl.headers.get("content-length")).toBe("9");
  });

  it("the bridge folder stays protected when the settings spell the Zomboid folder another way", async () => {
    // The config and bridge folders as the operator typed them, through a
    // link (or MSYS's other spelling): REALPATH gives the data root the
    // server's own spelling, and the bridge folder must still be matched.
    const alias = srv.aliasRoot();
    seed("bridge-io/servertest/status.json", "{}");
    dbState.settings = {
      ...dbState.settings,
      panelBridgeSftpConfigPath: `${alias}/Zomboid/Server`,
      panelBridgeSftpBridgePath: `${alias}/Zomboid/bridge-io/servertest`,
    };
    invalidateRootCache();
    const profile = await call("GET", `${P}?fresh=1`);
    expect(profile.body.profile.roots.find((r) => r.id === "data")).toMatchObject({ available: true, displayPath: `${alias}/Zomboid` });
    const list = await call("GET", `${P}/list?root=data&path=bridge-io/servertest`);
    expect(list.status).toBe(200);
    expect(list.body.dir.protection).toMatchObject({ area: "bridgeIo" });
    const forged = await call("PUT", `${P}/text`, {
      body: { root: "data", path: "bridge-io/servertest/commands.json", content: "{}", etag: null, eol: "lf", bom: false, confirm: [] },
    });
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe("FM_PATH_PROTECTED");
    expect(exists("bridge-io/servertest/commands.json")).toBe(false);
  });

  it("remote roots: an install folder is offered once set", async () => {
    srv.fs.writeFile("game/start-server.sh", "#!/bin/sh\n");
    const set = await call("PUT", `${P}/remote-roots`, { body: { installPath: srv.remote("game"), dataPath: null } });
    expect(set.status).toBe(200);
    const install = set.body.profile.roots.find((r) => r.id === "install");
    expect(install).toMatchObject({ available: true, backend: "sftp", displayPath: srv.remote("game") });
    const list = await call("GET", `${P}/list?root=install&path=`);
    expect(list.body.entries.map((e) => e.name)).toEqual(["start-server.sh"]);
  });

  it("a server without posix-rename@openssh.com (sftp-server -P posix-rename): saves still replace the file", async () => {
    srv.denyRequests = ["posix-rename"];
    await reconnect();
    seed("Server/servertest.ini", "PVP=true\nPassword=hunter2\n");
    for (const pvp of ["false", "true", "false"]) {
      const text = await call("GET", `${P}/text?root=data&path=Server/servertest.ini&mode=edit`);
      const saved = await call("PUT", `${P}/text`, {
        body: {
          root: "data",
          path: "Server/servertest.ini",
          content: text.body.content.replace(/PVP=\w+/, `PVP=${pvp}`),
          etag: text.body.etag,
          eol: text.body.eol,
          bom: text.body.bom,
          confirm: ["serverRunning"],
        },
      });
      expect(saved.status).toBe(200);
      expect(file("Server/servertest.ini")).toBe(`PVP=${pvp}\nPassword=hunter2\n`);
    }
    expect(srv.log.some((e) => e.op === "POSIX-RENAME")).toBe(false);
    expect(srv.fs.children("Zomboid/Server")).toEqual(["servertest.ini"]);
    expect(trashIds()).toHaveLength(3);
  });
});

suite("real OpenSSH: links (a junction on Windows)", () => {
  const folderLink = (target, at) => fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
  const unlinkFolder = (at) => {
    try {
      fs.unlinkSync(at);
    } catch {
      try {
        fs.rmdirSync(at);
      } catch {
        /* gone */
      }
    }
  };
  const links = [];
  beforeEach(() => {
    seed("target/inside.txt", "inside");
    srv.fs.writeFile("outside/secret.txt", "secret");
    for (const [target, at] of [
      [localOf("target"), localOf("linkIn")],
      [srv.local("outside"), localOf("linkOut")],
      [localOf("gone"), localOf("dangling")],
    ]) {
      folderLink(target, at);
      links.push(at);
    }
  });
  afterEach(() => {
    for (const at of links.splice(0)) unlinkFolder(at);
  });

  it("are listed for what they are, followed only inside the root, and deleted as themselves", async () => {
    const listed = await call("GET", `${P}/list?root=data&path=`);
    const byName = Object.fromEntries(listed.body.entries.map((e) => [e.name, e]));
    expect(byName.linkIn).toMatchObject({ type: "link", link: { inside: true, targetType: "dir" } });
    expect(byName.linkOut).toMatchObject({ type: "link", link: { inside: false } });
    expect(byName.dangling).toMatchObject({ type: "link", link: { targetType: "missing" } });
    const inside = await call("GET", `${P}/text?root=data&path=linkIn/inside.txt`);
    expect(inside.body.content).toBe("inside");
    const escaped = await call("GET", `${P}/text?root=data&path=linkOut/secret.txt`);
    expect(escaped.status).toBe(403);
    expect(escaped.body.code).toBe("FM_LINK_ESCAPES_ROOT");
    expect(JSON.stringify(escaped.body)).not.toContain("secret");
    const created = await call("PUT", `${P}/text`, {
      body: { root: "data", path: "linkOut/planted.txt", content: "x", etag: null, eol: "lf", bom: false, confirm: [] },
    });
    expect(created.status).toBe(403);
    expect(srv.fs.exists("outside/planted.txt")).toBe(false);

    // Deleted for good: the link goes, never what it points at.
    const pv = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["linkOut"] } });
    const gone = await call("POST", `${P}/delete`, {
      body: { root: "data", previewId: pv.body.previewId, mode: "permanent", confirm: [...pv.body.required, "permanent"], typedConfirmation: "linkOut" },
    });
    expect(gone.status).toBe(202);
    await _waitForJobForTests(gone.body.jobId);
    expect(exists("linkOut")).toBe(false);
    expect(srv.fs.readFile("outside/secret.txt")?.toString()).toBe("secret");

    // To Trash: the link moves, the folder it points at stays.
    const pv2 = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["linkIn"] } });
    const trashed = await call("POST", `${P}/delete`, { body: { root: "data", previewId: pv2.body.previewId, mode: "trash", confirm: pv2.body.required } });
    expect(trashed.status).toBe(200);
    expect(exists("linkIn")).toBe(false);
    expect(file("target/inside.txt")).toBe("inside");
  });
});

suite("real OpenSSH: a folder the login can't read", () => {
  it.runIf(POSIX_HOST && !IS_ROOT)("is refused by a listing and skipped by search", async () => {
    seed("locked/hidden.txt", "x");
    seed("open/findme.txt", "x");
    fs.chmodSync(localOf("locked"), 0o000);
    try {
      const list = await call("GET", `${P}/list?root=data&path=locked`);
      expect(list.status).toBe(403);
      expect(list.body.code).toBe("FM_OS_PERMISSION_DENIED");
      const search = await call("GET", `${P}/search?root=data&path=&q=findme`);
      expect(search.status).toBe(200);
      expect(search.body.results.map((e) => e.path)).toEqual(["open/findme.txt"]);
    } finally {
      fs.chmodSync(localOf("locked"), 0o755);
    }
  });
});

suite("real OpenSSH: a login the server refuses things to (sftp-server -P)", () => {
  const deny = async (...requests) => {
    srv.denyRequests = requests;
    await reconnect();
  };

  it("an upload it may not create: 403, the body answered, nothing left behind", async () => {
    await deny("open");
    const big = crypto.randomBytes(512 * 1024);
    const up = await upload("Logs", "new.bin", big);
    expect(up.status).toBe(403);
    expect(up.body.code).toBe("FM_OS_PERMISSION_DENIED");
    expect(srv.fs.children("Zomboid/Logs")).toEqual(["old", "server.txt"]);
    const save = await call("PUT", `${P}/text`, {
      body: { root: "data", path: "Logs/new.txt", content: "x", etag: null, eol: "lf", bom: false, confirm: [] },
    });
    expect(save.status).toBe(403);
  });

  it("New folder, rename, move and delete it may not do: 403, and nothing moved or lost", async () => {
    await deny("mkdir", "rename", "posix-rename", "remove", "rmdir");
    const made = await call("POST", `${P}/mkdir`, { body: { root: "data", path: "Logs", name: "archive", confirm: [] } });
    expect(made.status).toBe(403);
    const renamed = await call("POST", `${P}/rename`, { body: { root: "data", path: "Logs/server.txt", newName: "x.txt", confirm: [] } });
    expect(renamed.status).toBe(403);
    const moved = await call("POST", `${P}/move`, { body: { root: "data", paths: ["Logs/server.txt"], destDir: "Logs/old", confirm: [] } });
    expect(moved.body.failed).toEqual([expect.objectContaining({ path: "Logs/server.txt", code: "FM_OS_PERMISSION_DENIED" })]);
    const pv = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["Logs/old"] } });
    const trashed = await call("POST", `${P}/delete`, { body: { root: "data", previewId: pv.body.previewId, mode: "trash", confirm: pv.body.required } });
    expect(trashed.body.trashed ?? []).toEqual([]);
    const pv2 = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["Logs/old"] } });
    const gone = await call("POST", `${P}/delete`, {
      body: { root: "data", previewId: pv2.body.previewId, mode: "permanent", confirm: [...pv2.body.required, "permanent"], typedConfirmation: "old" },
    });
    expect(gone.status).toBe(202);
    await _waitForJobForTests(gone.body.jobId).catch(() => {});
    const job = await call("GET", `/api/files/jobs/${gone.body.jobId}`);
    expect(job.body.state).toBe("failed");
    expect(file("Logs/server.txt")).toBe("log line\n");
    expect(file("Logs/old/older.txt")).toBe("older\n");
    expect(srv.fs.children("Zomboid/Logs")).toEqual(["old", "server.txt"]);
  });
});

suite("real OpenSSH: the served folder", () => {
  it("is where the remote paths point", () => {
    expect(srv.toLocal(ROOT)).toBe(path.normalize(localOf("")));
  });
});
