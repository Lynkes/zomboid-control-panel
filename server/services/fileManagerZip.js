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
import { ensurePanelTempDir, lstatBig, readDirNames, unlinkPath } from "./fileManagerLocalFs.js";

const log = createLogger("FileManager:Zip");

// The pre-check's time budget. Over SFTP every folder costs a few round
// trips (open, read, read to the end, close), so 5 s covers only a few dozen
// folders there; its own budget matches its smaller entry cap instead.
const PRECHECK_MAX_MS = Object.freeze({ local: 5000, sftp: 30000 });
const INI_MASK_MAX_BYTES = 16 * 1024 * 1024;

// A zip whose client stops reading (a laptop gone to sleep, a half-open
// connection) holds a zip slot (2 across the panel, 1 per user): cut it off
// after this long with bytes waiting for the client and none delivered, the
// idle time a single download gets.
let zipIdleMs = FM_LIMITS.UPLOAD_IDLE_MS;

export function _setZipIdleMsForTests(ms) {
  zipIdleMs = Number.isFinite(ms) && ms > 0 ? ms : FM_LIMITS.UPLOAD_IDLE_MS;
}

// StreamingZipWriter's central-directory temp files (in file-manager-tmp).
const ZIP_TEMP_RE = /^\.central-\d+-\d+-[0-9a-z]+\.tmp$/;
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;
// Those of the zips running now.
const activeZipTemps = new Set();

/**
 * Remove central-directory temp files no zip is writing: those left by an
 * earlier run of the panel (a crash, a kill) and any older than the zip time
 * cap. Called by the file-manager janitor.
 * @returns {number} files removed
 */
export function sweepStaleZipTemps(now = Date.now()) {
  let dir;
  let names;
  try {
    dir = ensurePanelTempDir();
    ({ names } = readDirNames(dir, 10000));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!ZIP_TEMP_RE.test(name)) continue;
    const abs = path.join(dir, name);
    if (activeZipTemps.has(abs)) continue;
    try {
      const st = lstatBig(abs);
      if (!st.isFile()) continue;
      const mtimeMs = Number(st.mtimeMs);
      if (mtimeMs >= PROCESS_STARTED_AT && now - mtimeMs <= FM_LIMITS.ZIP_TIME_LIMIT_MS + 60 * 1000) continue;
      unlinkPath(abs);
      removed++;
    } catch {
      /* gone already, or still open elsewhere: the next pass */
    }
  }
  return removed;
}

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
  const maxMs = PRECHECK_MAX_MS[kind];
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
    if (now() - started > maxMs) throw tooLarge("time", maxMs);
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
    const nameOf = (rel) => `${top}/${base ? rel.slice(base.length + 1) : rel}`;
    const walker = backend.walk(item, {
      maxEntries: maxEntries + 1,
      maxDepth: maxDepth + 1,
      maxMs: maxMs + 1000,
      prune: (entry) => excluded(entry.realRel, entry),
      // A folder that couldn't be listed (or an entry that couldn't be looked
      // at) is missing from the archive: _skipped.txt says so, so a zip taken
      // as a backup doesn't look complete when it isn't.
      onUnreadable: (entry) => {
        if (entry.rel === base) plan.skipped.push({ name: `${top}/`, reason: "unreadable folder" });
        else plan.skipped.push({ name: `${nameOf(entry.rel)}${entry.folder ? "/" : ""}`, reason: entry.folder ? "unreadable folder" : "unreadable" });
      },
    });
    for await (const entry of walker) {
      if (entry.depth > maxDepth) throw tooLarge("depth", maxDepth);
      const name = nameOf(entry.rel);
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
      if (entry.unrepresentable) {
        plan.skipped.push({ name, reason: "name isn't valid Unicode" });
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
    if (now() - started > maxMs) throw tooLarge("time", maxMs);
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
 * time cap the writer is aborted (which stops the entry being read) and the
 * socket destroyed. `release` (the zip slot) is called exactly once: at
 * that moment, or once the last byte is written and before the response
 * ends -- not only when the caller's finally runs, so neither a stopped zip
 * nor a finished one keeps a slot past what its client can see.
 */
export async function streamZip({ res, backend, root, plan, release = () => {} }) {
  const writer = new StreamingZipWriter(null, { outputStream: res, tempDir: ensurePanelTempDir() });
  activeZipTemps.add(writer.centralPath);
  let released = false;
  const releaseSlot = () => {
    if (released) return;
    released = true;
    release();
  };
  let aborted = false;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    writer.abort().catch(() => {});
    res.destroy?.();
    releaseSlot();
  };
  const onClose = () => {
    if (!res.writableFinished) abort();
  };
  res.on("close", onClose);
  const timer = setTimeout(abort, FM_LIMITS.ZIP_TIME_LIMIT_MS);
  timer.unref?.();
  // Idle watchdog: while bytes sit in the response waiting for the client
  // (it isn't reading) and nothing more has gone out for zipIdleMs, stop. A
  // slow source (a remote file, a big deflate) doesn't count: nothing waits
  // in the response then, and an SFTP transfer has its own idle limit.
  let lastOffset = -1;
  let lastProgressAt = Date.now();
  const watchdog = setInterval(() => {
    const offset = writer.offset;
    if (offset !== lastOffset || !(res.writableLength > 0)) {
      lastOffset = offset;
      lastProgressAt = Date.now();
      return;
    }
    if (Date.now() - lastProgressAt >= zipIdleMs) abort();
  }, Math.max(20, Math.min(1000, Math.floor(zipIdleMs / 4))));
  watchdog.unref?.();
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
    // The slot goes back as soon as the last byte is written, before the
    // response ends: a client that asks for its next zip the moment this
    // one arrives must find it free. Releasing after res.end() (the route's
    // finally, behind the temp file's removal) lost that race now and then:
    // a 429 for a zip that had finished (PR #183). An abort after this point
    // (the client gone before the end) doesn't release it again.
    if (!aborted) await writer.finalize({ onWritten: releaseSlot });
    return { bytes, entries: plan.files.length + plan.dirs.length, skipped: skipped.length, aborted };
  } catch (err) {
    log.warn(`Zip stream stopped: ${err?.code || err?.name || "error"}`);
    abort();
    return { bytes, entries: 0, skipped: skipped.length, aborted: true };
  } finally {
    clearTimeout(timer);
    clearInterval(watchdog);
    res.off?.("close", onClose);
    activeZipTemps.delete(writer.centralPath);
  }
}
