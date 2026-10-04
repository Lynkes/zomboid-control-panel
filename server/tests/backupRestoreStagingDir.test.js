import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// security audit M4: restore staging used a predictable Date.now()-pid name
// and a recursive mkdir, so a local user could pre-plant a symlink at that
// name and redirect the extraction outside the saves folder.
vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));
vi.mock("../routes/chunks.js", () => ({ invalidateMapFolderScan: vi.fn() }));

const { createRestoreStagingDir } = await import("../services/backupService.js");

const symlinksWork = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symlink-probe-"));
  try {
    fs.symlinkSync(dir, path.join(dir, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

describe("createRestoreStagingDir()", () => {
  let root;
  let saves;
  let outside;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "restore-staging-"));
    saves = path.join(root, "Saves");
    outside = path.join(root, "outside");
    fs.mkdirSync(saves);
    fs.mkdirSync(outside);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates a fresh, randomly named directory directly inside the saves folder", () => {
    const a = createRestoreStagingDir(saves);
    const b = createRestoreStagingDir(saves);
    expect(a).not.toBe(b);
    for (const dir of [a, b]) {
      expect(path.dirname(dir)).toBe(saves);
      expect(path.basename(dir)).toMatch(/^\.restore-staging-[0-9a-f-]{36}$/);
      expect(fs.lstatSync(dir).isDirectory()).toBe(true);
    }
  });

  it.skipIf(!symlinksWork)("never reuses a pre-planted symlink; it picks a new name instead", () => {
    const names = ["planted", "fresh"];
    fs.symlinkSync(outside, path.join(saves, ".restore-staging-planted"), "dir");
    const dir = createRestoreStagingDir(saves, () => names.shift());
    expect(path.basename(dir)).toBe(".restore-staging-fresh");
    expect(fs.lstatSync(dir).isDirectory()).toBe(true);
    // The planted link was left alone and nothing was created through it.
    expect(fs.lstatSync(path.join(saves, ".restore-staging-planted")).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("gives up after repeated collisions instead of looping forever", () => {
    fs.mkdirSync(path.join(saves, ".restore-staging-taken"));
    expect(() => createRestoreStagingDir(saves, () => "taken")).toThrow(/EEXIST/);
  });

  it.skipIf(!symlinksWork)("works when the saves folder itself is reached through a symlink", () => {
    const linkedSaves = path.join(root, "linked-saves");
    fs.symlinkSync(saves, linkedSaves, "dir");
    const dir = createRestoreStagingDir(linkedSaves);
    expect(fs.realpathSync(dir)).toBe(path.join(fs.realpathSync(saves), path.basename(dir)));
  });
});
