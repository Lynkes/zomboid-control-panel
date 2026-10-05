import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// W5-P3 (security sweep 2026-10-05): a local record with no data folder
// falls back to its install folder for the console log. One that wasn't
// there yet passed the data-folder rule (a folder not created yet is
// accepted), so the Console page showed "no log" and no reason; with no
// install folder at all the routes answered SERVER_DATA_PATH_NOT_CONFIGURED,
// which doesn't say where to set the folder. With no data folder set, the
// panel's start script passes the game no -cachedir, so the log is never
// written in the install folder: that one counts only when it already holds
// the game's console log, and otherwise the routes answer
// SERVER_CONSOLE_LOG_NO_DATA_FOLDER, as for an install folder the rule
// refuses.
//
// The real router over the real, unmocked database layer (the suite's
// per-file temp data dir keeps it isolated), signed in as admin.
const db = await import("../database/init.js");
const { default: serverRouter } = await import("../routes/server.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

let baseUrl;
let httpServer;
let root;
let serverId;

async function call(method, url) {
  const res = await fetch(baseUrl + url, { method });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

function write(file, content = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-console-install-fallback-"));
  const installDir = path.join(root, "pz-install");
  write(path.join(installDir, "ProjectZomboid64.exe"));

  await db.initDatabase();
  const server = await db.createServer({
    name: "Victim",
    serverName: "Victim",
    installPath: installDir,
    rconHost: "127.0.0.1",
    rconPort: 27971,
    rconPassword: "x",
  });
  serverId = server.id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "u-admin", username: "admin", role: "admin" };
    next();
  });
  app.set("serverManager", { reloadConfig: async () => {} });
  app.use("/api/server", serverRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

async function useNoDataFolder(installPath) {
  await db.updateServer(serverId, { isRemote: false, zomboidDataPath: null, serverConfigPath: null, installPath });
  await db.setActiveServer(serverId);
  // setActiveServer() copies the record's folders to the legacy settings.
  await db.setSetting("zomboidDataPath", null);
  await db.setSetting("serverPath", null);
}

async function expectSetTheDataFolder() {
  const log = await call("GET", "/api/server/console-log?filter=all");
  expect(log.status).toBe(200);
  expect(log.json.exists).toBe(false);
  expect(log.json.refusal?.code).toBe(ErrorCode.SERVER_CONSOLE_LOG_NO_DATA_FOLDER);
  expect(log.json.refusal.error).toContain("My Servers page");
  const stream = await call("GET", "/api/server/console-log/stream?lastSize=0");
  expect(stream.json.refusal?.code).toBe(ErrorCode.SERVER_CONSOLE_LOG_NO_DATA_FOLDER);
  const cleared = await call("POST", "/api/server/console-log/clear");
  expect(cleared.status).toBe(400);
  expect(cleared.json.code).toBe(ErrorCode.SERVER_CONSOLE_LOG_NO_DATA_FOLDER);
}

describe("the console log of a local record with no data folder", () => {
  it("says to set the data folder when the install folder isn't there yet", async () => {
    const notYet = path.join(root, "not-installed-yet");
    await useNoDataFolder(notYet);
    await expectSetTheDataFolder();
    expect(fs.existsSync(notYet)).toBe(false);
  });

  it("and when the install folder holds no console log", async () => {
    const empty = path.join(root, "empty-install");
    fs.mkdirSync(empty, { recursive: true });
    await useNoDataFolder(empty);
    await expectSetTheDataFolder();
  });

  it("and when no install folder is set either", async () => {
    await useNoDataFolder("");
    await expectSetTheDataFolder();
  });

  it("still reads an install folder that meets the rule and holds the game's console log", async () => {
    const cachedir = path.join(root, "install-as-cachedir");
    write(path.join(cachedir, "server-console.txt"), "SERVER STARTED\nthe custom launcher's line\n");
    await useNoDataFolder(cachedir);
    const log = await call("GET", "/api/server/console-log?filter=all");
    expect(log.json.refusal).toBeUndefined();
    expect(log.json.exists).toBe(true);
    expect(log.json.lines).toContain("the custom launcher's line");
  });
});
