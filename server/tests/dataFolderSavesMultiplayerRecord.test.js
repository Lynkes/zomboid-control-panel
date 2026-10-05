import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// PT2 (security sweep 2026-10-05, verifier round 1): in 1.4.5 Map Cleanup's
// "Save as default" set a server's data folder to <Zomboid>/Saves/Multiplayer
// and left its config folder, <Zomboid>/Server, as it was (1.4.5 used a
// record's config folder as it was). After the update the config folder had
// to be inside <data folder>/Server, so Server Files and Mods refused it
// (SERVER_CONFIG_PATH_OUTSIDE_DATA), and the console log was looked for in
// the Saves/Multiplayer folder only. The Zomboid folder two levels up is used
// too now -- only when it meets the data-folder rule on its own.
//
// Real routers over the real, unmocked database layer (the suite's per-file
// temp data dir keeps it isolated), with the signed-in role injected.
const db = await import("../database/init.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { default: serverRouter } = await import("../routes/server.js");
const { default: serverFilesRouter } = await import("../routes/serverFiles.js");
const { default: modsRouter } = await import("../routes/mods.js");
const { serverConfigDirOf, serverConfigPathIsConfined } = await import("../utils/serverConfigPath.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

let baseUrl;
let httpServer;
let root;
let installDir;
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
    /* not JSON */
  }
  return { status: res.status, json, text };
}

function write(file, content = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// A Zomboid folder as the game leaves one, with the server's own ini and
// console log, and as 1.4.5 left its Saves/Multiplayer folder (a world save,
// the Backups page's backups/).
function buildZomboid(name) {
  const zomboid = path.join(root, name, "Zomboid");
  const multiplayer = path.join(zomboid, "Saves", "Multiplayer");
  write(path.join(multiplayer, "Victim", "map_t.bin"), "t");
  write(path.join(multiplayer, "Victim", "map", "0", "0.bin"), "chunk");
  write(path.join(multiplayer, "backups", "Victim_2026-10-01T10-00-00-000.zip"), "zip");
  write(path.join(zomboid, "Server", "Victim.ini"), "Mods=RealMod\nWorkshopItems=\nMaxPlayers=12\n");
  write(path.join(zomboid, "server-console.txt"), "SERVER STARTED\nthe real server's line\n");
  write(path.join(zomboid, "Logs", "2026-10-01_10-00_chat.txt"), "");
  return { zomboid, multiplayer, config: path.join(zomboid, "Server") };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-saves-multiplayer-record-"));
  installDir = path.join(root, "pz-install");
  write(path.join(installDir, "ProjectZomboid64.exe"));

  await db.initDatabase();
  const server = await db.createServer({
    name: "Victim",
    serverName: "Victim",
    installPath: installDir,
    zomboidDataPath: buildZomboid("seed").zomboid,
    rconHost: "127.0.0.1",
    rconPort: 27971,
    rconPassword: "x",
  });
  serverId = server.id;

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = { id: "u-admin", username: "admin", role: "admin" };
    next();
  });
  app.set("serverManager", {
    reloadConfig: async () => {},
    getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
  });
  app.use("/api/servers", serversRouter);
  app.use("/api/server", serverRouter);
  app.use("/api/server-files", serverFilesRouter);
  app.use("/api/mods", modsRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.setActiveServer(serverId);
});

async function useRecord(record) {
  await db.updateServer(serverId, { isRemote: false, ...record });
  await db.setActiveServer(serverId);
}

describe("a 1.4.5 record: data folder <Zomboid>/Saves/Multiplayer, config folder <Zomboid>/Server", () => {
  it("Server Files and Mods read the server's own ini again", async () => {
    const { multiplayer, config } = buildZomboid("upgrade");
    await useRecord({ zomboidDataPath: multiplayer, serverConfigPath: config });
    expect(serverConfigDirOf(await db.getServer(serverId))).toMatchObject({ dir: config, refused: false });

    const ini = await call("GET", "/api/server-files/raw/ini");
    expect(ini.status).toBe(200);
    expect(ini.text).toContain("Mods=RealMod");

    const mods = await call("GET", "/api/mods/current-config");
    expect(mods.json.code).toBeUndefined();
    expect(mods.json.modIds).toContain("RealMod");
  });

  it("the Console page reads the log the server writes in the Zomboid folder", async () => {
    const { multiplayer, config } = buildZomboid("console");
    await useRecord({ zomboidDataPath: multiplayer, serverConfigPath: config });
    const log = await call("GET", "/api/server/console-log");
    expect(log.status).toBe(200);
    expect(log.json.exists).toBe(true);
    expect(log.json.content).toContain("the real server's line");

    // One the panel started with the Saves/Multiplayer folder as its
    // -cachedir writes its log there; that one comes first.
    write(path.join(multiplayer, "server-console.txt"), "SERVER STARTED\nthe cachedir's own line\n");
    const own = await call("GET", "/api/server/console-log");
    expect(own.json.content).toContain("the cachedir's own line");
  });

  it("can be saved as it is, and the default with no config folder stays <data folder>/Server", async () => {
    const { multiplayer, config } = buildZomboid("save");
    await useRecord({ zomboidDataPath: multiplayer, serverConfigPath: null });
    expect(serverConfigDirOf(await db.getServer(serverId)).dir).toBe(path.join(multiplayer, "Server"));

    const put = await call("PUT", `/api/servers/${serverId}`, { serverConfigPath: config });
    expect(put.status).toBe(200);
    expect((await db.getServer(serverId)).serverConfigPath).toBe(config);
  });

  it("only while the Zomboid folder meets the rule on its own: not around an empty Saves/Multiplayer", async () => {
    // An empty Saves/Multiplayer folder passes (the game fills it), but the
    // folder two levels up is someone's folder with a Server folder and a
    // console log of the right names in it.
    const home = path.join(root, "someones-home");
    const multiplayer = path.join(home, "Saves", "Multiplayer");
    fs.mkdirSync(multiplayer, { recursive: true });
    write(path.join(home, "Server", "Victim.ini"), "Mods=Hijacked\n");
    write(path.join(home, "server-console.txt"), "SERVER STARTED\nsomeone's line\n");
    write(path.join(home, "Documents", "plan.txt"), "private");
    const config = path.join(home, "Server");
    expect(serverConfigPathIsConfined(config, multiplayer)).toBe(false);

    await useRecord({ zomboidDataPath: multiplayer, serverConfigPath: null });
    const put = await call("PUT", `/api/servers/${serverId}`, { serverConfigPath: config });
    expect(put.status).toBe(400);
    expect(put.json.code).toBe(ErrorCode.SERVER_CONFIG_PATH_OUTSIDE_DATA);

    await useRecord({ zomboidDataPath: multiplayer, serverConfigPath: config });
    const ini = await call("GET", "/api/server-files/raw/ini");
    expect(ini.status).toBe(400);
    expect(ini.json.code).toBe(ErrorCode.SERVER_CONFIG_PATH_OUTSIDE_DATA);
    expect(ini.text).not.toContain("Hijacked");
    const log = await call("GET", "/api/server/console-log");
    expect(log.json.exists).toBe(false);
    expect(log.text).not.toContain("someone's line");
  });

  it("only for a folder named Saves/Multiplayer, exactly as the game names it", () => {
    const { zomboid } = buildZomboid("named");
    const saves = path.join(zomboid, "Saves");
    fs.renameSync(path.join(saves, "Multiplayer"), path.join(saves, "Worlds"));
    expect(serverConfigPathIsConfined(path.join(zomboid, "Server"), path.join(saves, "Worlds"))).toBe(false);
  });
});
