import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";
import { withFileLock } from "../utils/fileWriteQueue.js";
import { runServerFilesRoute } from "./helpers/serverFilesRoute.js";

// re-entrancy-followups, 2026-09-10 (Kevin's sweep): every OTHER config
// writer in this file (PUT /ini, /sandbox, /sandbox-option, /spawnpoints,
// /spawnregions, /raw/:type) wraps its write in withFileLock(filePath, ...)
// and writes via writeFileAtomic (temp file in the same dir, then rename).
// POST /restore/:filename was the one exception: a direct
// `fs.promises.copyFile(backupPath, targetPath)` with no lock and no
// temp+rename. Two problems, not one:
//   1. No lock -- a concurrent PUT/restore on the same live targetPath could
//      interleave with this one, same lost-update race withFileLock exists
//      to prevent for its six siblings.
//   2. copyFile streams straight onto the live path -- a reader mid-copy
//      (or PZ itself reading the config while a restore writes it) could
//      observe a partially-restored file. Locking alone would NOT have
//      fixed this half; matching the siblings' write shape (writeFileAtomic)
//      does.
// Fixed by reading the backup into memory first, then wrapping the
// exists-check/pre-restore-backup/write in withFileLock(targetPath, ...)
// and writing via writeFileAtomic(targetPath, backupData) -- same helper,
// same lock key every sibling already uses.
const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/serverFiles.js");

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

// Runs the route behind the router's own gate, which sets
// req.activeServerContext and fails the test if it refuses the request
// (helpers/serverFilesRoute.js).
function runRoute(routePath, method, req) {
  return runServerFilesRoute(router, routePath, method, req, createResponse());
}

function postRestore(filename) {
  return runRoute("/restore/:filename", "post", { params: { filename } });
}

const SERVER_NAME = "servertest";
let configDir;
let backupDir;
let parentDir;

beforeEach(() => {
  // PATHS-2: a config folder is used only inside <data folder>/Server.
  parentDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "restore-filelock-")), "Server");
  fs.mkdirSync(parentDir);
  configDir = path.join(parentDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  backupDir = path.join(configDir, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  getActiveServer.mockReset().mockResolvedValue({
    zomboidDataPath: path.dirname(parentDir),
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
});

afterEach(() => {
  fs.rmSync(path.dirname(parentDir), { recursive: true, force: true });
});

describe("POST /restore/:filename -- now locked and atomic like its six siblings", () => {
  it("waits for a concurrent holder of the SAME live path's lock instead of writing through it", async () => {
    const targetFile = path.join(configDir, `${SERVER_NAME}.ini`);
    fs.writeFileSync(targetFile, "OLD-CONTENT");
    const backupName = `${SERVER_NAME}.ini.2026-09-10T00-00-00.bak`;
    fs.writeFileSync(path.join(backupDir, backupName), "RESTORED-CONTENT");

    const order = [];
    let releaseHolder;
    const holderReleased = new Promise((resolve) => {
      releaseHolder = resolve;
    });
    const holderPromise = withFileLock(targetFile, async () => {
      order.push("holder-start");
      await holderReleased;
      order.push("holder-end");
    });

    const restorePromise = postRestore(backupName).then((res) => {
      order.push("restore-done");
      return res;
    });

    // Give the restore route's own pre-lock work (readFile of the backup,
    // param parsing) a turn to run and reach its withFileLock call. If
    // restore isn't actually locked on targetFile, it finishes here --
    // well before releaseHolder() is ever called below.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["holder-start"]);

    releaseHolder();
    await holderPromise;
    const res = await restorePromise;

    expect(order).toEqual(["holder-start", "holder-end", "restore-done"]);
    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("RESTORED-CONTENT");
  });

  it("writes via temp-file+rename (writeFileAtomic), not a direct copyFile onto the live path", async () => {
    const targetFile = path.join(configDir, `${SERVER_NAME}.ini`);
    const backupName = `${SERVER_NAME}.ini.2026-09-10T01-00-00.bak`;
    fs.writeFileSync(path.join(backupDir, backupName), "RESTORED-CONTENT");

    const copyFileSpy = vi.spyOn(fs.promises, "copyFile");
    const renameSpy = vi.spyOn(fs, "renameSync");

    const res = await postRestore(backupName);

    expect(res.getStatusCode()).toBe(200);
    expect(copyFileSpy).not.toHaveBeenCalled();
    expect(renameSpy).toHaveBeenCalledTimes(1);
    const [tmpArg, destArg] = renameSpy.mock.calls[0];
    expect(destArg).toBe(targetFile);
    expect(path.dirname(tmpArg)).toBe(path.dirname(targetFile));
    expect(tmpArg).not.toBe(targetFile);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("RESTORED-CONTENT");

    copyFileSpy.mockRestore();
    renameSpy.mockRestore();
  });
});
