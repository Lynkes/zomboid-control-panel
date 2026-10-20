import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init, startApp, tokenWithCapabilities, setupAuth } from "./helpers/authzHarness.js";
import { redactPanelDbForBackup } from "../utils/panelDbRedaction.js";

// SECURITY (2026-10-20, access-control audit): POST /api/backup/create spread
// its request body into createBackup(), so any backups.manage holder (the
// seeded Technician, who also holds backups.download) could put the panel
// database -- every account's bcrypt hash -- into a backup with
// {"includeDb":true}. The stored setting now decides alone, and what goes in
// is a redacted copy with no credential or session in it.

const { BackupService } = await import("../services/backupService.js");
const { default: backupRouter } = await import("../routes/backup.js");
const { getDataPaths } = await import("../utils/paths.js");

let root;
let savesPath;
let backupsPath;

function service() {
  const s = new BackupService();
  s.getSavesPath = async () => savesPath;
  s.getBackupsPath = async () => backupsPath;
  s.setServerManager({ getServerProcessDetails: async () => ({ running: false, scanFailed: false }) });
  return s;
}

async function zipEntries(zipPath) {
  const unzipper = (await import("unzipper")).default;
  const directory = await unzipper.Open.file(zipPath);
  const entries = {};
  for (const file of directory.files) entries[file.path] = file;
  return entries;
}

beforeAll(async () => {
  await setupAuth();
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-db-"));
  savesPath = path.join(root, "Saves", "Multiplayer", "servertest");
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(savesPath, { recursive: true });
  fs.mkdirSync(backupsPath, { recursive: true });
  fs.writeFileSync(path.join(savesPath, "map_meta.bin"), "LIVE");
  await init.setSetting("backupIncludeDb", false);
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("redactPanelDbForBackup()", () => {
  it("leaves out password hashes, sessions, recovery codes and secret-like settings everywhere in the tree", () => {
    const data = {
      users: [
        {
          id: "u1",
          username: "alice",
          role: "admin",
          password: "$2a$12$hashhashhash",
          tokenGen: 3,
          refreshSessions: [{ id: "s1", hash: "abc" }],
          evictedRefreshSessions: [{ id: "s0" }],
          recoveryCodes: { entries: [{ hash: "x" }] },
          externalIdentities: [{ issuer: "https://idp", subject: "sub-1" }],
        },
      ],
      settings: {
        jwtSecret: "jwt",
        authRecoveryCodes: ["a"],
        discordBotToken: "bot",
        steamLoginSecure: "cookie",
        steamSessionId: "sid",
        panelBridge: { sftpPassword: "pw", host: "h" },
        backupMaxCount: 5,
      },
      discord_webhooks: [{ url: "https://discord/hook" }],
      user_templates: [{ meta: { name: "t" }, serverIni: { DiscordToken: "t", PVP: "true" } }],
      roles: [{ id: "role-admin", name: "admin", capabilities: ["users.manage"] }],
    };
    const before = JSON.stringify(data);
    const out = redactPanelDbForBackup(data);
    const text = JSON.stringify(out);
    for (const secret of ["$2a$12$", "refreshSessions", "evictedRefreshSessions", "recoveryCodes", "jwt\"", "authRecoveryCodes", "bot\"", "cookie", "sid\"", "sftpPassword", "discord/hook", "DiscordToken", "tokenGen"]) {
      expect(text).not.toContain(secret);
    }
    expect(out.users[0].username).toBe("alice");
    expect(out.users[0].externalIdentities[0].subject).toBe("sub-1");
    expect(out.settings.backupMaxCount).toBe(5);
    expect(out.settings.panelBridge.host).toBe("h");
    expect(out.user_templates[0].serverIni.PVP).toBe("true");
    expect(out.roles[0].capabilities).toEqual(["users.manage"]);
    expect(out._backupRedaction).toMatch(/left out/);
    expect(JSON.stringify(data)).toBe(before);
  });
});

describe("BackupService.createBackup()", () => {
  it("ignores options.includeDb: the stored setting alone decides", async () => {
    const result = await service().createBackup({ includeDb: true });
    expect(result.success).toBe(true);
    const entries = await zipEntries(result.backup.path);
    expect(entries["db.json"]).toBeUndefined();
  });

  it("with the setting on, archives a redacted copy: accounts listed, no bcrypt hash or session", async () => {
    await init.setSetting("backupIncludeDb", true);
    const db = await init.getDb();
    expect(db.data.users.some((u) => typeof u.password === "string" && u.password.startsWith("$2"))).toBe(true);
    await init.commitNow();
    expect(fs.readFileSync(getDataPaths().dbPath, "utf8")).toMatch(/\$2[aby]\$/);

    const result = await service().createBackup({});
    expect(result.success).toBe(true);
    expect(result.skippedFiles).toEqual([]);
    const entries = await zipEntries(result.backup.path);
    const text = (await entries["db.json"].buffer()).toString("utf8");
    expect(text).toContain("rootadmin");
    expect(text).not.toMatch(/\$2[aby]\$/);
    expect(text).not.toContain("refreshSessions");
    expect(JSON.parse(text)._backupRedaction).toMatch(/left out/);
  });

  it("leaves the database out of a pre-restore or pre-wipe safety copy, as before", async () => {
    await init.setSetting("backupIncludeDb", true);
    const result = await service().createBackup({ isPreWipe: true });
    const entries = await zipEntries(result.backup.path);
    expect(entries["db.json"]).toBeUndefined();
  });
});

describe("POST /api/backup/create", () => {
  let app;
  let created;
  afterAll(async () => {
    await app?.close();
  });

  it("does not pass {includeDb:true} from a Technician's request body to the service", async () => {
    created = [];
    const token = await tokenWithCapabilities(["backups.manage", "backups.download"]);
    app = await startApp([["/api/backup", backupRouter]], {
      backupService: {
        createBackup: async (options) => {
          created.push(options);
          return { success: true, backup: { name: "x.zip" }, skippedFiles: [] };
        },
      },
      io: { to: () => ({ emit: () => {} }) },
    });
    const res = await app.call("POST", "/api/backup/create", token, { includeDb: true });
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(created[0].includeDb).toBeUndefined();
  });
});
