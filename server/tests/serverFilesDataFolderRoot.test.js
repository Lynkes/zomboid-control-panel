import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// FILES-2 adversary pass (security sweep 2026-10-04): the fix confined a
// server's config folder to <zomboidDataPath>/Server, but the data folder is
// itself a servers.manage edit (POST /api/servers stores it unchecked) and it
// stayed a file-browser root. A technician (servers.manage +
// serverfiles.manage, not files.manage) created a server whose data folder
// was any folder on this computer, then listed every file in it
// (credentials.env, private-notes.txt) and fetched its images through
// /api/server-files. A config folder saved before the check was also still
// read and written.
//
// Fix: without files.manage the browser's root is the data folder's Server
// folder, it lists image files only, and every Server Files route refuses a
// server record whose config folder sits outside those roots.
//
// Promoted from the adversary's filesTwoBypass.test.mjs. Full stack through
// the real routers and the real database layer.
const db = await import("../database/init.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { default: serverFilesRouter } = await import("../routes/serverFiles.js");

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

let root;
let installDir;
let victimRoot;
let victimServer;
let baseUrl;
let httpServer;
let currentRole = "technician";

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-files2-root-"));
  installDir = path.join(root, "pz-install");
  // A host folder nobody meant Server Files to reach.
  victimRoot = path.join(root, "victim-host-dir");
  victimServer = path.join(victimRoot, "Server");
  // PATHS-1 (2026-10-05): a data folder must now look like one when it is
  // saved and used -- POST /api/servers refuses a folder with these files and
  // no Saves folder (dataFolderRule.test.js). With a world save in its Saves
  // folder it does (PT1, 2026-10-05: an empty Saves folder no longer
  // counts), and these files beside it are what FILES-2's roots still keep
  // out.
  for (const dir of [installDir, victimServer, path.join(victimRoot, "Saves", "Multiplayer", "Victim")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(victimRoot, "Saves", "Multiplayer", "Victim", "map_t.bin"), "");
  fs.writeFileSync(path.join(victimRoot, "private-notes.txt"), "top secret\n");
  fs.writeFileSync(path.join(victimRoot, "credentials.env"), "AWS_SECRET=hunter2\n");
  fs.writeFileSync(path.join(victimRoot, "photo.png"), PNG);
  fs.writeFileSync(path.join(victimServer, "icon.png"), PNG);
  fs.writeFileSync(path.join(victimServer, "notes.env"), "KEY=1\n");

  await db.initDatabase();

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.use("/api/servers", serversRouter);
  app.use("/api/server-files", serverFilesRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  // The adversary's setup: a server whose data folder is the victim folder.
  currentRole = "technician";
  const created = await call("POST", "/api/servers", {
    name: "pwn",
    serverName: "pwn",
    installPath: installDir,
    zomboidDataPath: victimRoot,
    serverConfigPath: victimServer,
    rconHost: "127.0.0.1",
    rconPort: 27999,
    rconPassword: "x",
  });
  expect(created.status).toBe(201);
  await db.setActiveServer(created.json.server.id);
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

const browse = (target, extensions) =>
  call(
    "GET",
    `/api/server-files/browse-files?path=${encodeURIComponent(target)}${
      extensions ? `&extensions=${encodeURIComponent(extensions)}` : ""
    }`,
  );

describe("a data folder of the caller's choosing doesn't open it to Server Files", () => {
  it("can't list the data folder itself without files.manage", async () => {
    currentRole = "technician";
    const r = await browse(victimRoot, ".txt,.env,.png");
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("BROWSE_ACCESS_DENIED");
  });

  it("can't fetch an image from the data folder itself without files.manage", async () => {
    currentRole = "technician";
    const r = await call(
      "GET",
      `/api/server-files/image-preview?path=${encodeURIComponent(path.join(victimRoot, "photo.png"))}`,
    );
    expect(r.status).toBe(403);
  });

  it("the Server folder lists image files only, whatever extensions are asked for", async () => {
    currentRole = "technician";
    const r = await browse(victimServer, ".txt,.env,.png");
    expect(r.status).toBe(200);
    expect(r.json.files.map((f) => f.name)).toEqual(["icon.png"]);
    expect(r.json.parent).toBeNull();
  });

  it("a files.manage holder keeps the whole data folder, still images only", async () => {
    currentRole = "admin";
    const r = await browse(victimRoot, ".txt,.env,.png");
    expect(r.status).toBe(200);
    expect(r.json.files.map((f) => f.name)).toEqual(["photo.png"]);
  });
});

describe("a config folder saved before the save-time check", () => {
  it("is refused by every Server Files route, for writes too", async () => {
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    const active = await db.getActiveServer();
    await db.updateServer(active.id, { serverConfigPath: elsewhere });
    try {
      for (const role of ["technician", "admin"]) {
        currentRole = role;
        const write = await call("PUT", "/api/server-files/raw/ini", { content: "Pwned=1\n" });
        expect(write.status).toBe(400);
        expect(write.json.code).toBe("SERVER_CONFIG_PATH_OUTSIDE_DATA");
      }
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    } finally {
      await db.updateServer(active.id, { serverConfigPath: victimServer });
    }
  });
});
