import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// Security sweep 2026-10-05, HT2: a config backup that fails returns the raw
// fs message, which quotes the config folder ("ENOTDIR: not a directory,
// mkdir '<config>/backups'"). backupWarningFor() redacted it for ordinary
// saves (H4 round 3), but two Server Files routes quoted it themselves and
// answer serverfiles.manage, a role that can't see that folder elsewhere:
//   - POST /sandbox/repair's 422 `error` (its params.reason was redacted);
//   - POST /restore/:filename's `backupWarning`.
// configBackup.js's createBackup() now returns the error path-redacted, so
// every caller gets the redacted text. The panel log keeps it whole.
//
// Real router, real database, real files; one fs call is made to fail.

const init = await import("../database/init.js");
const { default: serverFilesRouter } = await import("../routes/serverFiles.js");
const { createBackup } = await import("../utils/configBackup.js");

const MARKER = `zcp-ht2-${process.pid}`;
const ROOT = path.join(os.tmpdir(), MARKER);
const DATA_DIR = path.join(ROOT, "Zomboid");
const CONFIG_DIR = path.join(DATA_DIR, "Server");
const INI = path.join(CONFIG_DIR, "servertest.ini");
const SANDBOX = path.join(CONFIG_DIR, "servertest_SandboxVars.lua");
const BACKUP_DIR = path.join(CONFIG_DIR, "backups");
// Unbalanced, in a shape repairSandboxSyntax() knows how to fix.
const BROKEN_SANDBOX = ["Vehicles = {", "    OrphanKey = true", "        NestedKey = 5,", "    }", "}"].join("\n");

let baseUrl;
let httpServer;
let currentRole = "technician";

const serverManager = {
  reloadConfig: async () => {},
  getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
};

async function post(url) {
  const res = await fetch(baseUrl + url, { method: "POST" });
  return { status: res.status, body: await res.json() };
}

// A plain file where the backups folder must be: a real backup failure.
function breakBackupsFolder() {
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  fs.writeFileSync(BACKUP_DIR, "not a directory");
}

function fixBackupsFolder() {
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
}

beforeAll(async () => {
  await init.initDatabase();
  await init.insertRole({ id: "role-ht2-files", name: "ht2-files", capabilities: ["serverfiles.manage"] });

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(INI, "PVP=false\nMods=\nWorkshopItems=\nMap=Muldraugh, KY\n");
  const server = await init.createServer({
    name: "HT2",
    serverName: "servertest",
    installPath: path.join(ROOT, "pz install"),
    zomboidDataPath: DATA_DIR,
    serverConfigPath: CONFIG_DIR,
  });
  await init.setActiveServer(server.id);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("serverManager", serverManager);
  app.set("io", null);
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

describe("createBackup(): a failure's error is path-redacted", () => {
  it("says what failed without the config folder", async () => {
    breakBackupsFolder();
    try {
      const backup = await createBackup(CONFIG_DIR, "servertest.ini");
      expect(backup).toMatchObject({ backedUp: false, reason: "failed" });
      expect(backup.error).toMatch(/E(NOTDIR|EXIST)/);
      expect(backup.error).not.toContain(MARKER);
    } finally {
      fixBackupsFolder();
    }
  });
});

describe("Server Files routes that quote a failed backup", () => {
  for (const role of ["ht2-files", "technician"]) {
    it(`${role}: POST /sandbox/repair's refusal names no folder, and changes nothing`, async () => {
      currentRole = role;
      fs.writeFileSync(SANDBOX, BROKEN_SANDBOX);
      breakBackupsFolder();
      try {
        const { status, body } = await post("/api/server-files/sandbox/repair");
        expect(status).toBe(422);
        expect(body.code).toBe("SANDBOX_REPAIR_BACKUP_FAILED");
        expect(body.error).toMatch(/Could not back up SandboxVars\.lua before repairing it/);
        expect(body.params.reason.length).toBeGreaterThan(0);
        expect(JSON.stringify(body)).not.toContain(MARKER);
        expect(fs.readFileSync(SANDBOX, "utf-8")).toBe(BROKEN_SANDBOX);
      } finally {
        fixBackupsFolder();
        fs.rmSync(SANDBOX, { force: true });
      }
    });

    it(`${role}: POST /restore/:filename's backupWarning names no folder, and the restore happens`, async () => {
      currentRole = role;
      fs.writeFileSync(INI, "PVP=false\n");
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const backupName = "servertest.ini.2026-10-01T00-00-00-000Z.bak";
      fs.writeFileSync(path.join(BACKUP_DIR, backupName), "PVP=true\n");
      // Node's own copyfile text, as an EACCES on a root-owned backups
      // folder (a common Docker ownership state) gives it.
      const spy = vi.spyOn(fs.promises, "copyFile").mockImplementationOnce(async (src, dst) => {
        const error = new Error(`EACCES: permission denied, copyfile '${src}' -> '${dst}'`);
        error.code = "EACCES";
        throw error;
      });
      try {
        const { status, body } = await post(`/api/server-files/restore/${backupName}`);
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.backupWarning).toMatch(/Could not back up the current servertest\.ini before restoring over it: EACCES/);
        expect(JSON.stringify(body)).not.toContain(MARKER);
        expect(fs.readFileSync(INI, "utf-8")).toBe("PVP=true\n");
      } finally {
        spy.mockRestore();
        fixBackupsFolder();
      }
    });
  }
});
