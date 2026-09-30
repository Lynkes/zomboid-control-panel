// Per-root Trash for local Server Files roots (spec §A6.6).
//
// Layout: <root>/.zcp-trash/<YYYYMMDDTHHMMSSZ>-<hex8>/
//           payload/<original name>   the moved (or copied) item
//           meta.json                 { v:1, originalPath, type, bytes, files,
//                                       deletedAt, deletedBy, reason }
// Everything here is panel-generated: the Trash folder's fixed name, random
// item ids, and meta.json. The only fs calls this module makes itself are on
// meta.json; moving payloads goes through fileManagerLocalFs.js like every
// other file-manager write.
//
// meta.json is untrusted on the way back in: an OS user (or a crafted file)
// could have written anything there, so every field is re-validated, the
// payload's name is read from the folder rather than from meta, and a
// restore target always goes back through resolve().
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ErrorCode } from "../utils/errorCodes.js";
import {
  FM_LIMITS,
  FmError,
  TRASH_DIR_NAME,
  TRASH_ID_RE,
  TRASH_REASONS,
  validateSegments,
} from "./fileManagerContract.js";
import {
  assertWritable,
  deleteTree,
  lstatBig,
  mkdirPath,
  readDirNames,
  readSmallFileNoFollow,
  renamePath,
  rmdirPath,
  unlinkQuiet,
  writeNewFileExcl,
} from "./fileManagerLocalFs.js";

const META_NAME = "meta.json";
const PAYLOAD_DIR = "payload";
const META_MAX_BYTES = 64 * 1024;
const TRASH_LIST_MAX = 20000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function trashDirOf(rootReal) {
  return path.join(rootReal, TRASH_DIR_NAME);
}

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function newTrashId(date = new Date()) {
  return `${stamp(date)}-${crypto.randomBytes(4).toString("hex")}`;
}

/** Milliseconds encoded in a Trash id, or NaN. */
export function trashIdTime(trashId) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(String(trashId));
  if (!match) return NaN;
  const [, y, mo, d, h, mi, s] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

function expiresAtFor(trashId) {
  const time = trashIdTime(trashId);
  return Number.isFinite(time) ? new Date(time + FM_LIMITS.TRASH_RETENTION_DAYS * DAY_MS).toISOString() : null;
}

function unavailable(reason) {
  return new FmError(ErrorCode.FM_TRASH_UNAVAILABLE, undefined, { reason });
}

/**
 * The Trash folder's state without creating it: `dev` of the folder that
 * would hold items (the Trash folder, or the root before it exists), and
 * whether it can be used at all.
 */
export function probeTrash(rootReal) {
  const dir = trashDirOf(rootReal);
  try {
    const st = lstatBig(dir);
    if (!st.isDirectory()) return { usable: false, reason: "notWritable", dev: null };
    assertWritable(dir);
    return { usable: true, dev: st.dev, exists: true };
  } catch (err) {
    if (err?.code !== "ENOENT") return { usable: false, reason: "notWritable", dev: null };
  }
  try {
    const st = lstatBig(rootReal);
    assertWritable(rootReal);
    return { usable: true, dev: st.dev, exists: false };
  } catch {
    return { usable: false, reason: "notWritable", dev: null };
  }
}

// The Trash folder, created on first use (0700). A link or a file squatting
// on the name makes Trash unavailable rather than being followed.
function ensureTrashDir(rootReal) {
  const dir = trashDirOf(rootReal);
  try {
    const st = lstatBig(dir);
    if (!st.isDirectory()) throw unavailable("notWritable");
    return { dir, dev: st.dev };
  } catch (err) {
    if (err instanceof FmError) throw err;
    if (err?.code !== "ENOENT") throw unavailable("notWritable");
  }
  try {
    mkdirPath(dir, 0o700);
    return { dir, dev: lstatBig(dir).dev };
  } catch (err) {
    if (err?.code === "EEXIST") return ensureTrashDir(rootReal);
    throw unavailable("notWritable");
  }
}

function createItem(rootReal) {
  const { dir, dev } = ensureTrashDir(rootReal);
  const trashId = newTrashId();
  const itemDir = path.join(dir, trashId);
  const payloadDir = path.join(itemDir, PAYLOAD_DIR);
  try {
    mkdirPath(itemDir, 0o700);
    mkdirPath(payloadDir, 0o700);
  } catch {
    removeItemShell(itemDir);
    throw unavailable("notWritable");
  }
  return { trashId, itemDir, payloadDir, dev };
}

function writeMeta(itemDir, meta) {
  const metaPath = path.join(itemDir, META_NAME);
  const body = JSON.stringify(meta, null, 2);
  // Panel-owned file with a generated name inside a panel-generated folder;
  // "wx" never overwrites and never follows a link at that name.
  // codeql[js/path-injection, js/http-to-file-access] metaPath is <root>/.zcp-trash/<generated trash id>/meta.json: the root is server-derived from the profile, the id is panel-generated (newTrashId), and the JSON holds only the item's root-relative path, sizes, the acting user and a reason -- never file content.
  fs.writeFileSync(metaPath, body, { flag: "wx", mode: 0o600 });
}

// Remove an item's (now empty) folders and its meta.json.
function removeItemShell(itemDir) {
  try {
    // codeql[js/path-injection] itemDir is <root>/.zcp-trash/<trash id>: a server-derived root and an id that is panel-generated or matched TRASH_ID_RE (digits, T, Z, hex) before use.
    fs.unlinkSync(path.join(itemDir, META_NAME));
  } catch {
    /* no meta yet */
  }
  for (const dir of [path.join(itemDir, PAYLOAD_DIR), itemDir]) {
    try {
      rmdirPath(dir);
    } catch {
      /* not empty or gone */
    }
  }
}

function buildMeta({ originalPath, type, bytes, files, deletedBy, reason }) {
  return {
    v: 1,
    originalPath,
    type,
    bytes: Number.isFinite(bytes) ? bytes : 0,
    files: Number.isFinite(files) ? files : type === "file" ? 1 : 0,
    deletedAt: new Date().toISOString(),
    deletedBy: { userId: deletedBy?.userId ?? null, username: deletedBy?.username ?? null },
    reason,
  };
}

/**
 * Move an item (file, folder or link -- rename never follows) into a new
 * Trash item. Throws FM_TRASH_UNAVAILABLE {reason:"crossDevice"} when the
 * item is on a different device from the Trash folder.
 * @returns {string} trashId
 */
export function moveToTrash(rootReal, abs, { originalPath, type, bytes, files, deletedBy, reason, dev }) {
  const item = createItem(rootReal);
  if (dev !== null && dev !== undefined && item.dev !== undefined && BigInt(dev) !== BigInt(item.dev)) {
    removeItemShell(item.itemDir);
    throw unavailable("crossDevice");
  }
  // meta.json first: an item without one can't be listed, restored or
  // purged from the panel, so if it can't be written nothing moves.
  writeMetaOrFail(item.itemDir, buildMeta({ originalPath, type, bytes, files, deletedBy, reason }));
  const target = path.join(item.payloadDir, path.basename(abs));
  try {
    renamePath(abs, target);
  } catch (err) {
    removeItemShell(item.itemDir);
    if (err?.code === "EXDEV") throw unavailable("crossDevice");
    throw err;
  }
  return item.trashId;
}

// meta.json for an item that is about to receive its payload; on failure the
// empty item is removed and Trash reports itself unavailable.
function writeMetaOrFail(itemDir, meta) {
  try {
    writeMeta(itemDir, meta);
  } catch {
    removeItemShell(itemDir);
    throw unavailable("notWritable");
  }
}

/**
 * Keep a copy of a file's previous bytes (an edited version) in Trash.
 * @returns {string} trashId
 */
export function copyVersionToTrash(rootReal, { name, buffer, mode, originalPath, deletedBy, reason }) {
  const item = createItem(rootReal);
  try {
    writeNewFileExcl(path.join(item.payloadDir, name), buffer, mode ?? 0o644);
    writeMeta(
      item.itemDir,
      buildMeta({ originalPath, type: "file", bytes: buffer.length, files: 1, deletedBy, reason }),
    );
  } catch (err) {
    unlinkQuiet(path.join(item.payloadDir, name));
    removeItemShell(item.itemDir);
    throw err;
  }
  return item.trashId;
}

/**
 * Prepare a Trash item for a "replaced" upload, its meta.json already
 * written (FM_TRASH_UNAVAILABLE when it can't be): the caller renames the old
 * file into `payloadPath`, or calls `discard()` when that doesn't happen.
 */
export function prepareTrashSlot(rootReal, name, metaInput) {
  const item = createItem(rootReal);
  writeMetaOrFail(item.itemDir, buildMeta(metaInput));
  return {
    trashId: item.trashId,
    dev: item.dev,
    payloadPath: path.join(item.payloadDir, name),
    discard() {
      removeItemShell(item.itemDir);
    },
  };
}

/**
 * Remove an item this request just made whose write then failed (the
 * "edited" version of a save that didn't land), so failed retries can't
 * push real versions out of the 20 kept per file.
 */
export function discardTrashItem(rootReal, trashId) {
  if (typeof trashId !== "string" || !TRASH_ID_RE.test(trashId)) return;
  const itemDir = path.join(trashDirOf(rootReal), trashId);
  const payloadDir = path.join(itemDir, PAYLOAD_DIR);
  try {
    for (const name of readDirNames(payloadDir, 4).names) unlinkQuiet(path.join(payloadDir, name));
  } catch {
    /* no payload */
  }
  removeItemShell(itemDir);
}

function sanitizeMeta(raw) {
  if (!raw || typeof raw !== "object") return null;
  const originalPath =
    typeof raw.originalPath === "string" && validateSegments(raw.originalPath).ok ? raw.originalPath : null;
  const type = raw.type === "dir" ? "dir" : "file";
  const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const username =
    raw.deletedBy && typeof raw.deletedBy.username === "string" ? raw.deletedBy.username.slice(0, 100) : null;
  const deletedAt =
    typeof raw.deletedAt === "string" && !Number.isNaN(Date.parse(raw.deletedAt)) ? raw.deletedAt : null;
  const reason = TRASH_REASONS.includes(raw.reason) ? raw.reason : "deleted";
  return { originalPath, type, bytes: num(raw.bytes), files: num(raw.files), deletedAt, username, reason };
}

function readMeta(itemDir) {
  const buffer = readSmallFileNoFollow(path.join(itemDir, META_NAME), META_MAX_BYTES);
  if (!buffer) return null;
  try {
    return sanitizeMeta(JSON.parse(buffer.toString("utf8")));
  } catch {
    return null;
  }
}

function listItemIds(rootReal) {
  const dir = trashDirOf(rootReal);
  try {
    const st = lstatBig(dir);
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }
  const { names } = readDirNames(dir, TRASH_LIST_MAX);
  return names.filter((name) => TRASH_ID_RE.test(name)).sort();
}

/** Number of items, without reading any meta.json. */
export function countTrashItems(rootReal) {
  return listItemIds(rootReal).length;
}

/**
 * Every listable Trash item, newest first. Items whose meta.json is missing
 * or unreadable are left out (the janitor still expires them).
 * @returns {Array<import("./fileManagerContract.js").TrashItem & { originalPathValid: boolean }>}
 */
export function listTrash(rootReal) {
  const items = [];
  for (const trashId of listItemIds(rootReal).reverse()) {
    const meta = readMeta(path.join(trashDirOf(rootReal), trashId));
    if (!meta || !meta.originalPath) continue;
    items.push({
      trashId,
      originalPath: meta.originalPath,
      type: meta.type,
      bytes: meta.bytes,
      files: meta.files,
      deletedAt: meta.deletedAt || new Date(trashIdTime(trashId)).toISOString(),
      deletedBy: { username: meta.username },
      reason: meta.reason,
      expiresAt: expiresAtFor(trashId),
    });
  }
  return items;
}

/**
 * One item, or FM_TRASH_ITEM_NOT_FOUND. `payloadName` is read from the
 * payload folder, never from meta.json.
 */
export function findTrashItem(rootReal, trashId) {
  if (typeof trashId !== "string" || !TRASH_ID_RE.test(trashId)) {
    throw new FmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
  }
  const itemDir = path.join(trashDirOf(rootReal), trashId);
  const payloadDir = path.join(itemDir, PAYLOAD_DIR);
  let names;
  try {
    // The Trash folder, the item and its payload folder must each be a real
    // folder: a link (or junction) planted at any of them would make a read
    // or a restore act on files outside the root.
    for (const dir of [trashDirOf(rootReal), itemDir, payloadDir]) {
      if (!lstatBig(dir).isDirectory()) throw new Error("not a folder");
    }
    ({ names } = readDirNames(payloadDir, 2));
  } catch {
    throw new FmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
  }
  if (names.length !== 1) throw new FmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
  const meta = readMeta(itemDir);
  return {
    trashId,
    itemDir,
    payloadName: names[0],
    payloadAbs: path.join(payloadDir, names[0]),
    meta,
  };
}

/** After a restore moved the payload out: drop the empty item. */
export function finishRestore(item) {
  removeItemShell(item.itemDir);
}

/**
 * Permanently delete one Trash item: the payload first, meta.json and the
 * item folder last, so a purge that stops partway (a file in use, the entry
 * cap) leaves an item that is still listed and can be purged again.
 */
export async function purgeTrashItem(rootReal, trashId, { onProgress, maxEntries = Infinity } = {}) {
  if (typeof trashId !== "string" || !TRASH_ID_RE.test(trashId)) {
    throw new FmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
  }
  const itemDir = path.join(trashDirOf(rootReal), trashId);
  try {
    const st = lstatBig(itemDir);
    if (!st.isDirectory()) throw new Error("not a folder");
  } catch {
    throw new FmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
  }
  const payloadDir = path.join(itemDir, PAYLOAD_DIR);
  let done = 0;
  let hasPayload = true;
  try {
    lstatBig(payloadDir);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    hasPayload = false;
  }
  if (hasPayload) done = await deleteTree(payloadDir, { onProgress, maxEntries });
  const report = onProgress ? (n) => onProgress(done + n) : undefined;
  return done + (await deleteTree(itemDir, { onProgress: report, maxEntries: Math.max(0, maxEntries - done) + 2 }));
}

/** Trash ids older than the retention period. */
export function expiredTrashIds(rootReal, now = Date.now()) {
  const cutoff = now - FM_LIMITS.TRASH_RETENTION_DAYS * DAY_MS;
  return listItemIds(rootReal).filter((id) => {
    const time = trashIdTime(id);
    return Number.isFinite(time) && time < cutoff;
  });
}

/**
 * Keep at most TRASH_VERSIONS_PER_FILE "edited" versions of one file; the
 * oldest go first. Returns the ids removed.
 */
export async function pruneEditedVersions(rootReal, originalPath) {
  const versions = listTrash(rootReal).filter(
    (item) => item.reason === "edited" && item.originalPath === originalPath,
  );
  // listTrash() is newest first.
  const excess = versions.slice(FM_LIMITS.TRASH_VERSIONS_PER_FILE);
  const removed = [];
  for (const item of excess) {
    try {
      await purgeTrashItem(rootReal, item.trashId);
      removed.push(item.trashId);
    } catch {
      /* the janitor gets it later */
    }
  }
  return removed;
}
