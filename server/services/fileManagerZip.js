// "Download as .zip" for Server Files (spec §A6.4). Two phases:
//   1. planZip(): an lstat walk that never follows links, checked against
//      the entry, byte, depth and time limits BEFORE the first byte is sent,
//      so an oversized selection is a clean JSON 413 instead of a cut-off
//      download.
//   2. streamZip(): each file is re-resolved and opened through the
//      backend's checked fd path, then streamed through StreamingZipWriter
//      straight into the response. Links, special files, protected areas and
//      unreadable files are skipped and listed in _skipped.txt; .ini files
//      and the panel's backups of them are masked like every other way out.
import path from "path";
import { ErrorCode } from "../utils/errorCodes.js";
import { StreamingZipWriter } from "../utils/streamingZip.js";
import { createLogger } from "../utils/logger.js";
import { FM_LIMITS, FmError } from "./fileManagerContract.js";
import { isSecretBearingName, maskIniBuffer } from "./fileManagerTextCodec.js";
import { ensurePanelTempDir } from "./fileManagerLocalFs.js";

const log = createLogger("FileManager:Zip");

const PRECHECK_MAX_MS = 5000;
const INI_MASK_MAX_BYTES = 16 * 1024 * 1024;

let activeGlobal = 0;
/** @type {Map<string, number>} */
const activePerUser = new Map();

/** Take a zip slot (2 across the panel, 1 per user) or FM_TOO_MANY_TRANSFERS. */
export function acquireZipSlot(userId) {
  const key = String(userId ?? "-");
  const mine = activePerUser.get(key) || 0;
  if (activeGlobal >= FM_LIMITS.ZIP_SLOTS_GLOBAL || mine >= FM_LIMITS.ZIP_SLOTS_PER_USER) {
    throw new FmError(ErrorCode.FM_TOO_MANY_TRANSFERS);
  }
  activeGlobal++;
  activePerUser.set(key, mine + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeGlobal--;
    const left = (activePerUser.get(key) || 1) - 1;
    if (left <= 0) activePerUser.delete(key);
    else activePerUser.set(key, left);
  };
}

export function _resetZipSlotsForTests() {
  activeGlobal = 0;
  activePerUser.clear();
}

function tooLarge(reason, limit) {
  return new FmError(ErrorCode.FM_ZIP_TOO_LARGE, undefined, { reason, limit });
}

function stampForName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** `<serverName>-<root>-<last segment or root>-<YYYYMMDD-HHmm>.zip`, [A-Za-z0-9._-] only. */
export function zipFileName(serverName, rootId, items, date = new Date()) {
  const last = items.length === 1 && items[0].rel ? items[0].rel.split("/").pop() : rootId;
  const raw = `${serverName || "server"}-${rootId}-${last}-${stampForName(date)}.zip`;
  return raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
}

function uniqueTopName(name, used) {
  let candidate = name || "root";
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const ext = path.extname(name);
    candidate = `${ext ? name.slice(0, -ext.length) : name} (${n})${ext}`;
    n++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Walk the selection and check the limits.
 * @param {object} opts
 * @param {object} opts.backend
 * @param {object[]} opts.items  resolved top-level selections (not protected themselves)
 * @param {(realRel: string, stat: object) => ({ level: string }|null)} opts.classify
 * @returns {Promise<{ dirs: object[], files: object[], skipped: object[], entries: number, bytes: number }>}
 */
export async function planZip({ backend, items, classify, now = () => Date.now() }) {
  const kind = backend.kind === "sftp" ? "sftp" : "local";
  const maxEntries = FM_LIMITS.ZIP_MAX_ENTRIES[kind];
  const maxBytes = FM_LIMITS.ZIP_MAX_BYTES[kind];
  const maxDepth = FM_LIMITS.ZIP_MAX_DEPTH;
  const started = now();
  const plan = { dirs: [], files: [], skipped: [], entries: 0, bytes: 0 };
  const used = new Set();
  const excluded = (realRel, stat) => {
    const protection = realRel === null ? null : classify(realRel, stat);
    return protection && (protection.level === "sealed" || protection.level === "listOnly");
  };
  const count = (size) => {
    plan.entries++;
    plan.bytes += size;
    if (plan.entries > maxEntries) throw tooLarge("entries", maxEntries);
    if (plan.bytes > maxBytes) throw tooLarge("bytes", maxBytes);
    if (now() - started > PRECHECK_MAX_MS) throw tooLarge("time", PRECHECK_MAX_MS);
  };

  for (const item of items) {
    const top = uniqueTopName(item.name || path.basename(item.rel) || item.rootId, used);
    const type = item.stat?.type;
    if (type === "file") {
      count(item.stat.size);
      plan.files.push({ rel: item.rel, realRel: item.realRel, name: top, size: item.stat.size, mtimeMs: item.stat.mtimeMs, dev: item.stat.dev, ino: item.stat.ino });
      continue;
    }
    if (type !== "dir") {
      plan.skipped.push({ name: top, reason: type === "link" ? "link" : "special file" });
      continue;
    }
    count(0);
    plan.dirs.push({ name: top, mtimeMs: item.stat.mtimeMs });
    const base = item.rel;
    const walker = backend.walk(item, {
      maxEntries: maxEntries + 1,
      maxDepth: maxDepth + 1,
      maxMs: PRECHECK_MAX_MS + 1000,
      prune: (entry) => excluded(entry.realRel, entry),
    });
    for await (const entry of walker) {
      if (entry.depth > maxDepth) throw tooLarge("depth", maxDepth);
      const sub = base ? entry.rel.slice(base.length + 1) : entry.rel;
      const name = `${top}/${sub}`;
      if (excluded(entry.realRel, entry)) {
        plan.skipped.push({ name, reason: "protected" });
        continue;
      }
      if (entry.type === "link") {
        plan.skipped.push({ name, reason: "link" });
        continue;
      }
      if (entry.type === "other") {
        plan.skipped.push({ name, reason: "special file" });
        continue;
      }
      if (entry.type === "dir") {
        count(0);
        plan.dirs.push({ name, mtimeMs: entry.mtimeMs });
      } else {
        count(entry.size);
        plan.files.push({ rel: entry.rel, realRel: entry.realRel, name, size: entry.size, mtimeMs: entry.mtimeMs, dev: entry.dev, ino: entry.ino });
      }
    }
    if (now() - started > PRECHECK_MAX_MS) throw tooLarge("time", PRECHECK_MAX_MS);
  }
  return plan;
}

function sameInode(a, b) {
  if (a.dev === null || a.dev === undefined || b.dev === null || b.dev === undefined) return true;
  return String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
}

/**
 * Stream a planned zip into `res`. Headers must already be set. Resolves
 * with { bytes, entries, skipped } when finished; on a client abort or the
 * time cap the writer is aborted and the socket destroyed.
 */
export async function streamZip({ res, backend, root, plan }) {
  const writer = new StreamingZipWriter(null, { outputStream: res, tempDir: ensurePanelTempDir() });
  let aborted = false;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    writer.abort().catch(() => {});
    res.destroy?.();
  };
  const onClose = () => {
    if (!res.writableFinished) abort();
  };
  res.on("close", onClose);
  const timer = setTimeout(abort, FM_LIMITS.ZIP_TIME_LIMIT_MS);
  timer.unref?.();
  const skipped = [...plan.skipped];
  let bytes = 0;
  try {
    await writer.open();
    for (const dir of plan.dirs) {
      if (aborted) break;
      await writer.addDirectory(dir.name, new Date(dir.mtimeMs || Date.now()));
    }
    for (const file of plan.files) {
      if (aborted) break;
      let resolved;
      try {
        resolved = await backend.resolve(root, file.rel ? file.rel.split("/") : [], "read");
      } catch {
        skipped.push({ name: file.name, reason: "unreadable" });
        continue;
      }
      if (!resolved.stat || resolved.stat.type !== "file" || !sameInode(resolved.stat, file)) {
        skipped.push({ name: file.name, reason: "changed" });
        continue;
      }
      try {
        if (isSecretBearingName(file.name) || isSecretBearingName(file.realRel)) {
          const { buffer, truncated } = await backend.readBytes(resolved, { maxBytes: INI_MASK_MAX_BYTES });
          if (truncated) {
            skipped.push({ name: file.name, reason: "too large to mask" });
            continue;
          }
          const masked = maskIniBuffer(buffer).buffer;
          await writer.addBuffer(masked, file.name);
          bytes += masked.length;
        } else {
          const handle = await backend.openReadStream(resolved);
          try {
            await writer.addStream(handle.stream, file.name, new Date(file.mtimeMs || Date.now()));
            bytes += handle.size;
          } finally {
            await handle.close().catch(() => {});
          }
        }
      } catch (err) {
        if (aborted) break;
        // A failure before the entry's header went out is a skip; one in the
        // middle of an entry leaves a broken archive, so stop there.
        if (err instanceof FmError) {
          skipped.push({ name: file.name, reason: "unreadable" });
          continue;
        }
        throw err;
      }
    }
    if (!aborted && skipped.length) {
      const text = skipped.map((s) => `${s.name}: ${s.reason}`).join("\n") + "\n";
      await writer.addBuffer(Buffer.from(text, "utf8"), "_skipped.txt");
    }
    if (!aborted) await writer.finalize();
    return { bytes, entries: plan.files.length + plan.dirs.length, skipped: skipped.length, aborted };
  } catch (err) {
    log.warn(`Zip stream stopped: ${err?.code || err?.name || "error"}`);
    abort();
    return { bytes, entries: 0, skipped: skipped.length, aborted: true };
  } finally {
    clearTimeout(timer);
    res.off?.("close", onClose);
  }
}
