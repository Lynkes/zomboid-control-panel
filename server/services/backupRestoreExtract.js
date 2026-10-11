import fs from "fs";
import path from "path";
import { createReadStream, createWriteStream } from "fs";
import { randomUUID } from "crypto";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Backup");

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
 * @param {object} unzip the `unzipper` module
 */
export function extractArchiveToStaging(unzip, backupPath, stagingPath) {
  const resolvedParent = path.resolve(stagingPath) + path.sep;

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
          const entryPath = path.join(stagingPath, entry.path);
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
                entry.unpipe(writeStream);
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
            entry.on("error", abort);
            entry.pipe(writeStream);
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
