// Shared helpers for the PanelBridge Steam Workshop tooling: build-item.mjs,
// publish.mjs, render-art.mjs and ../check-bridge-version.mjs.
//
// Everything here is pure Node (no dependencies): the checks run in CI, in
// release.ps1 and on the maintainer's machine, and none of them may need a
// browser, the game or Steam.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

export const MOD_ID = "ZomboidControlPanelBridge";
export const STEAM_APP_ID = "108600";
export const WORKSHOP_TAGS = "Build 42;Multiplayer;Framework";
// SteamWorkshopItem.validatePreviewImage (42.20): Files.size > 1024000 -> PreviewFileSize.
export const MAX_IMAGE_BYTES = 1024000;
// ZomboidFileSystem/GameServer accept WorkshopItems= ids that parse as an
// unsigned 64-bit Steam id (isValidSteamID).
const MAX_STEAM_ID = 18446744073709551615n;

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const BRIDGE_FILES = Object.freeze({
  serverLua: "pz-mod/PanelBridge/media/lua/server/PanelBridge.lua",
  clientLua: "pz-mod/PanelBridge/media/lua/client/PanelBridgeClient.lua",
  modInfo: "pz-mod/PanelBridge/mod.info",
  published: "pz-mod/workshop/published.json",
  workshopTxt: "pz-mod/workshop/workshop.txt",
  preview: "pz-mod/workshop/preview.png",
  poster: "pz-mod/workshop/poster.png",
  icon: "pz-mod/workshop/icon.png",
  lock: "pz-mod/bridge-version.lock.json",
});

// The only files the Workshop item (and the loose install) are built from.
// Anything else under pz-mod/PanelBridge/ (OS and editor litter aside) would
// be silently left out of the item, so the build rejects it instead.
export const BRIDGE_SOURCE_FILES = Object.freeze([
  BRIDGE_FILES.serverLua,
  BRIDGE_FILES.clientLua,
  BRIDGE_FILES.modInfo,
]);

// Order matters: it is part of the lock hash.
export const BRIDGE_CODE_FILES = Object.freeze([
  BRIDGE_FILES.serverLua,
  BRIDGE_FILES.clientLua,
  BRIDGE_FILES.modInfo,
]);

// The first executable statement each Lua file must start with. Clients run
// every mod's media/lua/server, and single player runs both folders, so the
// guards are what make the Workshop copy safe to load outside the dedicated
// server (spec §7.1-7.2).
export const SERVER_LUA_GUARD = "if not (isServer and isServer()) then return end";
export const CLIENT_LUA_GUARD = "if not (isClient and isClient()) then return end";

export function normalizeText(text) {
  return String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

export function readRepoText(repoRoot, relativePath) {
  return normalizeText(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

export function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function expandHome(input) {
  const value = String(input);
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Whether the module at moduleUrl is the script node was started with.
// process.argv[1] keeps the path as typed, but node resolves the entry point
// to its real path before import.meta.url is set, so a repo reached through a
// junction, symlink or subst drive compared unresolved would make the CLI do
// nothing and exit 0: a silently green CI or release gate.
export function isMainModule(moduleUrl, entryPath = process.argv[1]) {
  if (!entryPath) return false;
  const realPath = (file) => {
    try {
      return fs.realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  return realPath(path.resolve(entryPath)) === realPath(fileURLToPath(moduleUrl));
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(version) {
  const match = SEMVER.exec(String(version ?? ""));
  return match ? match.slice(1).map(Number) : null;
}

export function compareSemver(left, right) {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  if (!leftParts || !rightParts) throw new Error(`Not a numeric SemVer: ${leftParts ? right : left}`);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function nextPatch(version) {
  const parts = parseSemver(version);
  if (!parts) throw new Error(`Not a numeric SemVer: ${version}`);
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

// Same patterns as release.ps1 (Assert-ReleaseVersionParity) and
// scripts/verify-release-version.mjs, so the three agree on what counts as a
// declaration.
export function readBridgeVersions(luaText, modInfoText) {
  return {
    header: [...luaText.matchAll(/^\s*Version:\s*([^\r\n]+)\r?$/gm)].map((match) => match[1].trim()),
    runtime: [...luaText.matchAll(/^\s*VERSION\s*=\s*"([^"]+)"/gm)].map((match) => match[1]),
    modversion: [...modInfoText.matchAll(/^modversion=([^\r\n]+)\r?$/gm)].map((match) => match[1].trim()),
  };
}

export function versionParityErrors(versions) {
  const errors = [];
  for (const [label, values] of [
    ["PanelBridge.lua header Version:", versions.header],
    ["PanelBridge.lua VERSION", versions.runtime],
    ["mod.info modversion=", versions.modversion],
  ]) {
    if (values.length !== 1) errors.push(`${label} must appear exactly once (found ${values.length})`);
  }
  if (errors.length) return errors;
  const [header] = versions.header;
  const [runtime] = versions.runtime;
  const [modversion] = versions.modversion;
  if (!parseSemver(runtime)) errors.push(`PanelBridge.lua VERSION is not a numeric SemVer: ${runtime}`);
  if (header !== runtime || modversion !== runtime) {
    errors.push(`PanelBridge versions differ: header ${header}, VERSION ${runtime}, mod.info modversion ${modversion}`);
  }
  return errors;
}

// The lock hash covers the bytes a server or player actually runs, minus the
// three version declarations: a release that only rewrites the version must
// not look like a code change, and CRLF/BOM differences between checkouts
// must not either. [ \t]* rather than \s* keeps a match on its own line, so
// the blank lines around a declaration still count as content.
function normalizeForCodeHash(text) {
  return normalizeText(text)
    .replace(/^[ \t]*Version:.*$/gm, "Version: <bridge-version>")
    .replace(/^[ \t]*VERSION\s*=\s*"[^"]*"/gm, "VERSION = \"<bridge-version>\"")
    .replace(/^modversion=.*$/gm, "modversion=<bridge-version>");
}

export function computeCodeSha256(repoRoot) {
  const hash = crypto.createHash("sha256");
  for (const relativePath of BRIDGE_CODE_FILES) {
    const content = normalizeForCodeHash(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
    hash.update(`${relativePath}\n${content}\n\0`, "utf8");
  }
  return hash.digest("hex");
}

export function readBridgeState(repoRoot) {
  const lua = readRepoText(repoRoot, BRIDGE_FILES.serverLua);
  const modInfo = readRepoText(repoRoot, BRIDGE_FILES.modInfo);
  const versions = readBridgeVersions(lua, modInfo);
  return {
    versions,
    version: versions.runtime.length === 1 ? versions.runtime[0] : null,
    parityErrors: versionParityErrors(versions),
    codeSha256: computeCodeSha256(repoRoot),
  };
}

export function readLock(repoRoot) {
  const lockPath = path.join(repoRoot, BRIDGE_FILES.lock);
  if (!fs.existsSync(lockPath)) {
    return { lock: null, error: `${BRIDGE_FILES.lock} is missing; create it with --write-lock <version>` };
  }
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (error) {
    return { lock: null, error: `${BRIDGE_FILES.lock} is not valid JSON: ${error.message}` };
  }
  if (lock?.schema !== 1 || !parseSemver(lock.version) || !/^[0-9a-f]{64}$/.test(String(lock.codeSha256 ?? ""))) {
    return { lock: null, error: `${BRIDGE_FILES.lock} must be { "schema": 1, "version": "x.y.z", "codeSha256": "<64 hex>" }` };
  }
  return { lock, error: null };
}

export function formatLock(version, codeSha256) {
  return `${JSON.stringify({ schema: 1, version, codeSha256 }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// published.json
// ---------------------------------------------------------------------------

// Stricter than the spec's field rule: 0 is item.vdf's "create a new item",
// never a published item, yet isValidSteamID accepts it, so a hand-edited
// "0" would reach WorkshopItems=0 and abort a Workshop server's startup. And
// the id is taken in its plain decimal form only: the bridge heartbeat
// reports that form and the panel compares the two as strings, so a
// leading-zero "03712345678" would never be confirmed. The panel's reader
// (server/services/bridgeWorkshopRelease.js) applies the same rule.
export function isValidWorkshopId(id) {
  return typeof id === "string" && /^[1-9]\d{0,19}$/.test(id) && BigInt(id) <= MAX_STEAM_ID;
}

export function publishedDocErrors(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ["published.json must be a JSON object"];
  if (doc.schema !== 1) errors.push(`published.json schema must be 1 (found ${JSON.stringify(doc.schema)})`);
  if (doc.modId !== MOD_ID) errors.push(`published.json modId must be ${MOD_ID} (found ${JSON.stringify(doc.modId)})`);
  if (doc.workshopId !== null && !isValidWorkshopId(doc.workshopId)) {
    errors.push(`published.json workshopId must be null or a non-zero numeric Steam id string, without leading zeros (found ${JSON.stringify(doc.workshopId)})`);
  }
  if (![null, "public", "unlisted"].includes(doc.visibility)) {
    errors.push(`published.json visibility must be null, "public" or "unlisted" (found ${JSON.stringify(doc.visibility)})`);
  }
  if (doc.publishedVersion !== null && !parseSemver(doc.publishedVersion)) {
    errors.push(`published.json publishedVersion must be null or x.y.z (found ${JSON.stringify(doc.publishedVersion)})`);
  }
  if (doc.publishedAt !== null && typeof doc.publishedAt !== "string") {
    errors.push("published.json publishedAt must be null or an ISO date string");
  }
  const live = doc.liveVerified;
  if (!live || typeof live !== "object" || Array.isArray(live) || !("windowsServer" in live) || !("linuxServer" in live)) {
    errors.push("published.json liveVerified must hold windowsServer and linuxServer (null until the live test)");
  } else {
    // Filled by hand after the maintainer's live test. The panel drops the
    // Preview badge once both are non-null and trusts the Linux checksum only
    // on a literal true, so a typo here would change what operators are told.
    for (const key of ["windowsServer", "linuxServer"]) {
      if (!liveVerifiedEntryIsValid(live[key])) {
        errors.push(
          `published.json liveVerified.${key} must be null or ` +
            "{ \"gameVersion\": \"42.20\", \"date\": \"YYYY-MM-DD\", \"nonAdminJoinWithChecksumOn\": true|false }",
        );
      }
    }
  }
  return errors;
}

function liveVerifiedEntryIsValid(entry) {
  if (entry === null) return true;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  return typeof entry.gameVersion === "string" && /^\d+\.\d+(\.\d+)?$/.test(entry.gameVersion) &&
    typeof entry.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) &&
    typeof entry.nonAdminJoinWithChecksumOn === "boolean";
}

export function readPublished(repoRoot) {
  const publishedPath = path.join(repoRoot, BRIDGE_FILES.published);
  let text;
  try {
    text = fs.readFileSync(publishedPath, "utf8");
  } catch {
    return { doc: null, text: null, errors: [`${BRIDGE_FILES.published} is missing`] };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { doc: null, text, errors: [`${BRIDGE_FILES.published} is not valid JSON: ${error.message}`] };
  }
  return { doc, text, errors: publishedDocErrors(doc) };
}

// Rewrites only the given top-level scalar fields of published.json and keeps
// every other byte (the maintainer fills liveVerified by hand, and a full
// re-serialisation would reflow it). Falls back to a plain re-serialisation
// if a field isn't on a line of its own.
export function updatePublishedText(text, updates) {
  let next = text;
  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^(\\s*"${key}"\\s*:\\s*)(null|"(?:[^"\\\\]|\\\\.)*")`, "m");
    if (!pattern.test(next)) {
      const doc = { ...JSON.parse(text), ...updates };
      return `${JSON.stringify(doc, null, 2)}\n`;
    }
    next = next.replace(pattern, (_match, prefix) => `${prefix}${JSON.stringify(value)}`);
  }
  const expected = { ...JSON.parse(text), ...updates };
  if (JSON.stringify(JSON.parse(next)) !== JSON.stringify(expected)) {
    return `${JSON.stringify(expected, null, 2)}\n`;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Items staged for the in-game uploader
// ---------------------------------------------------------------------------

// The in-game uploader works on items staged in <cachedir>/Workshop
// (~/Zomboid/Workshop by default; SteamWorkshop.getStageFolders). With Steam
// on, 42.20's ZomboidFileSystem.getAllModFolders lists each staged item's
// Contents/mods (getStagedItemModsFolders) before the Workshop downloads,
// ChooseGameInfo.getModDetails takes the first folder with a mod's id, and
// only the client's main menu ever reorders the folders. So while an uploaded
// copy stays staged, the game on that machine and any Steam-mode server that
// uses the same Zomboid folder run it instead of the downloaded item: the live
// test sees delivery "mod" and never the download, and after a later publish
// they silently keep running the old code (with DoLuaChecksum on, players who
// downloaded the new item are then refused).
export const DEFAULT_STAGED_ITEM_DIR = `~/Zomboid/Workshop/${MOD_ID}`;

export function isWorkshopStagingFolder(folder) {
  return path.basename(path.resolve(expandHome(folder))).toLowerCase() === "workshop";
}

export function stagedCopyWarning(itemDir = DEFAULT_STAGED_ITEM_DIR) {
  const stagingFolder = path.dirname(itemDir);
  return (
    `${itemDir} is still in the game's Workshop folder. Move it out of ${stagingFolder} before you test on this ` +
    "machine: while it is there, the game and any Steam-mode server that uses this Zomboid folder load that staged " +
    "copy instead of the downloaded Workshop item, so the live test would check the wrong files, and after the next " +
    "publish they would silently keep running this old code. To upload it in-game again, recreate it with its id: " +
    `npm run workshop:build -- --out "${stagingFolder}"`
  );
}

// ---------------------------------------------------------------------------
// mod.info, workshop.txt and Lua text checks
// ---------------------------------------------------------------------------

// ChooseGameInfo.readModInfoAux (42.20) knows these keys. require= and pack=
// are known but harmful here: an empty require= makes the mod unavailable and
// pack= registers a texture pack.
const ENGINE_MOD_INFO_KEYS = new Set([
  "name", "poster", "description", "require", "incompatible", "loadModAfter", "loadModBefore",
  "id", "author", "modversion", "icon", "category", "url", "pack", "tiledef", "versionMin", "versionMax",
]);
const FORBIDDEN_MOD_INFO_KEYS = new Set(["require", "pack", "pzversion", "authors"]);
// The build ships exactly these two images next to 42/mod.info.
const MOD_INFO_IMAGES = { poster: "poster.png", icon: "icon.png" };

export function lintModInfo(text) {
  const errors = [];
  const fields = {};
  const lines = normalizeText(text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  lines.forEach((line, index) => {
    const where = `mod.info line ${index + 1}`;
    const key = line.split("=")[0];
    if (FORBIDDEN_MOD_INFO_KEYS.has(key)) {
      errors.push(`${where}: ${key}= is not allowed (require=/pack= break loading; pzversion=/authors= aren't engine keys)`);
      return;
    }
    // id= is matched with startsWith but every other key with contains(), so
    // a value holding "name=", "url=" and so on would be read as that key.
    if (!/^[a-zA-Z]+=[^=]*$/.test(line)) {
      errors.push(`${where}: must be key=value with no "=" inside the value: ${JSON.stringify(line)}`);
      return;
    }
    if (!ENGINE_MOD_INFO_KEYS.has(key)) {
      errors.push(`${where}: unknown key ${key}=`);
      return;
    }
    const value = line.slice(key.length + 1);
    if (value.trim() === "") {
      // An empty list key parses as [""] (the require= blocker); an empty
      // scalar is useless. Neither belongs in the file.
      errors.push(`${where}: ${key}= has an empty value`);
      return;
    }
    if (key === "description" || key === "poster") {
      (fields[key] ??= []).push(value);
    } else if (key in fields) {
      errors.push(`${where}: ${key}= appears more than once`);
    } else {
      fields[key] = value;
    }
  });
  for (const key of ["name", "id", "modversion"]) {
    if (!(key in fields)) errors.push(`mod.info is missing ${key}=`);
  }
  for (const [key, file] of Object.entries(MOD_INFO_IMAGES)) {
    const values = key === "poster" ? (fields.poster ?? []) : (fields[key] ? [fields[key]] : []);
    for (const value of values) {
      if (value !== file) errors.push(`mod.info ${key}= must be ${file}, the image the build ships (found ${value})`);
    }
  }
  return { fields, errors };
}

const WORKSHOP_TXT_KEYS = new Set(["version", "id", "title", "description", "tags", "visibility"]);

export function parseWorkshopTxt(text) {
  const entries = [];
  const errors = [];
  normalizeText(text).split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//")) return;
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator) : null;
    if (!key || !WORKSHOP_TXT_KEYS.has(key)) {
      errors.push(`workshop.txt line ${index + 1}: unknown line ${JSON.stringify(line)}`);
      return;
    }
    entries.push({ key, value: line.slice(separator + 1) });
  });
  const first = (key) => entries.find((entry) => entry.key === key)?.value ?? null;
  return {
    entries,
    errors,
    id: first("id"),
    title: first("title"),
    tags: first("tags"),
    visibility: first("visibility"),
    descriptionLines: entries.filter((entry) => entry.key === "description").map((entry) => entry.value),
  };
}

// Returns the first line of executable Lua (comments and blank lines skipped,
// a trailing line comment removed), or null for a file with no code.
export function firstExecutableLine(luaText) {
  const text = normalizeText(luaText);
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }
    if (rest.startsWith("--")) {
      const longBracket = /^--\[(=*)\[/.exec(rest);
      if (longBracket) {
        const close = `]${longBracket[1]}]`;
        const end = text.indexOf(close, index + longBracket[0].length);
        if (end === -1) return null;
        index = end + close.length;
      } else {
        const lineEnd = text.indexOf("\n", index);
        index = lineEnd === -1 ? text.length : lineEnd + 1;
      }
      continue;
    }
    const lineEnd = text.indexOf("\n", index);
    const line = text.slice(index, lineEnd === -1 ? text.length : lineEnd);
    return line.replace(/--.*$/, "").replace(/\s+/g, " ").trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// The zombie.core.textures.PNGDecoder bundled with 42.20 accepts these
// (colour type -> bit depths) and nothing interlaced, filtered or compressed
// with a non-zero method.
const DECODABLE_BIT_DEPTHS = { 0: [8], 2: [8], 3: [1, 2, 4, 8], 4: [8], 6: [8] };
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// Parses and structurally verifies a PNG: signature, every chunk CRC, IHDR
// first, IEND last, and IDAT data that inflates to exactly the scanline size
// the header promises. Throws with a readable reason.
export function readPngInfo(buffer) {
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG file (bad signature)");
  }
  let offset = 8;
  let info = null;
  const idat = [];
  let sawEnd = false;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error("truncated chunk");
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    if (offset + 12 + length > buffer.length) throw new Error(`truncated ${type} chunk`);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) throw new Error(`bad CRC in ${type} chunk`);
    if (!info && type !== "IHDR") throw new Error("first chunk is not IHDR");
    if (type === "IHDR") {
      if (info) throw new Error("more than one IHDR chunk");
      if (length !== 13) throw new Error("IHDR has the wrong length");
      info = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      sawEnd = true;
      offset += 12 + length;
      break;
    }
    offset += 12 + length;
  }
  if (!info) throw new Error("no IHDR chunk");
  if (!sawEnd) throw new Error("no IEND chunk");
  if (offset !== buffer.length) throw new Error("data after IEND");
  if (!idat.length) throw new Error("no IDAT chunk");
  const depths = DECODABLE_BIT_DEPTHS[info.colorType];
  if (!depths || !depths.includes(info.bitDepth)) {
    throw new Error(`colour type ${info.colorType} at ${info.bitDepth}-bit isn't decodable by the game`);
  }
  if (info.compression !== 0 || info.filter !== 0) throw new Error("unsupported compression or filter method");
  if (info.interlace !== 0) throw new Error("interlaced PNGs aren't decodable by the game");
  if (!info.width || !info.height) throw new Error("zero-sized image");
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch (error) {
    throw new Error(`image data doesn't inflate: ${error.message}`);
  }
  const rowBytes = Math.ceil((info.width * info.bitDepth * CHANNELS[info.colorType]) / 8);
  if (raw.length !== info.height * (rowBytes + 1)) throw new Error("image data size doesn't match the header");
  return info;
}

// Spec §8.4. The preview rule is the in-game uploader's own
// (SteamWorkshopItem.validatePreviewImage: width == height, 256 or 512,
// <= 1,024,000 bytes). Poster and icon sizes are this project's choice; the
// mod list draws them scaled (ModInfoPanel*, ModListBox: 28 px icons).
export const IMAGE_RULES = Object.freeze({
  preview: { file: BRIDGE_FILES.preview, sizes: [256, 512] },
  poster: { file: BRIDGE_FILES.poster, sizes: [256] },
  icon: { file: BRIDGE_FILES.icon, sizes: [32] },
});

export function imageErrors(label, buffer, sizes) {
  if (buffer.length > MAX_IMAGE_BYTES) {
    return [`${label}: ${buffer.length} bytes, over the ${MAX_IMAGE_BYTES}-byte limit`];
  }
  let info;
  try {
    info = readPngInfo(buffer);
  } catch (error) {
    return [`${label}: ${error.message}`];
  }
  if (info.width !== info.height || !sizes.includes(info.width)) {
    return [`${label}: ${info.width}x${info.height}, must be square at ${sizes.join(" or ")} px`];
  }
  return [];
}
