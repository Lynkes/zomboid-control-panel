import { afterEach, describe, expect, it, vi } from "vitest";
import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  ITEM_FILES,
  WorkshopBuildError,
  buildWorkshopItem,
  itemLayoutErrors,
  renderWorkshopTxt,
  runBuildItemCli,
} from "../../scripts/workshop/build-item.mjs";
import {
  BRIDGE_FILES,
  IMAGE_RULES,
  REPO_ROOT,
  crc32,
  imageErrors,
  lintModInfo,
  normalizeText,
  readRepoText,
  sha256Hex,
} from "../../scripts/workshop/lib.mjs";
import { readPublishedWorkshopJson } from "../../build.js";

// scripts/workshop/build-item.mjs turns pz-mod/PanelBridge into the Build 42
// Workshop layout and refuses anything the game or the in-game uploader would
// reject (spec §8.4-8.5). The fixture tree uses this repository's real
// mod.info, workshop.txt, images and published.json, with PanelBridge Lua
// stand-ins that carry the §7 load guards and MOD_ID (the real Lua gets them
// from the Lua workstream), so the committed assets are checked here too.

const tempDirs = [];
const REAL_MOD_INFO = readRepoText(REPO_ROOT, BRIDGE_FILES.modInfo);
const REAL_VERSION = /^modversion=(.+)$/m.exec(REAL_MOD_INFO)[1];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function serverLua({ version = REAL_VERSION, beforeGuard = "", modId = "ZomboidControlPanelBridge" } = {}) {
  return [
    "---@diagnostic disable: undefined-global",
    "--[[",
    "    PanelBridge - Server-side mod for Zomboid Control Panel",
    `    Version: ${version}`,
    "]]",
    "",
    "--[==[ a long comment with ]] inside ]==]",
    "-- Every player's game loads and runs each mod's media/lua/server.",
    beforeGuard,
    "if not (isServer and isServer()) then return end -- trailing comment",
    "",
    "local PanelBridge = {",
    `    VERSION = "${version}",`,
    "    PROTOCOL_VERSION = \"queue-v1\",",
    modId === null ? "" : `    MOD_ID = "${modId}",`,
    "}",
    "return PanelBridge",
    "",
  ].join("\n");
}

const CLIENT_LUA = "-- PanelBridge client companion\nif not (isClient and isClient()) then return end\nlocal x = 1\n";

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, { interlace = 0, padding = 0 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[12] = interlace;
  const row = Buffer.alloc(1 + width * 4);
  const parts = [PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(height).fill(row))))];
  // A private ancillary chunk the decoder skips: only the file size grows.
  if (padding) parts.push(chunk("prVt", Buffer.alloc(padding, 0x61)));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workshop-build-"));
  tempDirs.push(root);
  const write = (relativePath, content) => {
    const full = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const copy = (relativePath) => write(relativePath, fs.readFileSync(path.join(REPO_ROOT, relativePath)));
  write(BRIDGE_FILES.serverLua, serverLua());
  write(BRIDGE_FILES.clientLua, CLIENT_LUA);
  for (const file of [BRIDGE_FILES.modInfo, BRIDGE_FILES.workshopTxt, BRIDGE_FILES.published, BRIDGE_FILES.preview, BRIDGE_FILES.poster, BRIDGE_FILES.icon]) {
    copy(file);
  }
  const setPublished = (fields) => {
    const doc = { ...JSON.parse(fs.readFileSync(path.join(root, BRIDGE_FILES.published), "utf8")), ...fields };
    write(BRIDGE_FILES.published, JSON.stringify(doc, null, 2));
  };
  return { root, write, setPublished };
}

function buildErrors(options) {
  try {
    buildWorkshopItem(options);
  } catch (error) {
    if (error instanceof WorkshopBuildError) return error.errors;
    throw error;
  }
  return [];
}

function listFiles(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`]).sort();
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("build-item: the generated Build 42 item", () => {
  it("writes exactly the B42 tree, LF-normalized, with no root mod.info", () => {
    const repo = makeRepo();
    // A Windows checkout: CRLF and a BOM in the sources must not reach the item.
    repo.write(BRIDGE_FILES.serverLua, `\uFEFF${serverLua().replace(/\n/g, "\r\n")}`);
    repo.write(BRIDGE_FILES.modInfo, REAL_MOD_INFO.replace(/\n/g, "\r\n"));
    const outDir = path.join(repo.root, "out");
    const result = buildWorkshopItem({ repoRoot: repo.root, outDir });

    const itemDir = path.join(outDir, "ZomboidControlPanelBridge");
    expect(result.itemDir).toBe(itemDir);
    expect(listFiles(itemDir)).toEqual([
      "Contents/mods/ZomboidControlPanelBridge/42/icon.png",
      "Contents/mods/ZomboidControlPanelBridge/42/mod.info",
      "Contents/mods/ZomboidControlPanelBridge/42/poster.png",
      "Contents/mods/ZomboidControlPanelBridge/common/media/lua/client/PanelBridgeClient.lua",
      "Contents/mods/ZomboidControlPanelBridge/common/media/lua/server/PanelBridge.lua",
      "preview.png",
      "workshop.txt",
    ]);
    for (const file of [ITEM_FILES.workshopTxt, ITEM_FILES.modInfo, ITEM_FILES.serverLua, ITEM_FILES.clientLua]) {
      const bytes = fs.readFileSync(path.join(itemDir, file));
      expect(bytes.includes(0x0d), file).toBe(false);
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), file).toBe(false);
    }
    for (const [file, hash] of Object.entries(result.files)) {
      expect(sha256Hex(fs.readFileSync(path.join(itemDir, file))), file).toBe(hash);
    }
  });

  it("ships the Lua byte-for-byte after LF normalization", () => {
    const repo = makeRepo();
    repo.write(BRIDGE_FILES.serverLua, serverLua().replace(/\n/g, "\r\n"));
    const outDir = path.join(repo.root, "out");
    buildWorkshopItem({ repoRoot: repo.root, outDir });
    const item = path.join(outDir, "ZomboidControlPanelBridge");
    expect(fs.readFileSync(path.join(item, ITEM_FILES.serverLua), "utf8")).toBe(serverLua());
    expect(fs.readFileSync(path.join(item, ITEM_FILES.clientLua), "utf8")).toBe(CLIENT_LUA);
    expect(fs.readFileSync(path.join(item, ITEM_FILES.modInfo), "utf8")).toBe(REAL_MOD_INFO);
    expect(fs.readFileSync(path.join(item, "preview.png")).equals(fs.readFileSync(path.join(REPO_ROOT, BRIDGE_FILES.preview)))).toBe(true);
  });

  it("--check validates without writing anything", () => {
    const repo = makeRepo();
    const outDir = path.join(repo.root, "out");
    const result = buildWorkshopItem({ repoRoot: repo.root, outDir, check: true });
    expect(result.written).toBe(false);
    expect(Object.keys(result.files)).toHaveLength(7);
    expect(fs.existsSync(outDir)).toBe(false);
    buildWorkshopItem({ repoRoot: repo.root, check: true });
    expect(fs.existsSync(path.join(repo.root, "dist-workshop"))).toBe(false);
  });

  it("defaults to dist-workshop/ and replaces a stale Contents/ on rebuild", () => {
    const repo = makeRepo();
    buildWorkshopItem({ repoRoot: repo.root });
    const item = path.join(repo.root, "dist-workshop", "ZomboidControlPanelBridge");
    const stale = path.join(item, "Contents", "mods", "ZomboidControlPanelBridge", "common", "media", "lua", "shared", "Old.lua");
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, "-- left over");
    buildWorkshopItem({ repoRoot: repo.root });
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("refuses an output folder under release/", () => {
    const repo = makeRepo();
    expect(buildErrors({ repoRoot: repo.root, outDir: path.join(repo.root, "release", "workshop"), check: true }).join("\n"))
      .toMatch(/under release\//);
  });
});

describe("build-item: mod.info lint", () => {
  it("accepts this repository's mod.info", () => {
    expect(lintModInfo(REAL_MOD_INFO).errors).toEqual([]);
  });

  it.each([
    ["an empty require=", `${REAL_MOD_INFO}require=\n`, /require= is not allowed/],
    ["authors= instead of author=", REAL_MOD_INFO.replace("author=", "authors="), /authors= is not allowed/],
    ["pack=", `${REAL_MOD_INFO}pack=media/\n`, /pack= is not allowed/],
    ["pzversion=", `${REAL_MOD_INFO}pzversion=42.0\n`, /pzversion= is not allowed/],
    ["an = inside a value", REAL_MOD_INFO.replace(/^url=.*$/m, "url=https://example.com/?id=1"), /no "=" inside the value/],
    ["an unknown key", `${REAL_MOD_INFO}flavour=vanilla\n`, /unknown key flavour=/],
    ["a blank line", `${REAL_MOD_INFO}\ncategory=Framework\n`, /line 9: must be key=value/],
    ["a poster the build doesn't ship", REAL_MOD_INFO.replace("poster=poster.png", "poster=cover.png"), /poster= must be poster\.png/],
  ])("rejects %s", (_label, content, pattern) => {
    const repo = makeRepo();
    repo.write(BRIDGE_FILES.modInfo, content);
    expect(buildErrors({ repoRoot: repo.root, check: true }).join("\n")).toMatch(pattern);
  });

  it("rejects an id that isn't ZomboidControlPanelBridge", () => {
    const repo = makeRepo();
    repo.write(BRIDGE_FILES.modInfo, REAL_MOD_INFO.replace("id=ZomboidControlPanelBridge", "id=PanelBridge"));
    expect(buildErrors({ repoRoot: repo.root, check: true })).toContain("mod.info id=PanelBridge, expected ZomboidControlPanelBridge");
  });

  it("rejects a Lua MOD_ID that differs or is missing", () => {
    const repo = makeRepo();
    repo.write(BRIDGE_FILES.serverLua, serverLua({ modId: "PanelBridge" }));
    expect(buildErrors({ repoRoot: repo.root, check: true }).join("\n")).toMatch(/must declare MOD_ID = "ZomboidControlPanelBridge" \(found "PanelBridge"\)/);
    repo.write(BRIDGE_FILES.serverLua, serverLua({ modId: null }));
    expect(buildErrors({ repoRoot: repo.root, check: true }).join("\n")).toMatch(/\(found none\)/);
  });

  it("rejects a published.json whose modId or workshopId is wrong", () => {
    const repo = makeRepo();
    repo.setPublished({ modId: "PanelBridge", workshopId: "12x" });
    const errors = buildErrors({ repoRoot: repo.root, check: true }).join("\n");
    expect(errors).toMatch(/modId must be ZomboidControlPanelBridge/);
    expect(errors).toMatch(/workshopId must be null or a numeric Steam id/);
  });
});

describe("build-item: version parity and load guards", () => {
  it("requires modversion, VERSION and the header Version: to agree", () => {
    const repo = makeRepo();
    repo.write(BRIDGE_FILES.serverLua, serverLua({ version: "9.9.9" }));
    expect(buildErrors({ repoRoot: repo.root, check: true }).join("\n")).toMatch(/PanelBridge versions differ/);
  });

  it("requires the server guard to be the first executable statement", () => {
    const repo = makeRepo();
    repo.write(BRIDGE_FILES.serverLua, serverLua({ beforeGuard: "local json" }));
    expect(buildErrors({ repoRoot: repo.root, check: true }).join("\n"))
      .toMatch(/PanelBridge\.lua: the first executable statement must be `if not \(isServer and isServer\(\)\) then return end`/);
  });

  it("requires the client guard to be the first executable statement", () => {
    const repo = makeRepo();
    repo.write(BRIDGE_FILES.clientLua, "local function sendTeleportAck() end\nif not (isClient and isClient()) then return end\n");
    expect(buildErrors({ repoRoot: repo.root, check: true }).join("\n"))
      .toMatch(/PanelBridgeClient\.lua: the first executable statement must be `if not \(isClient and isClient\(\)\) then return end`/);
  });
});

describe("build-item: images", () => {
  it("accepts the committed preview, poster and icon", () => {
    for (const rule of Object.values(IMAGE_RULES)) {
      expect(imageErrors(rule.file, fs.readFileSync(path.join(REPO_ROOT, rule.file)), rule.sizes)).toEqual([]);
    }
  });

  it("accepts a 256 px preview", () => {
    const repo = makeRepo();
    repo.write(BRIDGE_FILES.preview, encodePng(256, 256));
    expect(buildErrors({ repoRoot: repo.root, check: true })).toEqual([]);
  });

  it.each([
    ["preview at 300 px", BRIDGE_FILES.preview, () => encodePng(300, 300), /300x300, must be square at 256 or 512 px/],
    ["a non-square preview", BRIDGE_FILES.preview, () => encodePng(512, 256), /512x256, must be square/],
    ["a preview over 1,024,000 bytes", BRIDGE_FILES.preview, () => encodePng(512, 512, { padding: 1024000 }), /over the 1024000-byte limit/],
    ["a JPEG named preview.png", BRIDGE_FILES.preview, () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), /not a PNG file/],
    ["an interlaced preview", BRIDGE_FILES.preview, () => encodePng(512, 512, { interlace: 1 }), /interlaced/],
    ["a corrupted chunk", BRIDGE_FILES.preview, () => { const png = encodePng(512, 512); png[40] ^= 0xff; return png; }, /bad CRC/],
    ["a 512 px poster", BRIDGE_FILES.poster, () => encodePng(512, 512), /poster\.png: 512x512, must be square at 256 px/],
    ["a 64 px icon", BRIDGE_FILES.icon, () => encodePng(64, 64), /icon\.png: 64x64, must be square at 32 px/],
  ])("rejects %s", (_label, file, make, pattern) => {
    const repo = makeRepo();
    repo.write(file, make());
    expect(buildErrors({ repoRoot: repo.root, check: true }).join("\n")).toMatch(pattern);
  });
});

describe("build-item: layout and file types", () => {
  it("rejects a file under pz-mod/PanelBridge that the item wouldn't ship", () => {
    const repo = makeRepo();
    repo.write("pz-mod/PanelBridge/media/lua/shared/PanelBridgeShared.lua", "return {}\n");
    repo.write("pz-mod/PanelBridge/media/lua/server/helper.dll", "MZ");
    const errors = buildErrors({ repoRoot: repo.root, check: true }).join("\n");
    expect(errors).toMatch(/media\/lua\/shared\/PanelBridgeShared\.lua: unexpected file/);
    expect(errors).toMatch(/media\/lua\/server\/helper\.dll: unexpected file/);
  });

  it("checks the item's own paths: mods/ only, the two Lua paths, no shared/, no blocked types", () => {
    const base = Object.values(ITEM_FILES);
    expect(itemLayoutErrors(base)).toEqual([]);
    const errors = itemLayoutErrors([
      ...base,
      "Contents/buildings/house.txt",
      "Contents/mods/ZomboidControlPanelBridge/common/media/lua/shared/X.lua",
      "Contents/mods/ZomboidControlPanelBridge/common/media/lua/server/Extra.lua",
      "Contents/mods/ZomboidControlPanelBridge/42/tool.exe",
      "Contents/mods/ZomboidControlPanelBridge/42/archive.ZIP",
    ]).join("\n");
    expect(errors).toMatch(/Contents\/buildings\/house\.txt: only mods\/ is allowed/);
    expect(errors).toMatch(/shared\/X\.lua: no shared\//);
    expect(errors).toMatch(/server\/Extra\.lua: the only Lua paths are/);
    expect(errors).toMatch(/tool\.exe: \.exe files are refused/);
    expect(errors).toMatch(/archive\.ZIP: \.zip files are refused/);
    expect(itemLayoutErrors(base.filter((file) => file !== ITEM_FILES.clientLua)).join("\n")).toMatch(/PanelBridgeClient\.lua is missing/);
  });
});

describe("build-item: workshop.txt", () => {
  it("injects id= after version=1 and the published visibility", () => {
    const repo = makeRepo();
    repo.setPublished({ workshopId: "3712345678", visibility: "public" });
    const outDir = path.join(repo.root, "out");
    buildWorkshopItem({ repoRoot: repo.root, outDir });
    const lines = fs.readFileSync(path.join(outDir, "ZomboidControlPanelBridge", "workshop.txt"), "utf8").split("\n");
    expect(lines.slice(0, 3)).toEqual(["version=1", "id=3712345678", "title=Zomboid Control Panel Bridge"]);
    expect(lines.filter((line) => line.startsWith("visibility="))).toEqual(["visibility=public"]);
    expect(lines.filter((line) => line.startsWith("tags="))).toEqual(["tags=Build 42;Multiplayer;Framework"]);
  });

  it("writes no id= before the first publish and defaults to unlisted", () => {
    const rendered = renderWorkshopTxt(readRepoText(REPO_ROOT, BRIDGE_FILES.workshopTxt), { workshopId: null, visibility: "unlisted" });
    expect(rendered).not.toMatch(/^id=/m);
    expect(rendered.match(/^visibility=.*$/gm)).toEqual(["visibility=unlisted"]);
    expect(rendered).toBe(normalizeText(rendered));
  });

  it("rejects tags other than Build 42;Multiplayer;Framework", () => {
    const repo = makeRepo();
    repo.write(BRIDGE_FILES.workshopTxt, readRepoText(REPO_ROOT, BRIDGE_FILES.workshopTxt).replace("tags=Build 42;Multiplayer;Framework", "tags=Build 42;Misc"));
    expect(buildErrors({ repoRoot: repo.root, check: true }).join("\n")).toMatch(/tags must be exactly Build 42;Multiplayer;Framework/);
  });

  it("rejects a template that already carries id=", () => {
    const repo = makeRepo();
    repo.write(BRIDGE_FILES.workshopTxt, readRepoText(REPO_ROOT, BRIDGE_FILES.workshopTxt).replace("version=1\n", "version=1\nid=1\n"));
    expect(buildErrors({ repoRoot: repo.root, check: true }).join("\n")).toMatch(/must not carry id=/);
  });
});

describe("build-item: an existing staged item", () => {
  function stage(repo, workshopTxt) {
    const outDir = path.join(repo.root, "Workshop");
    fs.mkdirSync(path.join(outDir, "ZomboidControlPanelBridge"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "ZomboidControlPanelBridge", "workshop.txt"), workshopTxt);
    return outDir;
  }

  it("refuses to overwrite a staged item that points at another Workshop id", () => {
    const repo = makeRepo();
    repo.setPublished({ workshopId: "3712345678" });
    const outDir = stage(repo, "version=1\nid=999\ntitle=x\n");
    expect(buildErrors({ repoRoot: repo.root, outDir }).join("\n")).toMatch(/has id=999 but published\.json says 3712345678/);
    expect(buildErrors({ repoRoot: repo.root, outDir, check: true }).join("\n")).toMatch(/has id=999/);
  });

  it("asks to record a staged id before published.json knows one", () => {
    const repo = makeRepo();
    const outDir = stage(repo, "version=1\nid=3712345678\ntitle=x\n");
    expect(buildErrors({ repoRoot: repo.root, outDir }).join("\n")).toMatch(/record it first: node scripts\/workshop\/publish\.mjs record --from-staged/);
  });

  it("rebuilds a staged item with the same id", () => {
    const repo = makeRepo();
    repo.setPublished({ workshopId: "3712345678" });
    const outDir = stage(repo, "version=1\nid=3712345678\ntitle=x\n");
    buildWorkshopItem({ repoRoot: repo.root, outDir });
    expect(fs.readFileSync(path.join(outDir, "ZomboidControlPanelBridge", "workshop.txt"), "utf8")).toMatch(/^id=3712345678$/m);
  });

  it("refuses to overwrite a same-named folder that isn't a staged item", () => {
    const repo = makeRepo();
    const outDir = path.join(repo.root, "Workshop");
    fs.mkdirSync(path.join(outDir, "ZomboidControlPanelBridge"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "ZomboidControlPanelBridge", "notes.txt"), "mine");
    expect(buildErrors({ repoRoot: repo.root, outDir }).join("\n")).toMatch(/isn't a staged Workshop item/);
  });
});

describe("build-item: command line", () => {
  it("returns 0 on success, 1 on a failed check and 2 on a bad argument", () => {
    const repo = makeRepo();
    const quiet = { repoRoot: repo.root, log: () => {}, error: () => {} };
    expect(runBuildItemCli(["--check"], quiet)).toBe(0);
    expect(runBuildItemCli(["--out"], quiet)).toBe(2);
    repo.write(BRIDGE_FILES.clientLua, "print('no guard')\n");
    const errors = [];
    expect(runBuildItemCli(["--check"], { ...quiet, error: (line) => errors.push(line) })).toBe(1);
    expect(errors.join("\n")).toMatch(/Workshop item check failed:\n {2}- PanelBridgeClient\.lua/);
  });
});

describe("build.js: published.json is embedded in the binary", () => {
  it("returns the file verbatim and logs the id", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const text = readPublishedWorkshopJson(path.join(REPO_ROOT, BRIDGE_FILES.published));
    expect(text).toBe(fs.readFileSync(path.join(REPO_ROOT, BRIDGE_FILES.published), "utf8"));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Embedding published\.json \(workshopId (none|\d+)\)$/));
  });

  it("fails the build when the file is missing or not JSON", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const repo = makeRepo();
    expect(() => readPublishedWorkshopJson(path.join(repo.root, "missing.json"))).toThrow(/not found/);
    repo.write("broken.json", "{ \"schema\": 1,");
    expect(() => readPublishedWorkshopJson(path.join(repo.root, "broken.json"))).toThrow(/not valid JSON/);
  });

  it("wires the PANEL_BRIDGE_WORKSHOP_JSON define so a typeof-guarded read gets the text", () => {
    const buildJs = fs.readFileSync(path.join(REPO_ROOT, "build.js"), "utf8");
    expect(buildJs).toMatch(/PANEL_BRIDGE_WORKSHOP_JSON: JSON\.stringify\(publishedWorkshopJson\)/);
    const raw = fs.readFileSync(path.join(REPO_ROOT, BRIDGE_FILES.published), "utf8");
    const { code } = esbuild.transformSync(
      "module.exports = typeof PANEL_BRIDGE_WORKSHOP_JSON !== \"undefined\" ? PANEL_BRIDGE_WORKSHOP_JSON : null;",
      { define: { PANEL_BRIDGE_WORKSHOP_JSON: JSON.stringify(raw) } },
    );
    const bundled = {};
    new Function("module", code)(bundled);
    expect(bundled.exports).toBe(raw);
  });

  it("describes both install methods in the release README", () => {
    const buildJs = fs.readFileSync(path.join(REPO_ROOT, "build.js"), "utf8");
    expect(buildJs).not.toMatch(/NOT a Workshop mod/);
    expect(buildJs).not.toMatch(/no \.ini changes needed/);
    expect(buildJs).toMatch(/Installed by the panel \(default\)/);
    expect(buildJs).toMatch(/Steam Workshop \(Build 42 servers running with Steam\)/);
    expect(buildJs).toMatch(/DoLuaChecksum=false/);
  });
});
