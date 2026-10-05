import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// Security sweep 2026-10-05, HT3: GET /api/server-files/paths gives a role
// without the host-path capabilities (utils/hostPathView.js) the config
// folder as the placeholder (H4 round 3), but GET /browse-files answered
// serverfiles.manage with that same folder, absolute, as currentPath and
// parent. Round 3 kept it for the image picker, which wrote the absolute
// path it picked into the ini. The picker's fields (ServerImageLoginScreen,
// ServerImageLoadingScreen, ServerImageIcon) are gone: Build 42's
// ServerOptions doesn't declare them (nothing in the 42.21 jar or the
// game's Lua reads them) and Server Config dropped them in 1.1.25. So such
// a role now names folders and images by a root id and the path below it,
// in what GET /browse-files answers and in what it and GET /image-preview
// take; an absolute path from it is refused. The host-path roles keep
// absolute paths.
//
// Real router, real database, real files.

const init = await import("../database/init.js");
const { default: serverFilesRouter } = await import("../routes/serverFiles.js");

const MARKER = `zcp-ht3-${process.pid}`;
const ROOT = path.join(os.tmpdir(), MARKER);
const DATA_DIR = path.join(ROOT, "Zomboid");
const CONFIG_DIR = path.join(DATA_DIR, "Server");
const IMAGES_DIR = path.join(CONFIG_DIR, "images");
const LOGO = path.join(IMAGES_DIR, "logo.png");
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let baseUrl;
let httpServer;
let currentRole = "technician";

async function get(url) {
  const res = await fetch(baseUrl + url);
  const type = res.headers.get("content-type") || "";
  const body = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, type, body };
}

const browse = (ref) =>
  get(`/api/server-files/browse-files${ref === undefined ? "" : `?path=${encodeURIComponent(ref)}`}`);
const preview = (ref) => get(`/api/server-files/image-preview?path=${encodeURIComponent(ref)}`);

beforeAll(async () => {
  await init.initDatabase();
  await init.insertRole({ id: "role-ht3-files", name: "ht3-files", capabilities: ["serverfiles.manage"] });
  await init.insertRole({
    id: "role-ht3-files-fm",
    name: "ht3-files-fm",
    capabilities: ["serverfiles.manage", "files.manage"],
  });

  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, "servertest.ini"), "PVP=false\n");
  fs.writeFileSync(LOGO, PNG_BYTES);
  const server = await init.createServer({
    name: "HT3",
    serverName: "servertest",
    installPath: path.join(ROOT, "pz install"),
    zomboidDataPath: DATA_DIR,
    serverConfigPath: CONFIG_DIR,
  });
  await init.setActiveServer(server.id);

  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.use("/api/server-files", serverFilesRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("serverfiles.manage without host folders: root references", () => {
  it("GET /browse-files opens the config folder by reference, as GET /paths hides it", async () => {
    currentRole = "ht3-files";

    const { status, body } = await browse();

    expect(status).toBe(200);
    expect(body.currentPath).toBe("data:/");
    expect(body.parent).toBeNull();
    expect(body.directories).toContain("images");
    expect(JSON.stringify(body)).not.toContain(MARKER);
    const paths = await get("/api/server-files/paths");
    expect(JSON.stringify(paths.body)).not.toContain(MARKER);
  });

  it("walks down and back up by reference, the way the dialog joins names", async () => {
    currentRole = "ht3-files";
    const top = (await browse()).body;
    // ServerConfig.tsx joins currentPath and a folder name with '/' when
    // currentPath ends in one or holds one, else with '\'.
    const join = (folder, name) =>
      folder + (folder.endsWith("/") || folder.endsWith("\\") ? "" : folder.includes("/") ? "/" : "\\") + name;

    const down = await browse(join(top.currentPath, "images"));
    expect(down.status).toBe(200);
    expect(down.body.currentPath).toBe("data:/images");
    expect(down.body.parent).toBe("data:/");
    expect(down.body.files).toEqual([{ name: "logo.png", ext: ".png" }]);
    expect(JSON.stringify(down.body)).not.toContain(MARKER);

    const up = await browse(down.body.parent);
    expect(up.body.currentPath).toBe("data:/");

    // Backslashes after the root id work too.
    expect((await browse("data:\\images")).body.currentPath).toBe("data:/images");
  });

  it("GET /image-preview serves the image a reference names", async () => {
    currentRole = "ht3-files";

    const { status, type, body } = await preview("data:/images/logo.png");

    expect(status).toBe(200);
    expect(type).toBe("image/png");
    expect(Buffer.compare(body, PNG_BYTES)).toBe(0);
  });

  it("refuses an absolute path, even one inside the roots, so a guessed folder isn't confirmed", async () => {
    currentRole = "ht3-files";

    for (const response of [await browse(CONFIG_DIR), await browse(IMAGES_DIR), await preview(LOGO)]) {
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("BROWSE_ACCESS_DENIED");
    }
    const outside = await browse(ROOT);
    expect(outside.status).toBe(403);
    expect(outside.body).toEqual((await browse(CONFIG_DIR)).body);
  });

  it("refuses a reference that climbs out of its root or names no root", async () => {
    currentRole = "ht3-files";

    for (const ref of ["data:/..", "data:/images/../..", "data:\\..\\..", "data:/C:/Windows", "nope:/", "data"]) {
      const response = await browse(ref);
      expect(response.status, ref).toBe(403);
      expect(response.body.code).toBe("BROWSE_ACCESS_DENIED");
    }
    expect((await preview("data:/../Server/images/logo.png")).status).toBe(403);
  });

  it("files.manage widens the root to the whole data folder, still by reference", async () => {
    currentRole = "ht3-files-fm";

    const { status, body } = await browse();

    expect(status).toBe(200);
    expect(body.currentPath).toBe("data:/Server");
    expect(body.parent).toBe("data:/");
    expect(JSON.stringify(body)).not.toContain(MARKER);
  });
});

describe("a role that sees host folders keeps absolute paths", () => {
  it("technician: absolute in, absolute out, and a reference works too", async () => {
    currentRole = "technician";

    const top = await browse();
    expect(top.status).toBe(200);
    expect(top.body.currentPath).toBe(CONFIG_DIR);

    const down = await browse(IMAGES_DIR);
    expect(down.body.currentPath).toBe(IMAGES_DIR);
    expect(down.body.parent).toBe(CONFIG_DIR);

    expect((await browse("data:/images")).body.currentPath).toBe(IMAGES_DIR);
    expect((await preview(LOGO)).status).toBe(200);
    expect((await preview("data:/images/logo.png")).status).toBe(200);
  });
});
