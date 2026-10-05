import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Security sweep 2026-10-05, HT2: POST /api/server/wipe refuses to delete
// anything when its backup fails, and said why in the text of its 500 --
// the backup's own message, and for the accounts database the raw fs error,
// both of which can quote the save or backups folder. server.wipe can be a
// custom role without the host-path capabilities, and the wipe's other
// failure answer (WIPE_PARTIAL_FAILURE) already redacted the same kind of
// text. Both abort answers now go through sanitizeError() too.

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(),
  getActiveServer: vi.fn(),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { default: router } = await import("../routes/server.js");
const { getActiveServer } = await import("../database/init.js");

const SERVER_NAME = "servertest";
const MARKER = `zcp-ht2-wipe-${process.pid}`;

let root;
let saveDir;

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getWipeHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/wipe" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

async function wipe(backupService, targets) {
  const serverManager = {
    loadConfig: async () => {},
    reloadConfig: async () => {},
    getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
  };
  const app = {
    get: (key) => {
      if (key === "serverManager") return serverManager;
      if (key === "backupService") return backupService;
      return undefined;
    },
  };
  const response = createResponse();
  await getWipeHandler()({ app, body: { targets, confirm: true } }, response);
  return response;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), `${MARKER}-`));
  saveDir = path.join(root, "Saves", "Multiplayer", SERVER_NAME);
  fs.mkdirSync(path.join(saveDir, "map"), { recursive: true });
  fs.writeFileSync(path.join(saveDir, "map", "0_0.bin"), "chunk");
  getActiveServer.mockResolvedValue({ zomboidDataPath: root, serverName: SERVER_NAME });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("POST /api/server/wipe: a failed backup's reason names no folder", () => {
  it("the save backup's own message", async () => {
    const backupService = {
      createBackup: vi.fn(async () => ({
        success: false,
        message: `EACCES: permission denied, open '${path.join(root, "backups", "servertest_2026.zip.tmp")}'`,
      })),
    };

    const response = await wipe(backupService, ["map"]);

    expect(response.status).toHaveBeenCalledWith(500);
    const payload = response.json.mock.calls[0][0];
    expect(payload.code).toBe("WIPE_BACKUP_FAILED");
    expect(payload.error).toMatch(/^Wipe aborted: could not create a backup first \(EACCES: permission denied/);
    expect(JSON.stringify(payload)).not.toContain(MARKER);
    // Nothing was deleted.
    expect(fs.existsSync(path.join(saveDir, "map", "0_0.bin"))).toBe(true);
  });

  it("the accounts database copy's fs error", async () => {
    const dbFile = path.join(root, "db", `${SERVER_NAME}.db`);
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.writeFileSync(dbFile, "whitelist");
    // A plain file where the backups folder must be: mkdir fails, quoting it.
    const backupsDir = path.join(root, "backups");
    fs.writeFileSync(backupsDir, "not a directory");
    const backupService = {
      createBackup: vi.fn(async () => ({ success: true, backup: { name: "servertest_2026.zip" } })),
      getBackupsPath: vi.fn(async () => backupsDir),
    };

    const response = await wipe(backupService, ["accounts"]);

    expect(response.status).toHaveBeenCalledWith(500);
    const payload = response.json.mock.calls[0][0];
    expect(payload.code).toBe("WIPE_BACKUP_FAILED");
    expect(payload.error).toMatch(/^Wipe aborted: could not back up the accounts database \(E(NOTDIR|EXIST)/);
    expect(JSON.stringify(payload)).not.toContain(MARKER);
    // The accounts database is still there.
    expect(fs.readFileSync(dbFile, "utf-8")).toBe("whitelist");
  });

  it("legit: a fixed-text reason reads as before", async () => {
    const backupService = {
      createBackup: vi.fn(async () => ({ success: false, message: "Backup already in progress" })),
    };

    const response = await wipe(backupService, ["map"]);

    expect(response.json.mock.calls[0][0].error).toBe(
      "Wipe aborted: could not create a backup first (Backup already in progress). Nothing was deleted.",
    );
  });
});
