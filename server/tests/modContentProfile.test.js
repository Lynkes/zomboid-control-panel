import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  CONTENT_PROFILE_LIMITS,
  clearContentProfileCache,
  profileModFolder,
  profileModFolders,
  profilesFromFileIndex,
  summarizeModFiles,
} from "../utils/modContentProfile.js";

// What a mod's loaded folders contain (utils/modContentProfile.js): only the
// folders Build 42 loads, bounded, cached.

const roots = [];
function tempMod(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mod-profile-"));
  roots.push(root);
  for (const rel of files) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "x");
  }
  return root;
}

afterEach(() => {
  clearContentProfileCache();
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe("summarizeModFiles", () => {
  it("counts what the game loads and leaves out what it never reads", () => {
    const p = summarizeModFiles([
      "lua/client/A.lua",
      "lua/server/B.lua",
      "lua/shared/C.lua",
      "lua/shared/Translate/EN/UI_EN.json",
      "lua/shared/Translate/EN/Old_EN.txt",
      "lua/shared/Translate/EN/Code.lua",
      "scripts/items.txt",
      "maps/My Town/0_0.lotheader",
      "maps/My Town/sub/deep.lotheader",
      "maps/Spawns Only/spawnpoints.lua",
      "textures/a.png",
      "models_X/a.fbx",
      "sound/a.ogg",
      "ui/icon.png",
      "clothing/clothing.xml",
      "sandbox-options.txt",
      "mod.info",
      "poster.png",
      "README.md",
      "weird.bin",
      42,
    ]);
    expect(p).toMatchObject({
      files: 17,
      lua: 4,
      luaClient: 1,
      luaServer: 1,
      luaShared: 2,
      translation: 2,
      translationJson: 1,
      scripts: 1,
      maps: 3,
      mapFolders: ["My Town"],
      textures: 1,
      models: 1,
      audio: 1,
      ui: 1,
      clothing: 1,
      sandboxOptions: true,
      other: 1,
    });
    expect(p.luaPaths).toEqual(["lua/client/a.lua", "lua/server/b.lua", "lua/shared/c.lua", "lua/shared/translate/en/code.lua"]);
  });

  it("caps the Lua paths it keeps", () => {
    const paths = Array.from({ length: CONTENT_PROFILE_LIMITS.maxLuaPaths + 5 }, (_, i) => `lua/client/f${i}.lua`);
    const p = summarizeModFiles(paths);
    expect(p.luaPaths).toHaveLength(CONTENT_PROFILE_LIMITS.maxLuaPaths);
    expect(p.luaPathsTruncated).toBe(true);
    expect(p.lua).toBe(paths.length);
  });

  it("builds profiles from a conflict scan's file index without reading anything", () => {
    const { profiles, fileCounts } = profilesFromFileIndex({
      "lua/client/a.lua": [{ modId: "A" }, { modId: "B" }],
      "scripts/x.txt": [{ modId: "A" }, { modId: "A" }],
      "maps/town/0_0.lotheader": [{ modId: "B" }],
      junk: "not-a-list",
    });
    expect(fileCounts).toEqual(new Map([["A", 2], ["B", 2]]));
    expect(profiles.get("A")).toMatchObject({ lua: 1, scripts: 1 });
    expect(profiles.get("B").mapFolders).toEqual(["town"]);
  });
});

describe("profileModFolder", () => {
  it("reads common/ and the newest 42 folder, never the B41 root media or an older version folder", async () => {
    const mod = tempMod([
      "mod.info",
      "media/scripts/b41only.txt",
      "common/media/lua/client/a.lua",
      "42/mod.info",
      "42/media/lua/shared/Translate/EN/UI_EN.json",
      "41/media/scripts/old.txt",
    ]);
    const p = await profileModFolder(mod);
    expect(p).toMatchObject({ layout: "b42", lua: 1, translation: 1, scripts: 0 });
  });

  it("reads a root media/ for the old layout, and null for a folder with neither", async () => {
    expect(await profileModFolder(tempMod(["mod.info", "media/scripts/a.txt"]))).toMatchObject({ layout: "legacy", scripts: 1 });
    expect(await profileModFolder(tempMod(["readme.txt"]))).toBeNull();
    expect(await profileModFolder(path.join(os.tmpdir(), "no-such-mod-folder-xyz"))).toBeNull();
  });

  it("only counts a big texture folder up to its cap", async () => {
    const files = Array.from({ length: CONTENT_PROFILE_LIMITS.maxFilesPerOtherFolder + 50 }, (_, i) => `common/media/textures/t${i}.png`);
    const p = await profileModFolder(tempMod(files));
    expect(p.textures).toBe(CONTENT_PROFILE_LIMITS.maxFilesPerOtherFolder);
    expect(p.truncated).toBe(true);
  });

  it("does not follow a symbolic link out of the mod", async () => {
    const outside = tempMod(["secret/a.lua"]);
    const mod = tempMod(["common/media/lua/client/own.lua"]);
    try {
      fs.symlinkSync(path.join(outside, "secret"), path.join(mod, "common", "media", "lua", "linked"), "junction");
    } catch {
      return; // no permission to create links here
    }
    const p = await profileModFolder(mod);
    expect(p.lua).toBe(1);
  });

  it("caches a profile and reads again when asked", async () => {
    const mod = tempMod(["common/media/lua/client/a.lua"]);
    const first = await profileModFolder(mod);
    fs.writeFileSync(path.join(mod, "common", "media", "lua", "client", "b.lua"), "x");
    expect(await profileModFolder(mod)).toBe(first);
    expect((await profileModFolder(mod, { fresh: true })).lua).toBe(2);
  });

  it("profiles many folders at once", async () => {
    const a = tempMod(["common/media/lua/client/a.lua"]);
    const b = tempMod(["common/media/scripts/b.txt"]);
    const out = await profileModFolders([
      { key: "A", dir: a },
      { key: "B", dir: b },
      { key: "C", dir: path.join(a, "missing") },
    ]);
    expect(out.get("A").lua).toBe(1);
    expect(out.get("B").scripts).toBe(1);
    expect(out.get("C")).toBeNull();
  });
});
