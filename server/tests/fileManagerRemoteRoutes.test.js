import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import express from "express";
import unzipper from "unzipper";

// /api/files for the active remote profile, end to end: the real routes and
// service over the real SFTP backend, talking to the in-memory fake SFTP
// server. This is where the service (WS-A) and the SFTP backend (WS-B) meet,
// so it checks the seams: roots derived from the PanelBridge SFTP settings,
// walk-based search, delete preview and zip, duplicate over an existing
// file, Trash, the protected bridge folder, and remote folder overrides.

const dbState = vi.hoisted(() => ({ servers: [], settings: {} }));

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  const roles = {
    admin: { name: "admin", capabilities: ["files.manage", "bridge.setup"] },
  };
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
  };
});

const { default: filesRoutes } = await import("../routes/files.js");
const { invalidateRootCache } = await import("../services/fileManagerRoots.js");
const { _resetRunStateCacheForTests } = await import("../services/fileManagerRunState.js");
const { _resetJobsForTests, _waitForJobForTests } = await import("../services/fileManagerJobs.js");
const service = await import("../services/fileManagerService.js");
const { _resetDenialCoalescingForTests } = await import("../services/fileManagerAudit.js");
const { _resetZipSlotsForTests } = await import("../services/fileManagerZip.js");
const { closeFileManagerSftpPool } = await import("../services/fileManagerSftpBackend.js");
const { _setFileManagerSftpTestHooks } = await import("../services/fileManagerSftpPool.js");
const { FakeSftpServer } = await import("./helpers/fakeSftp.js");

const DATA = "/srv/pz/Zomboid";
const P = "/api/files/profiles/r1";

let server;
let baseUrl;
let sftp;

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

const read = (rel) => sftp.readFile(`${DATA}/${rel}`)?.toString("utf8") ?? null;

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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  sftp = new FakeSftpServer();
  sftp.writeFile(`${DATA}/Server/servertest.ini`, "PVP=true\nPassword=hunter2\n");
  sftp.writeFile(`${DATA}/Logs/server.txt`, "log line\n");
  sftp.writeFile(`${DATA}/Logs/old/older.txt`, "older\n");
  sftp.writeFile(`${DATA}/Lua/panelbridge/servertest/status.json`, "{}");
  _setFileManagerSftpTestHooks({ clientFactory: sftp.clientFactory });
  dbState.servers = [{ id: "r1", name: "Remote", serverName: "servertest", isActive: true, provider: "remote-sftp", isRemote: true }];
  dbState.settings = {
    panelBridgeSftpHost: "sftp.test",
    panelBridgeSftpPort: 2222,
    panelBridgeSftpUsername: "pz",
    panelBridgeSftpPassword: "fake-sftp-password",
    panelBridgeSftpConfigPath: `${DATA}/Server`,
    panelBridgeSftpBridgePath: `${DATA}/Lua/panelbridge/servertest`,
  };
  invalidateRootCache();
  _resetRunStateCacheForTests();
  _resetJobsForTests();
  _resetDenialCoalescingForTests();
  _resetZipSlotsForTests();
  service._resetPreviewsForTests();
  service._resetTransferSlotsForTests();
});

afterEach(async () => {
  await closeFileManagerSftpPool();
  _setFileManagerSftpTestHooks();
  vi.restoreAllMocks();
});

describe("Server Files over SFTP (active remote profile)", () => {
  it("offers the derived Zomboid folder, and install only once it is set", async () => {
    const res = await call("GET", P);
    expect(res.status).toBe(200);
    const { profile } = res.body;
    expect(profile.remote).toEqual({ host: "sftp.test", port: 2222, username: "pz" });
    const byId = Object.fromEntries(profile.roots.map((r) => [r.id, r]));
    expect(byId.data).toMatchObject({ backend: "sftp", available: true, displayPath: DATA });
    expect(byId.install).toMatchObject({ available: false, unavailableReason: "remoteInstallNotSet" });
    expect(profile.remoteRoots).toEqual({ installPath: null, dataPath: null, derivedDataPath: DATA });
    expect(JSON.stringify(res.body)).not.toContain("fake-sftp-password");
    expect(profile.serverState).toBe("unknown");

    sftp.writeFile("/srv/pz/game/start-server.sh", "#!/bin/sh\n", { mode: 0o755 });
    const set = await call("PUT", `${P}/remote-roots`, { body: { installPath: "/srv/pz/game", dataPath: null } });
    expect(set.status).toBe(200);
    const install = set.body.profile.roots.find((r) => r.id === "install");
    expect(install).toMatchObject({ available: true, backend: "sftp", displayPath: "/srv/pz/game" });
    expect(set.body.profile.remoteRoots.installPath).toBe("/srv/pz/game");
  });

  it("lists, stats and searches without descending into the bridge folder's secrets", async () => {
    const list = await call("GET", `${P}/list?root=data&path=Logs`);
    expect(list.status).toBe(200);
    expect(list.body.entries.map((e) => e.name)).toEqual(["old", "server.txt"]);
    const stat = await call("GET", `${P}/stat?root=data&path=Logs/server.txt`);
    expect(stat.body.entry).toMatchObject({ name: "server.txt", type: "file", size: 9 });
    const search = await call("GET", `${P}/search?root=data&path=&q=older`);
    expect(search.status).toBe(200);
    expect(search.body.results.map((e) => e.path)).toEqual(["Logs/old/older.txt"]);
    const bridge = await call("GET", `${P}/list?root=data&path=Lua/panelbridge/servertest`);
    expect(bridge.status).toBe(200);
    expect(bridge.body.dir.protection).toMatchObject({ area: "bridgeIo" });
  });

  it("masks .ini secrets on the way out and keeps them on save", async () => {
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
    expect(read("Server/servertest.ini")).toBe("PVP=false\nPassword=hunter2\n");
    expect(saved.body.previousVersion?.trashId).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
    // The earlier version reads back from Trash, masked too.
    const earlier = await call("GET", `${P}/trash/text?root=data&trashId=${saved.body.previousVersion.trashId}`);
    expect(earlier.status).toBe(200);
    expect(earlier.body).toMatchObject({ eol: "lf", bom: false, masked: true });
    expect(earlier.body.content).toMatch(/^PVP=true$/m);
    expect(earlier.body.content).not.toContain("hunter2");
  });

  it("duplicates over an existing file only after the overwrite confirmation", async () => {
    const first = await call("POST", `${P}/copy`, { body: { root: "data", path: "Logs/server.txt", destDir: "Logs", confirm: [] } });
    expect(first.status).toBe(201);
    expect(read("Logs/server (copy).txt")).toBe("log line\n");
    sftp.writeFile(`${DATA}/Logs/server.txt`, "changed\n");
    const again = await call("POST", `${P}/copy`, {
      body: { root: "data", path: "Logs/server.txt", destDir: "Logs", newName: "server (copy).txt", confirm: [] },
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("FM_CONFIRMATION_REQUIRED");
    const confirmed = await call("POST", `${P}/copy`, {
      body: { root: "data", path: "Logs/server.txt", destDir: "Logs", newName: "server (copy).txt", confirm: again.body.params.required },
    });
    expect(confirmed.status).toBe(201);
    expect(read("Logs/server (copy).txt")).toBe("changed\n");
  });

  it("previews a folder delete by walking it, moves it to Trash and restores it", async () => {
    const preview = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["Logs"] } });
    expect(preview.status).toBe(200);
    expect(preview.body.items[0]).toMatchObject({ path: "Logs", type: "dir", files: 2, dirs: 2, bytes: 15 });
    const confirm = preview.body.required;
    const del = await call("POST", `${P}/delete`, { body: { root: "data", previewId: preview.body.previewId, mode: "trash", confirm } });
    expect(del.status).toBe(200);
    expect(del.body.trashed).toHaveLength(1);
    expect(sftp.exists(`${DATA}/Logs`)).toBe(false);
    const trash = await call("GET", `${P}/trash?root=data`);
    expect(trash.body.items.find((i) => i.originalPath === "Logs")).toMatchObject({ type: "dir", files: 2 });
    const restored = await call("POST", `${P}/trash/restore`, { body: { root: "data", trashId: del.body.trashed[0].trashId } });
    expect(restored.status).toBe(200);
    expect(read("Logs/old/older.txt")).toBe("older\n");
  });

  it("zips a folder read back entry by entry", async () => {
    const zip = await call("POST", `${P}/zip`, { body: { root: "data", paths: ["Logs"] } });
    expect(zip.status).toBe(200);
    const dir = await unzipper.Open.buffer(zip.buffer);
    const names = dir.files.map((f) => f.path).sort();
    expect(names).toEqual(expect.arrayContaining(["Logs/server.txt", "Logs/old/older.txt"]));
    expect(names.filter((n) => n === "Logs/" || n === "Logs")).toHaveLength(names.includes("Logs/") ? 1 : 0);
  });

  it("uploads a new file and refuses the bridge folder", async () => {
    const up = await call("POST", `${P}/upload`, {
      raw: "uploaded",
      headers: { "content-type": "application/octet-stream", "x-file-root": "data", "x-file-dir": "Logs", "x-file-name": "new.txt" },
    });
    expect(up.status).toBe(201);
    expect(read("Logs/new.txt")).toBe("uploaded");
    const refused = await call("POST", `${P}/upload`, {
      raw: "x",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-root": "data",
        "x-file-dir": encodeURIComponent("Lua/panelbridge/servertest"),
        "x-file-name": "evil.json",
      },
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("FM_PATH_PROTECTED");
  });

  it("deletes for good as a job", async () => {
    const preview = await call("POST", `${P}/delete/preview`, { body: { root: "data", paths: ["Logs/old"] } });
    const del = await call("POST", `${P}/delete`, {
      body: {
        root: "data",
        previewId: preview.body.previewId,
        mode: "permanent",
        confirm: [...preview.body.required, "permanent"],
        typedConfirmation: "old",
      },
    });
    expect(del.status).toBe(202);
    await _waitForJobForTests(del.body.jobId);
    const job = await call("GET", `/api/files/jobs/${del.body.jobId}`);
    expect(job.body.state).toBe("done");
    expect(sftp.exists(`${DATA}/Logs/old`)).toBe(false);
  });
});

describe("the bridge folder through a link", () => {
  it("stays protected when the settings reach the Zomboid folder through a link", async () => {
    // /home/pz/Zomboid -> /srv/pz/Zomboid: the data root's real path is the
    // link's target, which the settings never spell.
    sftp.symlink("/home/pz/Zomboid", DATA);
    sftp.writeFile(`${DATA}/bridge-io/servertest/status.json`, "{}");
    dbState.settings = {
      ...dbState.settings,
      panelBridgeSftpConfigPath: "/home/pz/Zomboid/Server",
      panelBridgeSftpBridgePath: "/home/pz/Zomboid/bridge-io/servertest",
    };
    invalidateRootCache();
    const list = await call("GET", `${P}/list?root=data&path=bridge-io/servertest`);
    expect(list.status).toBe(200);
    expect(list.body.dir.protection).toMatchObject({ area: "bridgeIo" });
    const forged = await call("PUT", `${P}/text`, {
      body: { root: "data", path: "bridge-io/servertest/commands.json", content: "{}", etag: null, eol: "lf", bom: false, confirm: [] },
    });
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe("FM_PATH_PROTECTED");
    expect(sftp.exists(`${DATA}/bridge-io/servertest/commands.json`)).toBe(false);
  });

  it("stays protected when only the bridge folder's own path goes through a link", async () => {
    // The data root is typed as the real folder, the bridge folder through
    // a link: only the server's REALPATH of the bridge folder matches.
    sftp.symlink("/home/pz/Zomboid", DATA);
    sftp.writeFile(`${DATA}/bridge-io/servertest/status.json`, "{}");
    dbState.settings = {
      ...dbState.settings,
      panelBridgeSftpConfigPath: `${DATA}/Server`,
      panelBridgeSftpBridgePath: "/home/pz/Zomboid/bridge-io/servertest",
    };
    invalidateRootCache();
    const list = await call("GET", `${P}/list?root=data&path=bridge-io/servertest`);
    expect(list.body.dir.protection).toMatchObject({ area: "bridgeIo" });
  });
});

describe("remote folder overrides", () => {
  it("are saved under the key the remote roots are read with, whatever the spacing of the login", async () => {
    dbState.settings = { ...dbState.settings, panelBridgeSftpHost: " sftp.test ", panelBridgeSftpUsername: " pz " };
    sftp.writeFile("/srv/pz/game/start-server.sh", "#!/bin/sh\n", { mode: 0o755 });
    const set = await call("PUT", `${P}/remote-roots`, { body: { installPath: "/srv/pz/game", dataPath: null } });
    expect(set.status).toBe(200);
    expect(Object.keys(dbState.settings.fileManagerRemoteRoots)).toEqual(["sftp.test:2222:pz"]);
    expect(set.body.profile.roots.find((r) => r.id === "install")).toMatchObject({ available: true });
  });
});
