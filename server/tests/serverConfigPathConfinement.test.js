import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// FILES-2 (security sweep 2026-10-04): a server's serverConfigPath was saved
// with no check at all, and the Server Files routes used it as the folder
// they read and write and as an image-browser root, next to serverPath (an
// install folder, also unconfined). A technician -- servers.manage +
// serverfiles.manage, no files.manage -- could point either at any folder on
// this computer, list every file name there, fetch its images and write
// .ini/.lua files into it. Promoted from the verifier's repro
// (secsweep/verify-files/technicianPathFields.test.mjs).
//
// Full stack through the real servers and server-files routers and the real,
// unmocked database/init.js (the suite's per-file temp dataDir keeps it
// isolated), with the signed-in role injected as req.user -- the verifier's
// shape. requirePermission() resolves the seeded roles from the real DB.
const db = await import("../database/init.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { default: serverFilesRouter } = await import("../routes/serverFiles.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

// 1x1 PNG
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

let baseUrl;
let httpServer;
let currentRole = "technician";
let root;
let installDir;
let dataDir;
let configDir;
let outsideDir;
let outsideDir2;
let serverId;

async function call(method, url, body) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* binary */
  }
  return { status: res.status, json, headers: res.headers };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-config-path-"));
  installDir = path.join(root, "pz-install");
  dataDir = path.join(root, "Zomboid");
  configDir = path.join(dataDir, "Server");
  outsideDir = path.join(root, "unrelated-host-dir");
  outsideDir2 = path.join(root, "unrelated-host-dir-2");
  for (const d of [installDir, configDir, path.join(dataDir, "Saves"), outsideDir, outsideDir2]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(configDir, "Victim.ini"), "PublicName=Victim\n");
  fs.writeFileSync(path.join(outsideDir, "private-notes.txt"), "not a PZ file\n");
  fs.writeFileSync(path.join(outsideDir, "credentials.env"), "X=1\n");
  fs.writeFileSync(path.join(outsideDir, "photo.png"), PNG);
  fs.writeFileSync(path.join(outsideDir2, "other.conf"), "y\n");

  await db.initDatabase();
  const server = await db.createServer({
    name: "Victim",
    serverName: "Victim",
    installPath: installDir,
    zomboidDataPath: dataDir,
    serverConfigPath: configDir,
    rconHost: "127.0.0.1",
    rconPort: 27999,
    rconPassword: "x",
  });
  serverId = server.id;
  await db.setActiveServer(serverId);

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("serverManager", { reloadConfig: async () => {} });
  app.use("/api/servers", serversRouter);
  app.use("/api/server-files", serverFilesRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => httpServer?.close(r));
});

async function resetRecord() {
  await db.updateServer(serverId, {
    zomboidDataPath: dataDir,
    serverConfigPath: configDir,
    serverPath: "",
  });
}

describe("PUT /api/servers/:id -- serverConfigPath is confined to <zomboidDataPath>/Server (FILES-2)", () => {
  it("refuses an existing folder outside the data folder, and leaves the record alone", async () => {
    await resetRecord();
    currentRole = "technician";
    const r = await call("PUT", `/api/servers/${serverId}`, { serverConfigPath: outsideDir });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(ErrorCode.SERVER_CONFIG_PATH_OUTSIDE_DATA);
    expect((await db.getServer(serverId)).serverConfigPath).toBe(configDir);
  });

  it("refuses a folder that doesn't exist yet outside it", async () => {
    await resetRecord();
    currentRole = "technician";
    const r = await call("PUT", `/api/servers/${serverId}`, {
      serverConfigPath: path.join(root, "does-not-exist"),
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(ErrorCode.SERVER_CONFIG_PATH_OUTSIDE_DATA);
  });

  it("refuses a value that only names the Server folder before a ..", async () => {
    await resetRecord();
    currentRole = "technician";
    const r = await call("PUT", `/api/servers/${serverId}`, {
      serverConfigPath: `${configDir}${path.sep}..${path.sep}..${path.sep}unrelated-host-dir`,
    });
    expect(r.status).toBe(400);
  });

  it("refuses the data folder itself and a sibling whose name starts like Server", async () => {
    await resetRecord();
    currentRole = "technician";
    for (const value of [dataDir, path.join(dataDir, "Server2")]) {
      const r = await call("PUT", `/api/servers/${serverId}`, { serverConfigPath: value });
      expect(r.status).toBe(400);
    }
  });

  it("refuses a link inside the Server folder that leads outside it", async () => {
    await resetRecord();
    const link = path.join(configDir, "escape");
    fs.rmSync(link, { recursive: true, force: true });
    // A junction needs no privilege on Windows; elsewhere it is a symlink.
    fs.symlinkSync(outsideDir, link, process.platform === "win32" ? "junction" : "dir");
    try {
      currentRole = "technician";
      for (const value of [link, path.join(link, "not-there-yet")]) {
        const r = await call("PUT", `/api/servers/${serverId}`, { serverConfigPath: value });
        expect(r.status).toBe(400);
        expect(r.json.code).toBe(ErrorCode.SERVER_CONFIG_PATH_OUTSIDE_DATA);
      }
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });

  it("refuses a config folder when the record has no data folder to anchor it", async () => {
    await db.updateServer(serverId, { zomboidDataPath: null, serverConfigPath: null });
    try {
      currentRole = "technician";
      const r = await call("PUT", `/api/servers/${serverId}`, { serverConfigPath: configDir });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe(ErrorCode.SERVER_CONFIG_PATH_OUTSIDE_DATA);
    } finally {
      await resetRecord();
    }
  });

  it("refuses it for admin too: it's a shape rule, not a permission", async () => {
    await resetRecord();
    currentRole = "admin";
    const r = await call("PUT", `/api/servers/${serverId}`, { serverConfigPath: outsideDir });
    expect(r.status).toBe(400);
  });

  it("accepts <zomboidDataPath>/Server, a folder inside it, and empty", async () => {
    await resetRecord();
    currentRole = "technician";
    const inside = path.join(configDir, "not-created-yet");
    for (const value of [inside, configDir, ""]) {
      const r = await call("PUT", `/api/servers/${serverId}`, { serverConfigPath: value });
      expect(r.status).toBe(200);
      expect((await db.getServer(serverId)).serverConfigPath).toBe(value);
    }
    await resetRecord();
  });

  it("judges a new config folder against the data folder sent in the same edit", async () => {
    await resetRecord();
    const otherData = path.join(root, "OtherZomboid");
    fs.mkdirSync(path.join(otherData, "Server"), { recursive: true });
    fs.mkdirSync(path.join(otherData, "Saves"), { recursive: true });
    currentRole = "technician";
    const r = await call("PUT", `/api/servers/${serverId}`, {
      zomboidDataPath: otherData,
      serverConfigPath: path.join(otherData, "Server"),
    });
    expect(r.status).toBe(200);
    await resetRecord();
  });

  it("lets an edit through that sends an unchanged config folder back, even one saved before this check", async () => {
    // The edit dialog sends the whole record back on every save.
    await db.updateServer(serverId, { serverConfigPath: outsideDir });
    try {
      currentRole = "technician";
      const r = await call("PUT", `/api/servers/${serverId}`, {
        name: "Victim renamed",
        serverConfigPath: outsideDir,
      });
      expect(r.status).toBe(200);
    } finally {
      await db.updateServer(serverId, { name: "Victim" });
      await resetRecord();
    }
  });

  // Adversary pass 2: Server Files only holds a config folder to the data
  // folder when the record has one, so clearing the data folder used to let
  // a refused (pre-check) config folder be read and written again.
  it("judges the stored config folder again when the data folder is cleared or moved", async () => {
    await db.updateServer(serverId, { serverConfigPath: outsideDir });
    const otherData = path.join(root, "OtherZomboid");
    fs.mkdirSync(path.join(otherData, "Server"), { recursive: true });
    fs.mkdirSync(path.join(otherData, "Saves"), { recursive: true });
    try {
      currentRole = "technician";
      for (const zomboidDataPath of ["", otherData]) {
        const r = await call("PUT", `/api/servers/${serverId}`, { zomboidDataPath });
        expect(r.status).toBe(400);
        expect(r.json.code).toBe(ErrorCode.SERVER_CONFIG_PATH_OUTSIDE_DATA);
        const stored = await db.getServer(serverId);
        expect(stored.zomboidDataPath).toBe(dataDir);
        expect(stored.serverConfigPath).toBe(outsideDir);
      }
      const raw = await call("GET", "/api/server-files/raw/ini");
      expect(raw.status).toBe(400);
      expect(raw.json.code).toBe(ErrorCode.SERVER_CONFIG_PATH_OUTSIDE_DATA);
    } finally {
      await resetRecord();
    }
  });

  it("still clears both folders together, and moves the data folder with a config folder inside it", async () => {
    await resetRecord();
    const otherData = path.join(root, "OtherZomboid");
    fs.mkdirSync(path.join(otherData, "Server"), { recursive: true });
    fs.mkdirSync(path.join(otherData, "Saves"), { recursive: true });
    try {
      currentRole = "technician";
      const cleared = await call("PUT", `/api/servers/${serverId}`, {
        zomboidDataPath: "",
        serverConfigPath: "",
      });
      expect(cleared.status).toBe(200);
      await resetRecord();
      await db.updateServer(serverId, { serverConfigPath: "" });
      const moved = await call("PUT", `/api/servers/${serverId}`, { zomboidDataPath: otherData });
      expect(moved.status).toBe(200);
    } finally {
      await resetRecord();
    }
  });
});

describe("POST /api/servers -- serverConfigPath is confined the same way (FILES-2)", () => {
  const created = [];
  afterAll(async () => {
    for (const id of created) await db.deleteServer(id).catch(() => {});
    await db.setActiveServer(serverId);
  });

  const body = (extra) => ({
    name: `Created ${created.length}`,
    serverName: `Created${created.length}`,
    installPath: installDir,
    rconHost: "127.0.0.1",
    rconPort: 28000 + created.length,
    rconPassword: "x",
    ...extra,
  });

  it("refuses a config folder outside the data folder it is created with", async () => {
    currentRole = "technician";
    const r = await call("POST", "/api/servers", body({ zomboidDataPath: dataDir, serverConfigPath: outsideDir }));
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(ErrorCode.SERVER_CONFIG_PATH_OUTSIDE_DATA);
  });

  it("refuses a config folder with no data folder", async () => {
    currentRole = "technician";
    const r = await call("POST", "/api/servers", body({ serverConfigPath: configDir }));
    expect(r.status).toBe(400);
  });

  it("accepts the pair every setup flow sends: <data> and <data>/Server", async () => {
    currentRole = "technician";
    const r = await call("POST", "/api/servers", body({ zomboidDataPath: dataDir, serverConfigPath: configDir }));
    expect(r.status).toBe(201);
    created.push(r.json.server.id);
  });
});

describe("Server Files -- what the image browser may reach (FILES-2)", () => {
  it("no longer lists or previews a folder named only by serverPath", async () => {
    await resetRecord();
    await db.updateServer(serverId, { serverPath: outsideDir2 });
    try {
      currentRole = "technician";
      const r = await call(
        "GET",
        `/api/server-files/browse-files?path=${encodeURIComponent(outsideDir2)}&extensions=.conf`,
      );
      expect(r.status).toBe(403);
      expect(r.json.code).toBe(ErrorCode.BROWSE_ACCESS_DENIED);
    } finally {
      await resetRecord();
    }
  });

  it("no longer lists or previews a config folder saved outside the data folder before this check", async () => {
    await db.updateServer(serverId, { serverConfigPath: outsideDir });
    try {
      currentRole = "technician";
      // Every Server Files route refuses the record outright now (adversary
      // pass), not just the browser.
      const listed = await call(
        "GET",
        `/api/server-files/browse-files?path=${encodeURIComponent(outsideDir)}&extensions=.txt,.env`,
      );
      expect(listed.status).toBe(400);
      expect(listed.json.code).toBe("SERVER_CONFIG_PATH_OUTSIDE_DATA");
      // ...nor through the default, which starts in the config folder.
      const byDefault = await call("GET", "/api/server-files/browse-files?extensions=.txt,.env");
      expect(byDefault.status).toBe(400);
      const image = await call(
        "GET",
        `/api/server-files/image-preview?path=${encodeURIComponent(path.join(outsideDir, "photo.png"))}`,
      );
      expect(image.status).toBe(400);
    } finally {
      await resetRecord();
    }
  });

  it("still browses the config folder, and the data folder with files.manage", async () => {
    await resetRecord();
    fs.writeFileSync(path.join(configDir, "icon.png"), PNG);
    currentRole = "technician";
    const byDefault = await call("GET", "/api/server-files/browse-files");
    expect(byDefault.status).toBe(200);
    expect(byDefault.json.files.map((f) => f.name)).toContain("icon.png");
    // The data folder itself is a root only for files.manage (adversary
    // pass: a technician sets the data folder, so it can't be the root).
    const technicianData = await call(
      "GET",
      `/api/server-files/browse-files?path=${encodeURIComponent(dataDir)}`,
    );
    expect(technicianData.status).toBe(403);
    currentRole = "admin";
    const data = await call("GET", `/api/server-files/browse-files?path=${encodeURIComponent(dataDir)}`);
    expect(data.status).toBe(200);
    expect(data.json.directories).toContain("Server");
    currentRole = "technician";
    const image = await call(
      "GET",
      `/api/server-files/image-preview?path=${encodeURIComponent(path.join(configDir, "icon.png"))}`,
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
  });

  it("a refused config folder never becomes where raw edits land", async () => {
    await resetRecord();
    currentRole = "technician";
    const refused = await call("PUT", `/api/servers/${serverId}`, { serverConfigPath: outsideDir });
    expect(refused.status).toBe(400);
    const r = await call("PUT", "/api/server-files/raw/sandbox", { content: "-- chosen\n" });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(outsideDir, "Victim_SandboxVars.lua"))).toBe(false);
    expect(fs.readFileSync(path.join(configDir, "Victim_SandboxVars.lua"), "utf8")).toBe("-- chosen\n");
  });
});
