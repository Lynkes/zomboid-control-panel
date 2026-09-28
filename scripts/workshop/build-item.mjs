// Builds the PanelBridge Steam Workshop item from the unchanged source layout
// (pz-mod/PanelBridge/media/lua/...) into the Build 42 layout the game
// discovers:
//
//   ZCPB/
//     workshop.txt  preview.png
//     Contents/mods/ZCPB/
//       42/mod.info  42/poster.png  42/icon.png
//       common/media/lua/server/PanelBridge.lua
//       common/media/lua/client/PanelBridgeClient.lua
//
// Usage:
//   node scripts/workshop/build-item.mjs            -> dist-workshop/ZCPB/
//   node scripts/workshop/build-item.mjs --out ~/Zomboid/Workshop   (in-game uploader)
//   node scripts/workshop/build-item.mjs --check    (CI: validate, write nothing)
//
// 42.20 ignores a mod.info at the mod root (ZomboidFileSystem.getAllModFoldersAux
// only accepts common/ or <version>/mod.info), so there is none. The output
// never goes under release/: release.ps1 zips release/* as-is.
//
// A copy staged in ~/Zomboid/Workshop stands in for the downloaded Workshop
// item on that machine until it is moved out (stagedCopyWarning in lib.mjs),
// so the build says so, and publish.mjs record says what to do after upload.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  BRIDGE_FILES,
  BRIDGE_SOURCE_FILES,
  CLIENT_LUA_GUARD,
  IMAGE_RULES,
  MOD_ID,
  REPO_ROOT,
  SERVER_LUA_GUARD,
  WORKSHOP_TAGS,
  expandHome,
  firstExecutableLine,
  imageErrors,
  isInside,
  isMainModule,
  isWorkshopStagingFolder,
  lintModInfo,
  normalizeText,
  parseWorkshopTxt,
  readBridgeVersions,
  readPublished,
  sha256Hex,
  versionParityErrors,
} from "./lib.mjs";

export const DEFAULT_OUT_DIR = "dist-workshop";
// Where the panel's Mods page reads the mod id from a Workshop description:
// server/routes/mods.js extractWorkshopModId's first pattern.
const DESCRIPTION_MOD_ID = /Mod\s*ID\s*[:=]\s*([^\n\r[\]<>]+)/i;
const CONTENT_ROOT = `Contents/mods/${MOD_ID}`;
export const ITEM_FILES = Object.freeze({
  workshopTxt: "workshop.txt",
  preview: "preview.png",
  modInfo: `${CONTENT_ROOT}/42/mod.info`,
  poster: `${CONTENT_ROOT}/42/poster.png`,
  icon: `${CONTENT_ROOT}/42/icon.png`,
  serverLua: `${CONTENT_ROOT}/common/media/lua/server/PanelBridge.lua`,
  clientLua: `${CONTENT_ROOT}/common/media/lua/client/PanelBridgeClient.lua`,
});
// SteamWorkshopItem.validateContents (42.20) refuses these anywhere in Contents/.
const BLOCKED_EXTENSIONS = [".exe", ".dll", ".bat", ".app", ".dylib", ".sh", ".so", ".zip"];

export class WorkshopBuildError extends Error {
  constructor(errors) {
    super(`Workshop item check failed:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
    this.name = "WorkshopBuildError";
    this.errors = errors;
  }
}

function listFiles(root, relativeDir = "") {
  const absoluteDir = path.join(root, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...listFiles(root, relativePath));
    else result.push(relativePath);
  }
  return result.sort();
}

// id= goes right after version=1 once the item exists: without it the
// in-game uploader would create a second item instead of updating this one.
export function renderWorkshopTxt(templateText, { workshopId, visibility }) {
  const lines = normalizeText(templateText).replace(/\n+$/, "").split("\n");
  const output = [];
  let sawVisibility = false;
  for (const line of lines) {
    if (line.startsWith("id=")) continue;
    if (line.startsWith("visibility=")) {
      if (!sawVisibility) output.push(`visibility=${visibility}`);
      sawVisibility = true;
      continue;
    }
    output.push(line);
    if (line === "version=1" && workshopId) output.push(`id=${workshopId}`);
  }
  if (!sawVisibility) output.push(`visibility=${visibility}`);
  return `${output.join("\n")}\n`;
}

// OS and editor litter (Thumbs.db, .DS_Store, backups, swap files). None of it
// is ever meant to ship, and the build only copies the three sources anyway,
// so it doesn't fail the check. Any other stray file still does: it could be
// a real source that the item would silently leave out.
const SOURCE_TREE_LITTER = /(^|\/)(Thumbs\.db|desktop\.ini|\.DS_Store)$|\.(bak|swp|swo|tmp)$|~$/i;

function sourceTreeErrors(repoRoot) {
  const errors = [];
  const sourceRoot = "pz-mod/PanelBridge";
  const present = listFiles(path.join(repoRoot, sourceRoot))
    .filter((file) => !SOURCE_TREE_LITTER.test(file))
    .map((file) => `${sourceRoot}/${file}`);
  for (const file of present) {
    if (!BRIDGE_SOURCE_FILES.includes(file)) {
      errors.push(`${file}: unexpected file; the Workshop item ships exactly ${BRIDGE_SOURCE_FILES.join(", ")}`);
    }
  }
  for (const file of BRIDGE_SOURCE_FILES) {
    if (!present.includes(file)) errors.push(`${file} is missing`);
  }
  return errors;
}

export function itemLayoutErrors(files) {
  const errors = [];
  const expectedLua = [ITEM_FILES.serverLua, ITEM_FILES.clientLua];
  for (const file of files) {
    const segments = file.split("/");
    if (segments[0] === "Contents" && segments[1] !== "mods") {
      errors.push(`${file}: only mods/ is allowed under Contents/`);
    }
    if (segments.some((segment) => segment.toLowerCase() === "shared")) {
      errors.push(`${file}: no shared/ Lua (it would load on the server and on every client)`);
    }
    if (file.toLowerCase().endsWith(".lua") && !expectedLua.includes(file)) {
      errors.push(`${file}: the only Lua paths are ${expectedLua.join(" and ")}`);
    }
    const extension = path.posix.extname(file).toLowerCase();
    if (BLOCKED_EXTENSIONS.includes(extension)) {
      errors.push(`${file}: ${extension} files are refused by the Workshop uploader`);
    }
  }
  for (const file of expectedLua) {
    if (!files.includes(file)) errors.push(`${file} is missing from the item`);
  }
  return errors;
}

// Reads the sources, runs every check and returns the item's files in memory.
// Never writes.
export function planWorkshopItem(repoRoot = REPO_ROOT) {
  const errors = [...sourceTreeErrors(repoRoot)];
  const read = (relativePath) => {
    try {
      return fs.readFileSync(path.join(repoRoot, relativePath));
    } catch {
      errors.push(`${relativePath} is missing`);
      return null;
    }
  };

  const published = readPublished(repoRoot);
  errors.push(...published.errors);

  const modInfoBytes = read(BRIDGE_FILES.modInfo);
  const serverLuaBytes = read(BRIDGE_FILES.serverLua);
  const clientLuaBytes = read(BRIDGE_FILES.clientLua);
  const templateBytes = read(BRIDGE_FILES.workshopTxt);
  const modInfo = modInfoBytes ? normalizeText(modInfoBytes.toString("utf8")) : "";
  const serverLua = serverLuaBytes ? normalizeText(serverLuaBytes.toString("utf8")) : "";
  const clientLua = clientLuaBytes ? normalizeText(clientLuaBytes.toString("utf8")) : "";

  // 1. mod.info lint.
  const lint = lintModInfo(modInfo);
  errors.push(...lint.errors);

  // 2. One mod id everywhere: mod.info, published.json and the Lua MOD_ID the
  //    bridge reports its delivery with.
  if (lint.fields.id !== undefined && lint.fields.id !== MOD_ID) {
    errors.push(`mod.info id=${lint.fields.id}, expected ${MOD_ID}`);
  }
  const luaModId = /\bMOD_ID\s*=\s*"([^"]*)"/.exec(serverLua)?.[1];
  if (serverLuaBytes && luaModId !== MOD_ID) {
    errors.push(`PanelBridge.lua must declare MOD_ID = "${MOD_ID}" (found ${luaModId === undefined ? "none" : JSON.stringify(luaModId)})`);
  }

  // 3. modversion = VERSION = header Version:.
  if (serverLuaBytes && modInfoBytes) errors.push(...versionParityErrors(readBridgeVersions(serverLua, modInfo)));

  // 4. The load guards come before anything else runs.
  if (serverLuaBytes && firstExecutableLine(serverLua) !== SERVER_LUA_GUARD) {
    errors.push(`PanelBridge.lua: the first executable statement must be \`${SERVER_LUA_GUARD}\``);
  }
  if (clientLuaBytes && firstExecutableLine(clientLua) !== CLIENT_LUA_GUARD) {
    errors.push(`PanelBridgeClient.lua: the first executable statement must be \`${CLIENT_LUA_GUARD}\``);
  }

  // workshop.txt template and 8. tags.
  const template = templateBytes ? parseWorkshopTxt(templateBytes.toString("utf8")) : null;
  if (template) {
    errors.push(...template.errors);
    if (template.entries[0]?.key !== "version" || template.entries[0]?.value !== "1") {
      errors.push("workshop.txt must start with version=1");
    }
    if (template.id !== null) errors.push("workshop.txt template must not carry id= (the build adds it from published.json)");
    if (!template.title) errors.push("workshop.txt has no title=");
    if (!template.descriptionLines.some((line) => line.trim())) errors.push("workshop.txt has no description=");
    // An operator who adds this item on the Mods page by its Workshop id gets
    // the mod id the description names, so it must be MOD_ID.
    const describedModId = DESCRIPTION_MOD_ID.exec(template.descriptionLines.join("\n"))?.[1].trim();
    if (describedModId !== MOD_ID) {
      errors.push(
        `workshop.txt description must say "Mod ID: ${MOD_ID}" (found ${describedModId === undefined ? "none" : JSON.stringify(describedModId)}); ` +
          "the panel's Mods page reads the mod id from it",
      );
    }
    if (template.tags !== WORKSHOP_TAGS) {
      errors.push(`workshop.txt tags must be exactly ${WORKSHOP_TAGS} (found ${JSON.stringify(template.tags)})`);
    }
  }

  // 7. Images.
  const images = {};
  for (const [name, rule] of Object.entries(IMAGE_RULES)) {
    images[name] = read(rule.file);
    if (images[name]) errors.push(...imageErrors(rule.file, images[name], rule.sizes));
  }

  const doc = published.doc;
  const workshopId = published.errors.length ? null : doc.workshopId;
  const visibility = (published.errors.length ? null : doc.visibility) ?? "unlisted";
  const files = new Map();
  if (template) files.set(ITEM_FILES.workshopTxt, Buffer.from(renderWorkshopTxt(templateBytes.toString("utf8"), { workshopId, visibility }), "utf8"));
  if (images.preview) files.set(ITEM_FILES.preview, images.preview);
  if (modInfoBytes) files.set(ITEM_FILES.modInfo, Buffer.from(modInfo, "utf8"));
  if (images.poster) files.set(ITEM_FILES.poster, images.poster);
  if (images.icon) files.set(ITEM_FILES.icon, images.icon);
  if (serverLuaBytes) files.set(ITEM_FILES.serverLua, Buffer.from(serverLua, "utf8"));
  if (clientLuaBytes) files.set(ITEM_FILES.clientLua, Buffer.from(clientLua, "utf8"));

  // 5-6. Layout and file types.
  errors.push(...itemLayoutErrors([...files.keys()]));

  return { files, errors, workshopId, visibility, template };
}

// 9. An existing staged item that already points at a different Workshop id
//    must never be overwritten: the next upload would update (or create) the
//    wrong item.
function stagedItemErrors(itemDir, workshopId) {
  if (!fs.existsSync(itemDir)) return [];
  const stagedTxtPath = path.join(itemDir, "workshop.txt");
  if (!fs.existsSync(stagedTxtPath)) {
    return fs.readdirSync(itemDir).length
      ? [`${itemDir} exists but has no workshop.txt; refusing to overwrite a folder that isn't a staged Workshop item`]
      : [];
  }
  const staged = parseWorkshopTxt(fs.readFileSync(stagedTxtPath, "utf8"));
  const stagedId = staged.id?.trim() || null;
  if (stagedId && stagedId !== workshopId) {
    return [
      workshopId
        ? `${stagedTxtPath} has id=${stagedId} but published.json says ${workshopId}; refusing to overwrite it`
        : `${stagedTxtPath} has id=${stagedId} but published.json has no workshopId yet; record it first: node scripts/workshop/publish.mjs record --from-staged "${itemDir}"`,
    ];
  }
  return [];
}

export function resolveOutDir(repoRoot, outDir) {
  return outDir ? path.resolve(expandHome(outDir)) : path.join(repoRoot, DEFAULT_OUT_DIR);
}

export function buildWorkshopItem({ repoRoot = REPO_ROOT, outDir, check = false } = {}) {
  const resolvedOutDir = resolveOutDir(repoRoot, outDir);
  const itemDir = path.join(resolvedOutDir, MOD_ID);
  const plan = planWorkshopItem(repoRoot);
  const errors = [...plan.errors];
  if (isInside(path.join(repoRoot, "release"), resolvedOutDir)) {
    errors.push(`${resolvedOutDir} is under release/, which release.ps1 zips into the panel archive; use dist-workshop/ or --out`);
  }
  errors.push(...stagedItemErrors(itemDir, plan.workshopId));
  // A missing source is reported by both the tree scan and the read.
  if (errors.length) throw new WorkshopBuildError([...new Set(errors)]);

  const files = {};
  for (const [relativePath, bytes] of plan.files) files[relativePath] = sha256Hex(bytes);
  if (check) return { outDir: resolvedOutDir, itemDir, files, written: false };

  // Contents/ is replaced wholesale so a file dropped from the item can't
  // linger in a staged copy and get uploaded again.
  fs.rmSync(path.join(itemDir, "Contents"), { recursive: true, force: true });
  for (const [relativePath, bytes] of plan.files) {
    const target = path.join(itemDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const writtenContents = listFiles(itemDir, "Contents");
  const plannedContents = [...plan.files.keys()].filter((file) => file.startsWith("Contents/")).sort();
  if (JSON.stringify(writtenContents) !== JSON.stringify(plannedContents)) {
    throw new WorkshopBuildError([`${itemDir}/Contents doesn't match the planned item after writing`]);
  }
  return { outDir: resolvedOutDir, itemDir, files, written: true };
}

const USAGE = `Usage: node scripts/workshop/build-item.mjs [--out <dir>] [--check]

Builds the PanelBridge Steam Workshop item (Build 42 layout).
  --out <dir>  Parent folder for the item, e.g. ~/Zomboid/Workshop for the
               in-game uploader. Default: ${DEFAULT_OUT_DIR}/
  --check      Run every check and write nothing (CI, release.ps1).`;

export function runBuildItemCli(argv, { repoRoot = REPO_ROOT, log = console.log, error = console.error } = {}) {
  let outDir;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      log(USAGE);
      return 0;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--out" && argv[index + 1]) {
      outDir = argv[++index];
    } else if (arg.startsWith("--out=")) {
      outDir = arg.slice("--out=".length);
    } else {
      error(`Unknown or incomplete argument: ${arg}\n\n${USAGE}`);
      return 2;
    }
  }
  try {
    const result = buildWorkshopItem({ repoRoot, outDir, check });
    const count = Object.keys(result.files).length;
    if (check) {
      log(`Workshop item check passed (${count} files, would be written to ${result.itemDir})`);
    } else {
      log(`Workshop item written to ${result.itemDir}`);
      for (const file of Object.keys(result.files).sort()) log(`  ${file}`);
      if (isWorkshopStagingFolder(result.outDir)) {
        log(
          "Until it is moved out of this Workshop folder, the game and any Steam-mode server that uses this Zomboid " +
            "folder load this staged copy instead of the downloaded Workshop item. After uploading it in-game, run: " +
            `node scripts/workshop/publish.mjs record --from-staged "${result.itemDir}"`,
        );
      }
    }
    return 0;
  } catch (caught) {
    error(caught instanceof WorkshopBuildError ? caught.message : `Workshop item build failed: ${caught.message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runBuildItemCli(process.argv.slice(2));
}
