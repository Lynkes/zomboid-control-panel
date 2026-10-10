import fs from "fs";
import path from "path";

// Walks a folder tree (iteratively, one directory handle at a time) yielding
// every entry under rootDir: files, directories (before their contents) and
// symbolic links, which are reported but never followed.
export async function* walkDirectory(rootDir) {
  const pending = [{ dirPath: rootDir, archivePath: "", isRoot: true }];

  while (pending.length > 0) {
    const current = pending.pop();
    let directory;
    try {
      directory = await fs.promises.opendir(current.dirPath);
    } catch (error) {
      if (current.isRoot) throw error;
      continue;
    }

    try {
      let entry;
      while ((entry = await directory.read()) !== null) {
        const archivePath = current.archivePath
          ? `${current.archivePath}/${entry.name}`
          : entry.name;
        const fullPath = path.join(current.dirPath, entry.name);

        if (entry.isSymbolicLink()) {
          // Deliberately not followed (zip-slip in reverse -- a symlink
          // inside the save tree pointing outside it must never leak
          // arbitrary filesystem content into the archive), but that
          // decision has to be VISIBLE the same way a vanished file already
          // is via waitForArchiveEntry's ENOENT handling (backupService.js) -- silently
          // dropping it here meant a pre-restore/pre-wipe backup could be
          // incomplete with skippedFiles staying empty, defeating the
          // "any skip is a failure" policy those call sites rely on.
          yield { entry, fullPath, archivePath, isSymlink: true };
          continue;
        }

        if (entry.isDirectory()) {
          pending.push({
            dirPath: fullPath,
            archivePath,
            isRoot: false,
          });
        }

        yield { entry, fullPath, archivePath };
      }
    } finally {
      await directory.close().catch(() => {});
    }
  }
}

// How many files a folder holds (symbolic links count, as they do for the
// archive's own file total) and how many bytes those files add up to, for the
// backup's progress total and its free-space check. Sizes come from lstat
// with a bounded number in flight, so a world with tens of thousands of small
// files costs about one extra pass of stat calls, not one round trip each.
// A file that vanishes between the walk and its lstat adds nothing.
const MEASURE_CONCURRENCY = 64;

export async function measureFolder(rootDir) {
  let files = 0;
  let bytes = 0;
  const inFlight = new Set();
  const track = (promise) => {
    const tracked = promise.then(
      (stat) => {
        bytes += stat.size;
      },
      () => {},
    );
    inFlight.add(tracked);
    tracked.then(() => inFlight.delete(tracked));
  };
  for await (const { entry, fullPath, isSymlink } of walkDirectory(rootDir)) {
    if (entry.isDirectory()) continue;
    files++;
    if (isSymlink) continue;
    track(fs.promises.lstat(fullPath));
    if (inFlight.size >= MEASURE_CONCURRENCY) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);
  return { files, bytes };
}
