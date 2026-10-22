import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { autoExportPlayer } from "../index.js";
import { getDataPaths } from "../utils/paths.js";
import { setSetting } from "../database/init.js";
import panelBridge from "../services/panelBridge.js";
import { encodeExportFolderName } from "../utils/exportFolderName.js";
import {
  MAX_AUTO_EXPORT_PLAYER_FOLDERS,
  enforceAutoExportFolderCap,
} from "../utils/autoExportFolders.js";

// Security audit 2026-10-20: with auto-export on login, every player name
// that joins got its own exports/@<hex>/ folder, and the folders never went:
// a client joining under endless made-up names filled the data volume. The
// number of player folders is now capped (the players exported longest ago
// lose their auto-exports first); an admin's pre-import snapshots and
// old-style folders are never touched. The per-player rotation also no
// longer deletes pre-import snapshots that share the folder.

const exportsRoot = () => path.join(getDataPaths().dataDir, "exports");
const folderOf = (name) => path.join(exportsRoot(), encodeExportFolderName(name));

function seedPlayer(name, { files = ["auto.json"], ageMinutes = 0 } = {}) {
  const dir = folderOf(name);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(dir, file), "{}");
  if (ageMinutes) {
    const when = new Date(Date.now() - ageMinutes * 60_000);
    fs.utimesSync(dir, when, when);
  }
  return dir;
}

beforeEach(() => {
  fs.rmSync(exportsRoot(), { recursive: true, force: true });
  fs.mkdirSync(exportsRoot(), { recursive: true });
});

describe("enforceAutoExportFolderCap", () => {
  it("is 2,000 player folders", () => {
    expect(MAX_AUTO_EXPORT_PLAYER_FOLDERS).toBe(2000);
  });

  it("removes the folders changed longest ago, sparing snapshots, old-style folders and the one just written", () => {
    seedPlayer("Oldest", { ageMinutes: 50 });
    const snapshotDir = seedPlayer("HasSnapshot", {
      files: ["HasSnapshot_2026-01-01T00-00-00-000Z.json", "HasSnapshot_pre-import_2026-01-01T00-00-00-000Z.json"],
      ageMinutes: 40,
    });
    seedPlayer("Middle", { ageMinutes: 30 });
    seedPlayer("Recent", { ageMinutes: 1 });
    const legacy = path.join(exportsRoot(), "Legacy_Name");
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, "Legacy_Name_2020.json"), "{}");
    const justWritten = seedPlayer("JustWritten", { ageMinutes: 100 });

    const removed = enforceAutoExportFolderCap(exportsRoot(), path.basename(justWritten), 3);

    expect(removed.sort()).toEqual([encodeExportFolderName("Middle"), encodeExportFolderName("Oldest")].sort());
    expect(fs.existsSync(folderOf("Recent"))).toBe(true);
    expect(fs.existsSync(justWritten)).toBe(true);
    // The snapshot folder lost its auto-export, not the admin's recovery copy.
    expect(fs.readdirSync(snapshotDir)).toEqual(["HasSnapshot_pre-import_2026-01-01T00-00-00-000Z.json"]);
    expect(fs.existsSync(path.join(legacy, "Legacy_Name_2020.json"))).toBe(true);
  });

  it("does nothing under the cap", () => {
    seedPlayer("A");
    seedPlayer("B");
    expect(enforceAutoExportFolderCap(exportsRoot(), encodeExportFolderName("B"), 3)).toEqual([]);
    expect(fs.readdirSync(exportsRoot())).toHaveLength(2);
  });
});

describe("autoExportPlayer", () => {
  beforeEach(async () => {
    await setSetting("autoExportMaxPerPlayer", 3);
    panelBridge.isRunning = true;
    vi.spyOn(panelBridge, "isModConnected").mockReturnValue(true);
    vi.spyOn(panelBridge, "sendCommand").mockImplementation(async (_cmd, { username }) => ({
      success: true,
      data: { username },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    panelBridge.isRunning = false;
  });

  it("a new player past the cap removes the auto-exports of the player exported longest ago", async () => {
    for (let i = 0; i < MAX_AUTO_EXPORT_PLAYER_FOLDERS; i++) {
      seedPlayer(`P${i}`, { files: [`P${i}_2026-10-01T00-00-00-000Z.json`], ageMinutes: i === 0 ? 600 : 5 });
    }
    await autoExportPlayer("Newcomer");

    const folders = fs.readdirSync(exportsRoot());
    expect(folders).toHaveLength(MAX_AUTO_EXPORT_PLAYER_FOLDERS);
    expect(folders).toContain(encodeExportFolderName("Newcomer"));
    expect(folders).not.toContain(encodeExportFolderName("P0"));

    // A returning player's export removes nothing.
    await autoExportPlayer("P1");
    expect(fs.readdirSync(exportsRoot())).toHaveLength(MAX_AUTO_EXPORT_PLAYER_FOLDERS);
  });

  it("rotation keeps only the newest auto-exports and never deletes a pre-import snapshot", async () => {
    const snapshots = [1, 2, 3, 4].map((n) => `Kate_pre-import_2026-10-0${n}T00-00-00-000Z.json`);
    seedPlayer("Kate", { files: snapshots });
    for (let i = 0; i < 5; i++) await autoExportPlayer("Kate");

    const files = fs.readdirSync(folderOf("Kate"));
    for (const snapshot of snapshots) expect(files).toContain(snapshot);
    expect(files.filter((file) => !file.includes("_pre-import_"))).toHaveLength(3);
  });
});
