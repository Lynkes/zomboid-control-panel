import fs from "fs";
import path from "path";
import { createReadStream, createWriteStream } from "fs";
import { randomUUID } from "crypto";
import { Transform } from "stream";
import { createLogger } from "../utils/logger.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { insufficientSpaceError } from "./backupDiskSpace.js";

const log = createLogger("Backup");

// How far past its recorded size an entry, and past the central directory's
// sum the whole extraction, may grow before the archive counts as damaged or
// forged (a real archive inflates to exactly what it records).
const ENTRY_SIZE_SLACK_BYTES = 64 * 1024;
const TOTAL_SIZE_SLACK_BYTES = 1024 * 1024;
// What the extraction leaves free on the staging volume: 128 MB, or a tenth
// of the free space on a nearly full disk (where the pre-restore space check
// already approved the restore; it stays close to that figure).
const FREE_SPACE_MARGIN_BYTES = 128 * 1024 * 1024;
const FREE_SPACE_MARGIN_FRACTION = 10;

function sizeMismatchError() {
  const error = new Error(
    "The backup archive holds more data than it records (damaged or forged) -- extraction stopped. Live save left untouched.",
  );
  error.errorCode = ErrorCode.BACKUP_ARCHIVE_SIZE_MISMATCH;
  return error;
}

// What a restore extracts into before it swaps the world in: a sibling of the
// world folders in Saves/Multiplayer, named .restore-staging-<uuid> (<ms>-<pid>
// before 1.4.6). Also the pattern zomboidDataPath.js lets through as one of the
// panel's own entries.
const STAGING_DIR_NAME = /^\.restore-staging-[0-9a-f-]+$/;

// How long a failed extraction waits for the entry write streams it destroyed
// to report 'close' before it reports the failure anyway.
const FAILED_EXTRACTION_CLOSE_WAIT_MS = 5000;

// Create the restore staging directory next to the live save (security
// audit M4). The name is random and mkdir is non-recursive (EEXIST = try a
// new name), and the created directory is verified to be a real directory
// that resolves inside the saves parent -- the old Date.now()-pid name plus
// recursive mkdir followed a pre-planted symlink, while the zip-slip guard
// in restoreBackup() is lexical and stayed inside the symlink path.
// makeName is injectable for tests only.
export function createRestoreStagingDir(savesParentPath, makeName = randomUUID) {
  let stagingPath;
  for (let attempt = 0; ; attempt++) {
    stagingPath = path.join(savesParentPath, `.restore-staging-${makeName()}`);
    try {
      fs.mkdirSync(stagingPath, { recursive: false });
      break;
    } catch (error) {
      if (error.code === "EEXIST" && attempt < 5) continue;
      throw error;
    }
  }
  try {
    if (!fs.lstatSync(stagingPath).isDirectory()) {
      throw new Error("Cannot restore: staging path is not a directory");
    }
    const realSavesParent = fs.realpathSync(savesParentPath);
    if (fs.realpathSync(stagingPath) !== path.join(realSavesParent, path.basename(stagingPath))) {
      throw new Error("Cannot restore: staging directory resolves outside the saves folder");
    }
  } catch (error) {
    // The caller never receives this path, so it cannot clean it up. Remove
    // only the entry itself: unlink a link, rmdir an (empty) directory --
    // never anything recursive that could follow it.
    try {
      if (fs.lstatSync(stagingPath).isSymbolicLink()) fs.unlinkSync(stagingPath);
      else fs.rmdirSync(stagingPath);
    } catch {
      /* best effort */
    }
    throw error;
  }
  return stagingPath;
}

/**
 * Remove restore staging folders a restore left behind (it failed hard, or the
 * panel was stopped mid-extraction). Only ever the panel's own
 * `.restore-staging-*` folders in `savesParentPath`; a link of that name is
 * unlinked, never followed. The caller guarantees no restore is running (there
 * is one at a time per panel).
 *
 * Deliberately NOT swept: `<world>.replaced-<ms>`. That is the previous world,
 * and when a restore's rollback failed it is the only copy the operator has;
 * the name does not say whether the restore that left it finished, so it is
 * never removed automatically.
 *
 * @returns {{removed: string[], failed: string[]}}
 */
export function sweepStaleRestoreStaging(savesParentPath) {
  const result = { removed: [], failed: [] };
  let names;
  try {
    names = fs.readdirSync(savesParentPath);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!STAGING_DIR_NAME.test(name)) continue;
    const entryPath = path.join(savesParentPath, name);
    try {
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(entryPath);
      } else if (stat.isDirectory()) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      } else {
        continue;
      }
      result.removed.push(name);
      log.info(`Removed leftover restore staging folder: ${name}`);
    } catch (error) {
      result.failed.push(name);
      log.warn(`Could not remove leftover restore staging folder ${name}: ${error.message}`);
    }
  }
  return result;
}

/**
 * An entry's path with "/" separators. Windows PowerShell 5.1's
 * Compress-Archive writes "servertest\map_meta.bin", which on Linux is one
 * file with a backslash in its name, not a folder. Normalised BEFORE any
 * containment check, so "..\..\x" is caught as the traversal it is.
 */
export function normalizeZipEntryPath(entryPath) {
  return String(entryPath).replace(/\\/g, "/");
}

/**
 * Stream-extract a backup archive into `stagingPath` with zip-slip protection.
 *
 * It resolves once the whole archive has been parsed AND every entry's write
 * stream has closed (the parser reports 'close' while entry files are still
 * flushing, and renaming a directory that still has open handles fails with
 * EPERM on Windows).
 *
 * On the FIRST error (a write failing with ENOSPC/EACCES/path too long, a read
 * error, a corrupt archive) it stops: the source and the parser are destroyed,
 * the entry being written is closed, and any entry the parser still emits is
 * drained without touching the disk. It rejects only after the open write
 * streams have closed, so the caller can remove `stagingPath` and nothing
 * recreates it. (It used to reject at once and leave the parser running: the
 * caller removed the staging folder, then the rest of the archive re-created it
 * and was written out, 243 MB in one probe, with nothing to sweep it.)
 *
 * The bytes written are counted, per entry and in total, because the sizes an
 * archive records are whatever it says (a few KB of upload can inflate to
 * GBs): an entry that grows past the size its local header or the central
 * directory records (plus a little slack) stops the extraction as a damaged
 * archive, and so does a total past the central directory's sum; the total
 * also stops short of the free space measured before the extraction, minus a
 * margin, so the extraction never fills the disk.
 *
 * @param {object} unzip the `unzipper` module
 * @param {{ declaredSizes?: Map<string, number>|null, declaredTotal?: number|null, freeBytes?: number|null }} [limits]
 *   declaredSizes: the central directory's uncompressed size per entry
 *   (keyed by normalizeZipEntryPath()), declaredTotal its sum over files,
 *   freeBytes the free space on the staging volume; null/absent = unknown.
 */
export function extractArchiveToStaging(unzip, backupPath, stagingPath, limits = {}) {
  const resolvedParent = path.resolve(stagingPath) + path.sep;
  const declaredSizes = limits.declaredSizes instanceof Map ? limits.declaredSizes : null;
  const declaredTotal = Number.isFinite(limits.declaredTotal) ? limits.declaredTotal : null;
  const freeBytes = Number.isFinite(limits.freeBytes) ? limits.freeBytes : null;
  const declaredCap = declaredTotal !== null ? declaredTotal + TOTAL_SIZE_SLACK_BYTES : null;
  const freeMargin =
    freeBytes !== null ? Math.min(FREE_SPACE_MARGIN_BYTES, Math.floor(freeBytes / FREE_SPACE_MARGIN_FRACTION)) : 0;
  const freeCap = freeBytes !== null ? Math.max(0, freeBytes - freeMargin) : null;
  let written = 0;

  // The size this entry may reach: the smaller of the local header's figure
  // (when the header has one: not with a data descriptor) and the central
  // directory's, plus slack. null when neither records one.
  const entryCapOf = (entry, entryName) => {
    const recorded = [];
    const vars = entry.vars;
    if (vars && (!(vars.flags & 0x08) || vars.compressedSize > 0) && Number.isFinite(vars.uncompressedSize)) {
      recorded.push(vars.uncompressedSize);
    }
    if (declaredSizes?.has(entryName)) recorded.push(declaredSizes.get(entryName));
    return recorded.length ? Math.min(...recorded) + ENTRY_SIZE_SLACK_BYTES : null;
  };

  return new Promise((resolve, reject) => {
    let failure = null;
    let settled = false;
    let failTimer = null;
    // The parser emits 'close' as soon as it has read the archive, which
    // can happen while entry files are still flushing.
    let pendingWrites = 0;
    let parseClosed = false;
    const openWrites = new Set();

    const settle = (err) => {
      if (settled) return;
      settled = true;
      if (failTimer) clearTimeout(failTimer);
      if (err) reject(err);
      else resolve();
    };
    const settleIfComplete = () => {
      if (settled || pendingWrites > 0) return;
      if (failure) settle(failure);
      else if (parseClosed) settle();
    };

    const drain = (entry) => {
      try {
        entry.autodrain();
      } catch {
        /* ignore */
      }
    };

    const readStream = createReadStream(backupPath);
    const parser = unzip.Parse();

    const abort = (err) => {
      if (failure) return;
      failure = err instanceof Error ? err : new Error(String(err));
      try {
        readStream.unpipe(parser);
      } catch {
        /* ignore */
      }
      readStream.destroy();
      parser.destroy();
      for (const writeStream of openWrites) writeStream.destroy();
      failTimer = setTimeout(() => settle(failure), FAILED_EXTRACTION_CLOSE_WAIT_MS);
      failTimer.unref?.();
      settleIfComplete();
    };

    readStream.on("error", abort);

    readStream
      .pipe(parser)
      .on("entry", (entry) => {
        // Entries the parser had already buffered when it was stopped.
        if (failure) {
          drain(entry);
          return;
        }
        try {
          const entryName = normalizeZipEntryPath(entry.path);
          const entryPath = path.join(stagingPath, entryName);
          const resolvedEntry = path.resolve(entryPath);

          // Block zip-slip: entry must resolve inside the target directory
          if (!resolvedEntry.startsWith(resolvedParent)) {
            log.error(`Zip slip attempt blocked: ${entry.path}`);
            entry.autodrain();
            return;
          }

          if (entry.type !== "Directory" && entry.type !== "File") {
            log.warn(`Skipping unsupported backup entry type ${entry.type}: ${entry.path}`);
            entry.autodrain();
          } else if (entry.type === "Directory") {
            fs.mkdirSync(resolvedEntry, { recursive: true });
            entry.autodrain();
          } else {
            // Ensure parent directory exists
            fs.mkdirSync(path.dirname(resolvedEntry), { recursive: true });
            const writeStream = createWriteStream(resolvedEntry);
            pendingWrites++;
            openWrites.add(writeStream);
            // Per-entry write failures (ENOSPC, EACCES, path too long on
            // Windows) surface as 'error' on the WriteStream and are NOT
            // forwarded by pipe(). Without this listener the event is
            // unhandled and crashes the process. A destroyed stream still
            // reports 'close', which is what the count below waits for.
            writeStream.on("error", (err) => {
              try {
                entry.unpipe();
              } catch {
                /* ignore */
              }
              drain(entry);
              abort(err);
            });
            writeStream.on("close", () => {
              openWrites.delete(writeStream);
              pendingWrites--;
              settleIfComplete();
            });
            const entryCap = entryCapOf(entry, entryName);
            let entryBytes = 0;
            const counter = new Transform({
              transform(chunk, _encoding, callback) {
                entryBytes += chunk.length;
                written += chunk.length;
                if ((entryCap !== null && entryBytes > entryCap) || (declaredCap !== null && written > declaredCap)) {
                  log.error(`Restore stopped: ${JSON.stringify(entry.path)} holds more data than the archive records`);
                  callback(sizeMismatchError());
                } else if (freeCap !== null && written > freeCap) {
                  log.error(`Restore stopped: the extraction would leave less than ${freeMargin} bytes free`);
                  callback(insufficientSpaceError(Math.max(declaredTotal ?? 0, written), freeBytes));
                } else {
                  callback(null, chunk);
                }
              },
            });
            counter.on("error", (err) => {
              try {
                entry.unpipe();
              } catch {
                /* ignore */
              }
              drain(entry);
              abort(err);
            });
            entry.on("error", abort);
            entry.pipe(counter).pipe(writeStream);
          }
        } catch (err) {
          drain(entry);
          abort(err);
        }
      })
      .on("close", () => {
        parseClosed = true;
        settleIfComplete();
      })
      .on("error", abort);
  });
}
