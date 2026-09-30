import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import http from "http";
import net from "net";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import express from "express";
import unzipper from "unzipper";
import { makeServerTree, makeTempDir, removeDir, write } from "./helpers/fileManagerFixtures.js";

// Regressions from the v1.4.1 security review of /api/files, over real HTTP:
// secrets the panel itself writes into server folders (the managed launch
// scripts' -adminpassword, the .ini backups the file manager makes on
// save) never leave in plain text; a Zomboid folder nested inside the game
// folder keeps its protected areas, world-save gate and Trash whichever
// root reaches it; a download that stops being read gives its transfer
// slot back; a refused delete preview is audited with what was refused;
// and a folder upload's two parallel files can both create the same new
// folder.

const dbState = vi.hoisted(() => ({ servers: [], settings: {}, audit: [] }));
// Holds callers of getDiskFree (an upload's free-space check, which comes
// after its destination check and before it creates folders) until `armed`
// of them have arrived, so two uploads interleave the same way every run.
const diskGate = vi.hoisted(() => ({ armed: 0, waiters: [] }));

vi.mock("../utils/diskSpace.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getDiskFree: async (...args) => {
      if (diskGate.armed > 0) {
        await new Promise((resolve) => {
          diskGate.waiters.push(resolve);
          if (diskGate.waiters.length >= diskGate.armed) {
            diskGate.armed = 0;
            for (const release of diskGate.waiters.splice(0)) release();
          }
        });
      }
      return actual.getDiskFree(...args);
    },
  };
});

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  const roles = { admin: { name: "admin", capabilities: ["files.manage", "bridge.setup", "serverfiles.manage"] } };
  return {
    ...actual,
    getRoleByName: async (name) => roles[name] || null,
    getServer: async (id) => dbState.servers.find((s) => String(s.id) === String(id)) || null,
    getServers: async () => dbState.servers,
    getAllSettings: async () => dbState.settings,
    getActiveServer: async () => dbState.servers.find((s) => s.isActive) || null,
    appendFileAudit: async (row) => {
      dbState.audit.unshift(row);
      return row;
    },
  };
});

const { default: filesRoutes } = await import("../routes/files.js");
const { invalidateRootCache } = await import("../services/fileManagerRoots.js");
const { _resetRunStateCacheForTests } = await import("../services/fileManagerRunState.js");
const service = await import("../services/fileManagerService.js");
const { _resetDenialCoalescingForTests } = await import("../services/fileManagerAudit.js");
const { _resetZipSlotsForTests, _setZipIdleMsForTests } = await import("../services/fileManagerZip.js");
const { managedStartupScriptName } = await import("../services/serverManager.js");

const ADMIN_SENTINEL = "AdminSentinel-9f3c";
const RCON_SENTINEL = "hunter2secret";
const P = "/api/files/profiles/p1";

let server;
let baseUrl;
let port;
let base;
let tree;
const processState = { running: false, scanFailed: false };

async function call(method, url, { userId = "u1", body, headers = {}, raw } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      "x-test-role": "admin",
      "x-test-user": userId,
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

async function zipEntriesHolding(buffer, needle) {
  const dir = await unzipper.Open.buffer(buffer);
  const hits = [];
  for (const entry of dir.files) {
    if ((await entry.buffer()).toString("utf8").includes(needle)) hits.push(entry.path);
  }
  return hits;
}

const q = (rel) => encodeURIComponent(rel);

beforeAll(async () => {
  const app = express();
  app.put("/api/files/profiles/:profileId/text", express.json({ limit: "6mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    if (req.get("x-test-role")) {
      const id = req.get("x-test-user") || "u1";
      req.user = { userId: id, username: `user-${id}`, role: req.get("x-test-role") };
    }
    next();
  });
  app.set("serverManager", { getServerProcessDetails: async () => ({ ...processState, matched: [], owned: [] }) });
  app.use("/api/files", filesRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  base = makeTempDir();
  tree = makeServerTree(base);
  dbState.servers = [tree.profile];
  dbState.settings = {};
  dbState.audit = [];
  diskGate.armed = 0;
  processState.running = false;
  processState.scanFailed = false;
  invalidateRootCache();
  _resetRunStateCacheForTests();
  _resetDenialCoalescingForTests();
  _resetZipSlotsForTests();
  service._resetPreviewsForTests();
  service._resetTransferSlotsForTests();
  service._setDownloadIdleMsForTests(undefined);
});

afterEach(() => {
  removeDir(base);
});

describe("secrets the panel writes into server folders", () => {
  it("a managed launch script's -adminpassword never leaves: listed, but not read, copied or zipped", async () => {
    const script = managedStartupScriptName("servertest");
    const line = `"%JAVA%" zombie.network.GameServer -servername "servertest" -adminpassword "${ADMIN_SENTINEL}"\r\n`;
    write(path.join(tree.install, script), `@echo off\r\n${line}`);
    // The copy the panel keeps of a hand-edited script holds it too.
    const copy = `${script}.bak-2026-09-29T00-00-00-000Z`;
    write(path.join(tree.install, copy), `@echo off\r\n${line}`);

    const listing = await call("GET", `${P}/list?root=install&path=`);
    expect(listing.status).toBe(200);
    for (const name of [script, copy]) {
      const row = listing.body.entries.find((e) => e.name === name);
      expect(row?.protection, name).toEqual({ level: "listOnly", area: "launchScripts" });
      for (const url of [
        `${P}/text?root=install&path=${q(name)}`,
        `${P}/text?root=install&path=${q(name)}&mode=tail`,
        `${P}/download?root=install&path=${q(name)}`,
      ]) {
        const res = await call("GET", url);
        expect(res.status, url).toBe(403);
        expect(res.buffer.toString("utf8")).not.toContain(ADMIN_SENTINEL);
      }
      const dup = await call("POST", `${P}/copy`, { body: { root: "install", path: name, newName: "copy.txt", confirm: ["serverRunning"] } });
      expect(dup.status, name).toBe(403);
    }
    expect(fs.existsSync(path.join(tree.install, "copy.txt"))).toBe(false);

    const zip = await call("POST", `${P}/zip`, { body: { root: "install", paths: [""] } });
    expect(zip.status).toBe(200);
    expect(await zipEntriesHolding(zip.buffer, ADMIN_SENTINEL)).toEqual([]);
  });

  it("the .ini backup the file manager makes on save stays masked on every way out", async () => {
    const read = await call("GET", `${P}/text?root=data&path=Server/servertest.ini`);
    expect(read.status).toBe(200);
    expect(read.body.content).not.toContain(RCON_SENTINEL);
    const save = await call("PUT", `${P}/text`, {
      body: { root: "data", path: "Server/servertest.ini", content: `${read.body.content}MaxPlayers=8\n`, etag: read.body.etag, eol: "crlf", bom: false, confirm: [] },
    });
    expect(save.status).toBe(200);

    const listing = await call("GET", `${P}/list?root=data&path=Server/backups`);
    const bak = listing.body.entries.find((e) => e.name.endsWith(".bak"));
    expect(bak).toBeTruthy();
    expect(bak.flags.secretBearing).toBe(true);
    // The live backup really holds the secret: masking is what keeps it in.
    expect(fs.readFileSync(path.join(tree.config, "backups", bak.name), "utf8")).toContain(RCON_SENTINEL);

    const edit = await call("GET", `${P}/text?root=data&path=${q(bak.path)}`);
    expect(edit.status).toBe(200);
    expect(edit.body.masked).toBe(true);
    expect(edit.body.content).not.toContain(RCON_SENTINEL);
    const tail = await call("GET", `${P}/text?root=data&path=${q(bak.path)}&mode=tail`);
    expect(tail.status).toBe(200);
    expect(tail.body.content).not.toContain(RCON_SENTINEL);
    const dl = await call("GET", `${P}/download?root=data&path=${q(bak.path)}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("x-file-masked")).toBe("1");
    expect(dl.buffer.toString("utf8")).not.toContain(RCON_SENTINEL);
    const zip = await call("POST", `${P}/zip`, { body: { root: "data", paths: ["Server"] } });
    expect(zip.status).toBe(200);
    expect(await zipEntriesHolding(zip.buffer, RCON_SENTINEL)).toEqual([]);

    // Saving the masked text back keeps the live secret instead of the mask.
    const back = await call("PUT", `${P}/text`, {
      body: { root: "data", path: bak.path, content: `${edit.body.content}# note\n`, etag: edit.body.etag, eol: "crlf", bom: false, confirm: [] },
    });
    expect(back.status).toBe(200);
    expect(fs.readFileSync(path.join(tree.config, "backups", bak.name), "utf8")).toContain(`RCONPassword=${RCON_SENTINEL}`);
  });
});

describe("a Zomboid folder inside the game folder (-cachedir)", () => {
  function nest() {
    const install = path.join(base, "PZServer");
    const data = path.join(install, "Zomboid");
    write(path.join(install, "ProjectZomboid64.json"), "{}\n");
    write(path.join(data, "Server", "servertest.ini"), `PVP=true\r\nRCONPassword=${RCON_SENTINEL}\r\n`);
    write(path.join(data, "Saves", "Multiplayer", "servertest", "map_0_0.bin"), "world");
    write(path.join(data, "db", "servertest.db"), "players");
    write(path.join(data, "backups", "world-1.zip"), "zip-bytes");
    write(path.join(data, "notes.txt"), "hello");
    dbState.servers = [{ ...tree.profile, installPath: install, zomboidDataPath: data, serverConfigPath: path.join(data, "Server") }];
    invalidateRootCache();
  }

  it("World Backups stay list-only through the install root", async () => {
    nest();
    const targets = [["data", "backups/world-1.zip"], ["install", "Zomboid/backups/world-1.zip"]];
    // A different spelling only names the same folder where the filesystem folds case;
    // on Linux "zomboid/BACKUPS" doesn't exist, so it is an ordinary 404 there.
    if (process.platform === "win32" || process.platform === "darwin") targets.push(["install", "zomboid/BACKUPS/world-1.zip"]);
    for (const [root, rel] of targets) {
      const res = await call("GET", `${P}/download?root=${root}&path=${q(rel)}`);
      expect(res.status, `${root}:${rel}`).toBe(403);
      expect(res.body.code).toBe("FM_PATH_PROTECTED");
    }
    const preview = await call("POST", `${P}/delete/preview`, { body: { root: "install", paths: ["Zomboid/backups"] } });
    expect(preview.status).toBe(403);
  });

  it("a world save stays blocked while its server runs, through the install root too", async () => {
    nest();
    processState.running = true;
    const preview = await call("POST", `${P}/delete/preview`, { body: { root: "install", paths: ["Zomboid/Saves/Multiplayer/servertest"] } });
    expect(preview.status).toBe(200);
    expect(preview.body.items[0].worldState).toBe(true);
    const del = await call("POST", `${P}/delete`, {
      body: { root: "install", previewId: preview.body.previewId, mode: "trash", confirm: ["serverRunning"] },
    });
    expect(del.status).toBe(409);
    expect(del.body.code).toBe("FM_SERVER_RUNNING_BLOCKED");
    const whole = await call("POST", `${P}/rename`, { body: { root: "install", path: "Zomboid", newName: "Zomboid-old", confirm: ["serverRunning"] } });
    expect(whole.status).toBe(403);
    expect(fs.existsSync(path.join(base, "PZServer", "Zomboid", "Saves", "Multiplayer", "servertest", "map_0_0.bin"))).toBe(true);
  });

  it("the data root's Trash isn't reachable, listed or writable through the install root", async () => {
    nest();
    const preview = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["notes.txt"] } });
    const del = await call("POST", `${P}/delete`, { body: { root: "data", previewId: preview.body.previewId, mode: "trash", confirm: [] } });
    expect(del.status).toBe(200);
    expect(fs.existsSync(path.join(base, "PZServer", "Zomboid", ".zcp-trash"))).toBe(true);

    const listing = await call("GET", `${P}/list?root=install&path=Zomboid`);
    expect(listing.status).toBe(200);
    expect(listing.body.entries.map((e) => e.name)).not.toContain(".zcp-trash");
    const inside = await call("GET", `${P}/list?root=install&path=${q("Zomboid/.zcp-trash")}`);
    expect(inside.status).toBe(400);
    expect(inside.body.code).toBe("FM_INVALID_PATH");
    const mk = await call("POST", `${P}/mkdir`, {
      body: { root: "install", path: "Zomboid/.zcp-trash", name: "20200101T000000Z-deadbeef", confirm: ["serverRunning"] },
    });
    expect(mk.status).toBe(400);
    const found = await call("GET", `${P}/search?root=install&path=&q=notes`);
    expect(found.status).toBe(200);
    expect(found.body.results).toEqual([]);
  });
});

describe("transfer slots", () => {
  // A client that sends the request, takes the first chunk and stops reading.
  function stalledDownload(userId, rel) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(`GET ${P}/download?root=data&path=${q(rel)} HTTP/1.1\r\nHost: x\r\nx-test-role: admin\r\nx-test-user: ${userId}\r\n\r\n`);
        socket.once("data", () => {
          socket.pause();
          resolve(socket);
        });
      });
      socket.on("error", reject);
    });
  }

  it("a download that stops being read gives its slot back after the idle limit", async () => {
    service._setDownloadIdleMsForTests(500);
    fs.writeFileSync(path.join(tree.data, "big.bin"), Buffer.alloc(64 * 1024 * 1024, 1));
    const sockets = [];
    try {
      for (const user of ["a", "a", "b", "b"]) sockets.push(await stalledDownload(user, "big.bin"));
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const download = await call("GET", `${P}/download?root=data&path=Server/servertest_SandboxVars.lua`, { userId: "victim" });
      expect(download.status).toBe(200);
      const upload = await call("POST", `${P}/upload`, {
        userId: "victim",
        raw: "hello",
        headers: { "content-type": "application/octet-stream", "x-file-root": "data", "x-file-dir": "", "x-file-name": "note.txt" },
      });
      expect(upload.status).toBe(201);
      const aborted = dbState.audit.filter((row) => row.op === "files.download" && row.result === "aborted");
      expect(aborted.length).toBe(4);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  }, 30000);
});

describe("audit", () => {
  it("a refused delete preview is recorded with the root and the path that was refused", async () => {
    const first = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["backups/world-1.zip"] } });
    expect(first.status).toBe(403);
    const second = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["notes-ok.txt", "Lua/panelbridge/servertest/status.json"] } });
    expect(second.status).toBe(404);
    write(path.join(tree.data, "notes-ok.txt"), "ok");
    const third = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["notes-ok.txt", "Lua/panelbridge/servertest/status.json"] } });
    expect(third.status).toBe(403);
    const denied = dbState.audit.filter((row) => row.op === "files.denied");
    expect(denied.map((row) => ({ rootId: row.rootId, path: row.paths[0], attemptedOp: row.attemptedOp })).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { rootId: "data", path: "backups/world-1.zip", attemptedOp: "files.delete.preview" },
      { rootId: "data", path: "Lua/panelbridge/servertest/status.json", attemptedOp: "files.delete.preview" },
    ]);
  });
});

describe("folder upload", () => {
  it("two files uploaded at once into a folder that doesn't exist yet both land", async () => {
    // Warm the root cache, so only the uploads' own free-space checks meet at the gate.
    expect((await call("GET", P)).status).toBe(200);
    diskGate.armed = 2;
    const send = (name) =>
      call("POST", `${P}/upload`, {
        raw: `${name} body`,
        headers: {
          "content-type": "application/octet-stream",
          "x-file-root": "data",
          "x-file-dir": encodeURIComponent("Server/newmod"),
          "x-file-name": name,
          "x-file-mkdirs": "1",
        },
      });
    const results = await Promise.all([send("a.lua"), send("b.lua")]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    for (const name of ["a.lua", "b.lua"]) {
      expect(fs.readFileSync(path.join(tree.config, "newmod", name), "utf8")).toBe(`${name} body`);
    }
  });

  it("a level that turns out to be a file is still refused", async () => {
    write(path.join(tree.config, "clash"), "a file");
    const res = await call("POST", `${P}/upload`, {
      raw: "x",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-root": "data",
        "x-file-dir": encodeURIComponent("Server/clash/sub"),
        "x-file-name": "x.txt",
        "x-file-mkdirs": "1",
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("FM_NOT_A_DIRECTORY");
  });
});

describe(".ini masking can't be sidestepped", () => {
  const INI = "Server/servertest.ini";
  const read = (rel) => call("GET", `${P}/text?root=data&path=${q(rel)}`);

  it("a rename, duplicate or restore-as to a name the file manager doesn't mask is refused", async () => {
    for (const newName of ["servertest.txt", "servertest", "notes.cfg", "servertest.ini.gz", "servertest.ini.zip"]) {
      const res = await call("POST", `${P}/rename`, { body: { root: "data", path: INI, newName, confirm: [] } });
      expect(res.status, newName).toBe(400);
      expect(res.body.code, newName).toBe("FM_SECRET_NAME_REQUIRED");
    }
    const copy = await call("POST", `${P}/copy`, { body: { root: "data", path: INI, destDir: "Server", newName: "x.txt", confirm: [] } });
    expect(copy.body.code).toBe("FM_SECRET_NAME_REQUIRED");
    expect(fs.existsSync(path.join(tree.config, "x.txt"))).toBe(false);

    // An earlier version of the .ini, kept in Trash by a save, can't come
    // back as plain text either.
    const opened = await read(INI);
    const saved = await call("PUT", `${P}/text`, {
      body: { root: "data", path: INI, content: opened.body.content.replace("PVP=true", "PVP=false"), etag: opened.body.etag, eol: "crlf", bom: false, confirm: [] },
    });
    expect(saved.status).toBe(200);
    const restoreAs = await call("POST", `${P}/trash/restore`, {
      body: { root: "data", trashId: saved.body.previousVersion.trashId, restoreAs: "old.txt", confirm: [] },
    });
    expect(restoreAs.body.code).toBe("FM_SECRET_NAME_REQUIRED");
    expect(fs.existsSync(path.join(tree.config, "old.txt"))).toBe(false);
  });

  it("the usual hand-made backup names stay masked on every way out", async () => {
    for (const newName of ["servertest.ini.bak", "servertest.ini.old", "servertest.ini.2026-09-30"]) {
      const renamed = await call("POST", `${P}/rename`, { body: { root: "data", path: INI, newName, confirm: [] } });
      expect(renamed.status, newName).toBe(200);
      const rel = `Server/${newName}`;
      expect((await read(rel)).body.content, newName).not.toContain(RCON_SENTINEL);
      expect((await call("GET", `${P}/download?root=data&path=${q(rel)}`)).buffer.toString("utf8"), newName).not.toContain(RCON_SENTINEL);
      const zip = await call("POST", `${P}/zip`, { body: { root: "data", paths: [rel] } });
      expect(await zipEntriesHolding(zip.buffer, RCON_SENTINEL), newName).toEqual([]);
      const back = await call("POST", `${P}/rename`, { body: { root: "data", path: rel, newName: "servertest.ini", confirm: [] } });
      expect(back.status).toBe(200);
    }
  });

  it("an archived copy (servertest.ini.gz) downloads byte for byte, alone and in a zip", async () => {
    // Masking rewrites a file as UTF-8 text: a compressed copy came out
    // corrupted, with the "passwords are hidden" notice. Its passwords are
    // inside compressed bytes, which masking couldn't reach anyway.
    const original = zlib.gzipSync(fs.readFileSync(path.join(tree.config, "servertest.ini")));
    expect(original.includes(0xff) || original.includes(0x00)).toBe(true);
    for (const name of ["servertest.ini.gz", "servertest.ini.zip"]) {
      fs.writeFileSync(path.join(tree.config, name), original);
      const listed = await call("GET", `${P}/list?root=data&path=Server`);
      expect(listed.body.entries.find((entry) => entry.name === name).flags.secretBearing, name).toBe(false);
      const res = await call("GET", `${P}/download?root=data&path=${q(`Server/${name}`)}`);
      expect(res.status, name).toBe(200);
      expect(res.headers.get("x-file-masked"), name).toBeNull();
      expect(res.buffer.equals(original), name).toBe(true);
    }
    expect(zlib.gunzipSync(original).toString("utf8")).toContain(RCON_SENTINEL);
    const zip = await call("POST", `${P}/zip`, { body: { root: "data", paths: ["Server"] } });
    expect(zip.status).toBe(200);
    const archive = await unzipper.Open.buffer(zip.buffer);
    for (const name of ["servertest.ini.gz", "servertest.ini.zip"]) {
      const entry = archive.files.find((file) => file.path.endsWith(`/${name}`));
      expect((await entry.buffer()).equals(original), name).toBe(true);
    }
    // The ini itself and its text copies are still masked in the same zip.
    const ini = archive.files.find((file) => file.path.endsWith("/servertest.ini"));
    expect((await ini.buffer()).toString("utf8")).not.toContain(RCON_SENTINEL);
  });

  it("the tail view never starts inside a secret line", async () => {
    // A save can put a secret line last (the editor's reconcile goes by key).
    const ini = "PVP=true\r\nMaxPlayers=8\r\nRCONPassword=MyLongSecretValue9\r\n";
    fs.writeFileSync(path.join(tree.config, "servertest.ini"), ini);
    for (let tailBytes = 1; tailBytes <= ini.length; tailBytes++) {
      const res = await call("GET", `${P}/text?root=data&path=${q(INI)}&mode=tail&tailBytes=${tailBytes}`);
      expect(res.status).toBe(200);
      expect(res.body.content, `tailBytes=${tailBytes}`).not.toMatch(/cretValue9|ValueNine|LongSecret/);
    }
  });

  it("no plain hash of a secret-bearing file's bytes leaves the server (etag, conflict, audit, upload)", async () => {
    const ini = "PVP=true\r\nRCONPassword=q7xpass\r\nMaxPlayers=8\r\n";
    fs.writeFileSync(path.join(tree.config, "servertest.ini"), ini);
    const sha = (text) => crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
    const opened = await read(INI);
    expect(opened.body.content).not.toContain("q7xpass");
    expect(opened.body.etag).toMatch(/^h:[0-9a-f]{64}$/);
    expect(opened.body.etag).not.toBe(`h:${sha(ini)}`);

    const stale = await call("PUT", `${P}/text`, {
      body: { root: "data", path: INI, content: opened.body.content, etag: `h:${"0".repeat(64)}`, eol: "crlf", bom: false, confirm: [] },
    });
    expect(stale.body.code).toBe("FM_CONFLICT");
    // The conflict's etag is the one the editor would get now: it saves.
    expect(stale.body.params.currentEtag).toBe(opened.body.etag);

    const edited = opened.body.content.replace("PVP=true", "PVP=false");
    const saved = await call("PUT", `${P}/text`, {
      body: { root: "data", path: INI, content: edited, etag: stale.body.params.currentEtag, eol: "crlf", bom: false, confirm: [] },
    });
    expect(saved.status).toBe(200);
    const onDisk = fs.readFileSync(path.join(tree.config, "servertest.ini"), "utf8");
    expect(onDisk).toContain("RCONPassword=q7xpass");
    expect(saved.body.etag).not.toBe(`h:${sha(onDisk)}`);
    // Its etag is the one a fresh read gives, so the editor can save again.
    expect((await read(INI)).body.etag).toBe(saved.body.etag);
    const row = dbState.audit.find((entry) => entry.op === "files.write");
    expect(row).toMatchObject({ sha256Before: null, sha256After: null });

    const download = await call("GET", `${P}/download?root=data&path=${q(INI)}`);
    const current = await call("GET", `${P}/stat?root=data&path=${q(INI)}`);
    const upload = await call("POST", `${P}/upload`, {
      raw: download.buffer,
      headers: {
        "content-type": "application/octet-stream",
        "x-file-root": "data",
        "x-file-dir": "Server",
        "x-file-name": "servertest.ini",
        "x-file-overwrite-etag": current.body.entry.etag,
        "x-file-confirm": "overwrite",
      },
    });
    expect(upload.status).toBe(201);
    expect(upload.body.sha256).toBeNull();
    expect(dbState.audit.find((entry) => entry.op === "files.upload")).toMatchObject({ sha256After: null });
  });

  it("a stale save whose secret line changed is a conflict, not an unmatched-secret error", async () => {
    const opened = await read(INI);
    // Someone rewrote the file without its RCONPassword line meanwhile.
    fs.writeFileSync(path.join(tree.config, "servertest.ini"), "PVP=false\r\nPassword=\r\n");
    const res = await call("PUT", `${P}/text`, {
      body: { root: "data", path: INI, content: opened.body.content, etag: opened.body.etag, eol: "crlf", bom: false, confirm: [] },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("FM_CONFLICT");
    expect(res.body.params.currentEtag).toMatch(/^h:[0-9a-f]{64}$/);

    // The same for a masked download uploaded back over a changed file.
    const download = await call("GET", `${P}/download?root=data&path=${q(INI)}`);
    const before = await call("GET", `${P}/stat?root=data&path=${q(INI)}`);
    fs.writeFileSync(path.join(tree.config, "servertest.ini"), "PVP=true\r\n");
    const upload = await call("POST", `${P}/upload`, {
      raw: download.buffer,
      headers: {
        "content-type": "application/octet-stream",
        "x-file-root": "data",
        "x-file-dir": "Server",
        "x-file-name": "servertest.ini",
        "x-file-overwrite-etag": before.body.entry.etag,
        "x-file-confirm": "overwrite",
      },
    });
    expect(upload.status).toBe(409);
    expect(upload.body.code).toBe("FM_CONFLICT");
  });

  it("a save against a file that grew past the editor limit is refused before anything reads it", async () => {
    fs.writeFileSync(path.join(tree.data, "Logs", "huge.txt"), Buffer.alloc(3 * 1024 * 1024, 0x61));
    const res = await call("PUT", `${P}/text`, {
      body: { root: "data", path: "Logs/huge.txt", content: "x", etag: `h:${"0".repeat(64)}`, eol: "lf", bom: false, confirm: [] },
    });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("FM_FILE_TOO_LARGE_FOR_EDITOR");
    expect(fs.statSync(path.join(tree.data, "Logs", "huge.txt")).size).toBe(3 * 1024 * 1024);
  });
});

describe("a refused upload still gets its answer to the client", () => {
  // A plain HTTP client streaming a body far bigger than any socket buffer:
  // closing the connection on it right after the refusal made the OS reset
  // it, and the client never saw the 409.
  function uploadRaw(headers, size) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${P}/upload`, {
        method: "POST",
        headers: { "x-test-role": "admin", "x-test-user": "u1", "content-length": String(size), ...headers },
      });
      req.on("response", (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      req.on("error", reject);
      const chunk = Buffer.alloc(256 * 1024, 0x61);
      let sent = 0;
      const pump = () => {
        while (sent < size) {
          const piece = chunk.subarray(0, Math.min(chunk.length, size - sent));
          sent += piece.length;
          if (!req.write(piece)) {
            req.once("drain", pump);
            return;
          }
        }
        req.end();
      };
      pump();
    });
  }

  it("the name is taken: the client reads 409 FM_EXISTS, not a reset", async () => {
    const res = await uploadRaw(
      { "content-type": "application/octet-stream", "x-file-root": "data", "x-file-dir": "Server", "x-file-name": "servertest.ini" },
      4 * 1024 * 1024,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("FM_EXISTS");
  });

  it("an unknown server: the client reads 404, not a reset", async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}/api/files/profiles/nope/upload`, {
        method: "POST",
        headers: {
          "x-test-role": "admin",
          "x-test-user": "u1",
          "content-type": "application/octet-stream",
          "content-length": String(4 * 1024 * 1024),
          "x-file-root": "data",
          "x-file-name": "a.bin",
        },
      });
      req.on("response", (r) => {
        r.resume();
        r.on("end", () => resolve({ status: r.statusCode }));
      });
      req.on("error", reject);
      req.end(Buffer.alloc(4 * 1024 * 1024, 1));
    });
    expect(res.status).toBe(404);
  });
});

describe("zip slots", () => {
  function stalledZip(userId, paths) {
    const body = JSON.stringify({ root: "data", paths });
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          `POST ${P}/zip HTTP/1.1\r\nHost: x\r\nx-test-role: admin\r\nx-test-user: ${userId}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
        socket.once("data", () => {
          socket.pause();
          resolve(socket);
        });
      });
      socket.on("error", reject);
    });
  }

  it("a zip whose client stops reading gives its slot back after the idle limit", async () => {
    _setZipIdleMsForTests(500);
    // Incompressible, so the socket buffers fill and the writer stalls.
    fs.mkdirSync(path.join(tree.data, "big"));
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(tree.data, "big", `f${i}.bin`), crypto.randomBytes(24 * 1024 * 1024));
    const sockets = [];
    try {
      sockets.push(await stalledZip("a", ["big"]), await stalledZip("b", ["big"]));
      const busy = await call("POST", `${P}/zip`, { userId: "c", body: { root: "data", paths: ["Server"] } });
      expect(busy.status).toBe(429);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const later = await call("POST", `${P}/zip`, { userId: "c", body: { root: "data", paths: ["Server"] } });
      expect(later.status).toBe(200);
    } finally {
      for (const socket of sockets) socket.destroy();
      _setZipIdleMsForTests(undefined);
    }
  }, 60000);
});
