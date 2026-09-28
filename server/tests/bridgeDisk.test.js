import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import {
  archiveLooseBridgeFiles,
  detectBridgeOnDisk,
  detectWorkshopItem,
  installDirKey,
  listLooseBridgeFiles,
  readBridgeFileMeta,
  restoreArchivedBridgeFiles,
  restoreBridgeFileBytes,
} from "../services/bridgeDisk.js";
import { getDataPaths } from "../utils/paths.js";

// What counts as a loose PanelBridge leftover, where it is archived to (never
// deleted), how a failed archive or a rollback puts files back, and where a
// downloaded Workshop item is found. The fixtures carry the real header
// markers the recognition rules key on.

const SERVER_LUA = "---@diagnostic disable\n--[[\n    PanelBridge - Server-side mod for Zomboid Control Panel\n    Version: 1.7.70\n]]\n";
const CLIENT_LUA = "-- PanelBridge client companion for effects the server can't replicate\n";
const ID = "3712345678";

let installDir;

function put(relative, content) {
  const full = path.join(installDir, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function archiveRootFor(dir) {
  const hash = crypto.createHash("sha1").update(installDirKey(dir)).digest("hex").slice(0, 12);
  return path.join(getDataPaths().dataDir, "bridge-delivery-archive", hash);
}

beforeEach(() => {
  installDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-disk-"));
});

afterEach(() => {
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.rmSync(archiveRootFor(installDir), { recursive: true, force: true });
});

describe("listLooseBridgeFiles", () => {
  it("recognises the panel's own server and client files by their header text", () => {
    put("media/lua/server/PanelBridge.lua", SERVER_LUA);
    put("media/lua/client/PanelBridgeClient.lua", CLIENT_LUA);
    const files = listLooseBridgeFiles(installDir);
    expect(files).toEqual(
      expect.arrayContaining([
        { path: path.join(installDir, "media", "lua", "server", "PanelBridge.lua"), kind: "server", recognized: true },
        { path: path.join(installDir, "media", "lua", "client", "PanelBridgeClient.lua"), kind: "client", recognized: true },
      ]),
    );
  });

  it("lists a same-named file the panel didn't write as unrecognized", () => {
    put("media/lua/server/PanelBridge.lua", "-- some other mod's file\n");
    expect(listLooseBridgeFiles(installDir)).toEqual([
      expect.objectContaining({ kind: "server", recognized: false }),
    ]);
  });

  it("matches names case-insensitively", () => {
    put("media/lua/server/panelbridge.lua", SERVER_LUA);
    expect(listLooseBridgeFiles(installDir)).toEqual([expect.objectContaining({ kind: "server", recognized: true })]);
  });

  it("lists a root mod.info only when it is PanelBridge's own (id=PanelBridge)", () => {
    put("mod.info", "name=Something\nid=SomethingElse\n");
    expect(listLooseBridgeFiles(installDir)).toEqual([]);
    put("mod.info", "name=PanelBridge - External Control Panel\r\nid=PanelBridge\r\n");
    expect(listLooseBridgeFiles(installDir)).toEqual([
      { path: path.join(installDir, "mod.info"), kind: "rootModInfo", recognized: true },
    ]);
  });

  it("is empty for a clean folder or no folder at all", () => {
    expect(listLooseBridgeFiles(installDir)).toEqual([]);
    expect(listLooseBridgeFiles(null)).toEqual([]);
  });
});

describe("archiveLooseBridgeFiles", () => {
  it("moves files out under their install-relative paths and writes a manifest", async () => {
    const server = put("media/lua/server/PanelBridge.lua", SERVER_LUA);
    const client = put("media/lua/client/PanelBridgeClient.lua", CLIENT_LUA);
    const result = await archiveLooseBridgeFiles(installDir, listLooseBridgeFiles(installDir), { reason: "test" });

    expect(fs.existsSync(server)).toBe(false);
    expect(fs.existsSync(client)).toBe(false);
    expect(result.archiveDir.startsWith(archiveRootFor(installDir))).toBe(true);
    expect(fs.readFileSync(path.join(result.archiveDir, "media", "lua", "server", "PanelBridge.lua"), "utf8")).toBe(
      SERVER_LUA,
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(result.archiveDir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ installDir, reason: "test" });
    expect(manifest.files).toHaveLength(2);
    expect(Object.keys(manifest.files[0]).sort()).toEqual(["from", "sha256", "to"]);
    expect(manifest.files[0].sha256).toBe(crypto.createHash("sha256").update(SERVER_LUA).digest("hex"));
    expect(result.moved.sort()).toEqual([server, client].sort());
  });

  // installBridge() leaves PanelBridge.lua 0644 and owned like the game
  // folder so a PZ server running as another user can read it. A rollback
  // that rewrote the bytes with the panel's own umask mode could leave the
  // game unable to load the file it just got back.
  it.skipIf(process.platform === "win32")(
    "a file moved back gets the mode it had before, not the panel's default",
    async () => {
      const server = put("media/lua/server/PanelBridge.lua", SERVER_LUA);
      fs.chmodSync(server, 0o640);
      const result = await archiveLooseBridgeFiles(installDir, listLooseBridgeFiles(installDir), { reason: "test" });
      await restoreArchivedBridgeFiles(result);
      expect(fs.statSync(server).mode & 0o777).toBe(0o640);
    },
  );

  it.skipIf(process.platform === "win32")(
    "restoreBridgeFileBytes puts back the recorded mode over the installer's 0644",
    () => {
      const server = put("media/lua/server/PanelBridge.lua", SERVER_LUA);
      fs.chmodSync(server, 0o640);
      const meta = readBridgeFileMeta(server);
      fs.chmodSync(server, 0o644);
      restoreBridgeFileBytes(server, Buffer.from(SERVER_LUA), meta);
      expect(fs.readFileSync(server, "utf8")).toBe(SERVER_LUA);
      expect(fs.statSync(server).mode & 0o777).toBe(0o640);
    },
  );

  it("keeps only the newest 5 archive folders per install", async () => {
    const root = archiveRootFor(installDir);
    fs.mkdirSync(root, { recursive: true });
    for (const stamp of ["20200101T000000Z", "20200102T000000Z", "20200103T000000Z", "20200104T000000Z", "20200105T000000Z"]) {
      fs.mkdirSync(path.join(root, stamp));
    }
    put("media/lua/server/PanelBridge.lua", SERVER_LUA);
    const result = await archiveLooseBridgeFiles(installDir, listLooseBridgeFiles(installDir), { reason: "test" });
    const kept = fs.readdirSync(root).sort();
    expect(kept).toHaveLength(5);
    expect(kept).not.toContain("20200101T000000Z");
    expect(kept).toContain(path.basename(result.archiveDir));
  });

  it("puts back what it already moved when a later file fails, and names the failing file", async () => {
    const server = put("media/lua/server/PanelBridge.lua", SERVER_LUA);
    const missing = path.join(installDir, "media", "lua", "client", "PanelBridgeClient.lua");
    const files = [
      { path: server, kind: "server", recognized: true },
      { path: missing, kind: "client", recognized: true },
    ];
    await expect(archiveLooseBridgeFiles(installDir, files, { reason: "test" })).rejects.toMatchObject({
      fileName: "PanelBridgeClient.lua",
      restored: true,
    });
    expect(fs.readFileSync(server, "utf8")).toBe(SERVER_LUA);
  });

  it("restoreArchivedBridgeFiles moves everything back (the switch's undo)", async () => {
    const server = put("media/lua/server/PanelBridge.lua", SERVER_LUA);
    const result = await archiveLooseBridgeFiles(installDir, listLooseBridgeFiles(installDir), { reason: "test" });
    await restoreArchivedBridgeFiles(result);
    expect(fs.readFileSync(server, "utf8")).toBe(SERVER_LUA);
    expect(fs.existsSync(result.archiveDir)).toBe(false);
  });

  it("is a no-op for an empty list", async () => {
    expect(await archiveLooseBridgeFiles(installDir, [], { reason: "test" })).toEqual({
      archiveDir: null,
      moved: [],
      entries: [],
    });
  });
});

function makeItem(root, { layer = "42", id = "ZomboidControlPanelBridge", version = "1.7.71" } = {}) {
  const modDir = path.join(root, "mods", "ZomboidControlPanelBridge", layer);
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, "mod.info"), `name=Zomboid Control Panel Bridge\nid=${id}\nmodversion=${version}\n`);
}

describe("detectWorkshopItem", () => {
  it("finds the item through the SteamCMD layout next to the install (ACF candidate)", () => {
    const folder = path.join(installDir, "steamapps", "workshop", "content", "108600", ID);
    makeItem(folder);
    expect(detectWorkshopItem(installDir, ID)).toEqual({ folder, version: "1.7.71", source: "candidate" });
  });

  it("prefers the folder the server logged installing the item to", () => {
    const zPath = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-disk-z-"));
    const logged = path.join(zPath, "elsewhere", ID);
    makeItem(logged, { layer: "common" });
    fs.writeFileSync(path.join(zPath, "server-console.txt"), `Workshop: ${ID} installed to ${logged}\n`);
    try {
      expect(detectWorkshopItem(installDir, ID, { zomboidDataPath: zPath })).toMatchObject({
        folder: logged,
        source: "log",
      });
    } finally {
      fs.rmSync(zPath, { recursive: true, force: true });
    }
  });

  it("rejects a folder whose mod isn't the bridge, or whose only mod.info is at the mod root", () => {
    const folder = path.join(installDir, "steamapps", "workshop", "content", "108600", ID);
    makeItem(folder, { id: "SomeOtherMod" });
    expect(detectWorkshopItem(installDir, ID)).toBeNull();
    fs.rmSync(folder, { recursive: true, force: true });
    fs.mkdirSync(path.join(folder, "mods", "ZomboidControlPanelBridge"), { recursive: true });
    fs.writeFileSync(path.join(folder, "mods", "ZomboidControlPanelBridge", "mod.info"), "id=ZomboidControlPanelBridge\n");
    expect(detectWorkshopItem(installDir, ID)).toBeNull();
  });

  it("detectBridgeOnDisk reports either delivery", () => {
    expect(detectBridgeOnDisk(installDir, ID)).toEqual({ loose: false, workshopItem: false });
    makeItem(path.join(installDir, "steamapps", "workshop", "content", "108600", ID));
    expect(detectBridgeOnDisk(installDir, ID)).toEqual({ loose: false, workshopItem: true });
    put("media/lua/server/PanelBridge.lua", SERVER_LUA);
    expect(detectBridgeOnDisk(installDir, null)).toEqual({ loose: true, workshopItem: false });
  });
});

describe("installDirKey", () => {
  it("ignores trailing separators and, on Windows, case", () => {
    expect(installDirKey(`${installDir}${path.sep}`)).toBe(installDirKey(installDir));
    if (process.platform === "win32") {
      expect(installDirKey(installDir.toUpperCase())).toBe(installDirKey(installDir.toLowerCase()));
    }
    expect(installDirKey("")).toBeNull();
  });
});
