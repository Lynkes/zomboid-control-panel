import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// Security sweep 2026-10-05, HT1: POST /api/templates/:id/apply answered
// with each backup's absolute path (<config>/backups/servertest.ini.<ts>.bak)
// to any templates.manage holder -- a custom role without the host-path
// capabilities included, which GET /api/servers already gives the
// placeholder for that config folder. It now answers with file names; the
// Templates page only counts them.
//
// Real router, real database, real files.

const init = await import("../database/init.js");
const { default: templatesRouter } = await import("../routes/templates.js");

const MARKER = `zcp-ht1-${process.pid}`;
const ROOT = path.join(os.tmpdir(), MARKER);
const DATA_DIR = path.join(ROOT, "Zomboid");
const CONFIG_DIR = path.join(DATA_DIR, "Server");
const INI = path.join(CONFIG_DIR, "servertest.ini");
const SANDBOX = path.join(CONFIG_DIR, "servertest_SandboxVars.lua");

let baseUrl;
let httpServer;
let currentRole = "technician";
let serverId;

const serverManager = {
  reloadConfig: async () => {},
  getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
};

async function apply(templateId, options) {
  const res = await fetch(`${baseUrl}/api/templates/${templateId}/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serverId, options }),
  });
  return { status: res.status, body: await res.json() };
}

function resetFiles() {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(INI, "PVP=false\nSafetySystem=true\nMods=\nWorkshopItems=\nMap=Muldraugh, KY\n");
  fs.writeFileSync(SANDBOX, "SandboxVars = {\n    VERSION = 6,\n    Zombies = 4,\n}\n");
}

beforeAll(async () => {
  await init.initDatabase();
  await init.insertRole({ id: "role-ht1-templates", name: "ht1-templates", capabilities: ["templates.manage"] });

  resetFiles();
  const server = await init.createServer({
    name: "HT1",
    serverName: "servertest",
    installPath: path.join(ROOT, "pz install"),
    zomboidDataPath: DATA_DIR,
    serverConfigPath: CONFIG_DIR,
  });
  serverId = server.id;
  await init.setActiveServer(server.id);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("serverManager", serverManager);
  app.use("/api/templates", templatesRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("POST /api/templates/:id/apply names its backups by file name", () => {
  for (const role of ["ht1-templates", "technician"]) {
    it(`${role}: each backup by name, and the copy is where Server Config lists it`, async () => {
      currentRole = role;
      resetFiles();

      const { status, body } = await apply("pvp-raiding", { applySandbox: false });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.backups).toHaveLength(1);
      const [name] = body.backups;
      expect(name).toMatch(/^servertest\.ini\..+\.bak$/);
      expect(path.basename(name)).toBe(name);
      expect(JSON.stringify(body)).not.toContain(MARKER);
      // The copy is real, and it is the old file.
      expect(fs.readFileSync(path.join(CONFIG_DIR, "backups", name), "utf-8")).toMatch(/^PVP=false$/m);
      // The apply itself still happened.
      expect(fs.readFileSync(INI, "utf-8")).toMatch(/^PVP=true$/m);
    });
  }

  it("an ini and a SandboxVars backup are two names", async () => {
    currentRole = "ht1-templates";
    resetFiles();

    const { status, body } = await apply("pvp-raiding", {});

    expect(status).toBe(200);
    expect(body.backups.length).toBeGreaterThanOrEqual(1);
    for (const name of body.backups) {
      expect(path.basename(name)).toBe(name);
      expect(fs.existsSync(path.join(CONFIG_DIR, "backups", name))).toBe(true);
    }
    expect(JSON.stringify(body)).not.toContain(MARKER);
  });
});
