// Every filesystem call the Server Files file manager makes on a path that
// came (even partly) from a request lives in this module, and nowhere else
// (server/tests/fileManagerFsConfinement.test.js enforces it; the Trash
// module's own meta.json and the janitor are the only other fs users).
//
// The paths reaching these helpers are built by fileManagerLocalBackend.js's
// resolve(): a root the service derived from the server profile (never
// client input), joined with segments that passed validateSegments() and
// realpath-checked for containment one component at a time. The helpers
// themselves stay dumb on purpose: one call each, never following a link
// where the caller asked not to, and never deciding policy.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { getDataPaths } from "../utils/paths.js";

const IS_WIN = process.platform === "win32";

// Open a file for reading without following a final symlink (POSIX) and
// without blocking on a FIFO swapped in at that name. Windows has neither
// flag; there, the (dev, ino) check after fstat catches a swap.
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
// Create a panel temp file: never an existing file, never through a link.
const CREATE_EXCL_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);

// Windows reports a file another program holds open (usually the running
// server, an antivirus scan or the indexer) as EBUSY or EPERM. Retried
// briefly, like utils/fileWriteQueue.js's writeFileAtomic.
const TRANSIENT_CODES = new Set(["EBUSY", "EPERM"]);
const RETRY_DELAYS_MS = [25, 50, 100];

function sleepSync(ms) {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

function withWinRetry(fn) {
  let attempt = 0;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      if (!IS_WIN || !TRANSIENT_CODES.has(err?.code) || attempt >= RETRY_DELAYS_MS.length) throw err;
      sleepSync(RETRY_DELAYS_MS[attempt]);
      attempt++;
    }
  }
}

export function realpathNative(p) {
  // codeql[js/path-injection] target is a Resolved from fileManagerLocalBackend.resolve(): the root is server-derived from the profile (never client input), segments passed validateSegments() (no .., separators, drive letters, ADS, device names), realpath.native containment was verified per component, and protected-area and inode checks ran -- see ARCHITECTURE.md "File Manager".
  return fs.realpathSync.native(p);
}

export function lstatBig(p) {
  // codeql[js/path-injection] target is a Resolved from fileManagerLocalBackend.resolve(): the root is server-derived from the profile (never client input), segments passed validateSegments() (no .., separators, drive letters, ADS, device names), realpath.native containment was verified per component, and protected-area and inode checks ran -- see ARCHITECTURE.md "File Manager".
  return fs.lstatSync(p, { bigint: true });
}

export function statBig(p) {
  // codeql[js/path-injection] target is a Resolved from fileManagerLocalBackend.resolve(): the root is server-derived from the profile (never client input), segments passed validateSegments() (no .., separators, drive letters, ADS, device names), realpath.native containment was verified per component, and protected-area and inode checks ran -- see ARCHITECTURE.md "File Manager".
  return fs.statSync(p, { bigint: true });
}

// Throws when the panel's account can't write the folder (EROFS for a
// read-only mount, EACCES/EPERM otherwise).
export function assertWritable(p) {
  // codeql[js/path-injection] target is a Resolved from fileManagerLocalBackend.resolve(): the root is server-derived from the profile (never client input), segments passed validateSegments() (no .., separators, drive letters, ADS, device names), realpath.native containment was verified per component, and protected-area and inode checks ran -- see ARCHITECTURE.md "File Manager".
  fs.accessSync(p, fs.constants.W_OK);
}

// Entry names of a folder, read incrementally so a huge folder stops at
// `max` names instead of being read into memory whole.
export function readDirNames(abs, max = Infinity) {
  // codeql[js/path-injection] target is a Resolved from fileManagerLocalBackend.resolve(): the root is server-derived from the profile (never client input), segments passed validateSegments() (no .., separators, drive letters, ADS, device names), realpath.native containment was verified per component, and protected-area and inode checks ran -- see ARCHITECTURE.md "File Manager".
  const dir = fs.opendirSync(abs, { bufferSize: 256 });
  const names = [];
  let truncated = false;
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      if (names.length >= max) {
        truncated = true;
        break;
      }
      names.push(entry.name);
    }
  } finally {
    dir.closeSync();
  }
  return { names, truncated };
}

export function openForRead(abs) {
  // codeql[js/path-injection, js/file-system-race] target is a Resolved from fileManagerLocalBackend.resolve(): the root is server-derived from the profile (never client input), segments passed validateSegments() (no .., separators, drive letters, ADS, device names), realpath.native containment was verified per component, and protected-area and inode checks ran -- see ARCHITECTURE.md "File Manager". Opened O_NOFOLLOW|O_NONBLOCK and the caller compares fstat's (dev, ino) with the resolved one before reading a byte.
  return fs.openSync(abs, READ_FLAGS);
}

export function fstatBig(fd) {
  return fs.fstatSync(fd, { bigint: true });
}

export function readFd(fd, buffer, offset, length, position) {
  return fs.readSync(fd, buffer, offset, length, position);
}

export function closeFd(fd) {
  try {
    fs.closeSync(fd);
  } catch {
    /* already closed */
  }
}

// A read stream over an fd this module opened. autoClose closes it at the
// end or on destroy().
export function createFdReadStream(fd, { start, end } = {}) {
  return fs.createReadStream(null, { fd, start, end, autoClose: true });
}

// A panel temp file in `dirAbs`, named `.<hint>.<pid>.<hex8><suffix>`:
// created exclusively (never an existing file), never through a link, mode
// 0600 until the caller sets the final mode on the fd.
export function createTempFile(dirAbs, nameHint, suffix) {
  const hint = String(nameHint).slice(0, 80);
  const tempName = `.${hint}.${process.pid}.${crypto.randomBytes(4).toString("hex")}${suffix}`;
  const tempPath = path.join(dirAbs, tempName);
  // codeql[js/path-injection, js/insecure-temporary-file, js/http-to-file-access] target is a Resolved from fileManagerLocalBackend.resolve(): the root is server-derived from the profile (never client input), segments passed validateSegments() (no .., separators, drive letters, ADS, device names), realpath.native containment was verified per component, and protected-area and inode checks ran -- see ARCHITECTURE.md "File Manager". The name is random (crypto.randomBytes), opened O_CREAT|O_EXCL|O_NOFOLLOW with mode 0600; the upload or text save it receives is files.manage-gated, size-capped, renamed into place and audited, and nothing loads it as panel code.
  const fd = fs.openSync(tempPath, CREATE_EXCL_FLAGS, 0o600);
  return { fd, path: tempPath, name: tempName };
}

export function writeAllFd(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    // codeql[js/http-to-file-access] the fd is a panel temp file from createTempFile() inside a resolved root; the bytes are a files.manage-gated, size-capped text save, renamed into place and audited, never loaded as panel code.
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

export function fsyncFd(fd) {
  try {
    fs.fsyncSync(fd);
  } catch {
    /* best effort: some network filesystems refuse fsync */
  }
}

export function fchmodFd(fd, mode) {
  try {
    fs.fchmodSync(fd, mode);
  } catch {
    /* best effort: Windows and some network shares ignore modes */
  }
}

export function fchownFd(fd, uid, gid) {
  try {
    fs.fchownSync(fd, uid, gid);
  } catch {
    /* best effort: needs privileges the panel often doesn't have */
  }
}

export function createFdWriteStream(fd) {
  // codeql[js/http-to-file-access] the fd is a panel temp file from createTempFile() inside a resolved root; the upload is files.manage-gated, capped at its declared Content-Length, renamed into place and audited, never loaded as panel code.
  return fs.createWriteStream(null, { fd, autoClose: false });
}

// rename(2) acts on the directory entry: a link is moved, never followed.
export function renamePath(from, to) {
  withWinRetry(() => {
    // codeql[js/path-injection] target is a Resolved from fileManagerLocalBackend.resolve(): the root is server-derived from the profile (never client input), segments passed validateSegments() (no .., separators, drive letters, ADS, device names), realpath.native containment was verified per component, and protected-area and inode checks ran -- see ARCHITECTURE.md "File Manager".
    fs.renameSync(from, to);
  });
}

// Lands a finished temp file under its final name. link(2) fails with
// EEXIST when the name is taken, so there is no check-then-act window.
export function linkPath(from, to) {
  // codeql[js/path-injection, js/file-system-race] target is a Resolved from fileManagerLocalBackend.resolve(): the root is server-derived from the profile (never client input), segments passed validateSegments() (no .., separators, drive letters, ADS, device names), realpath.native containment was verified per component, and protected-area and inode checks ran -- see ARCHITECTURE.md "File Manager". link(2) refuses an existing target atomically.
  fs.linkSync(from, to);
}

export function unlinkPath(p) {
  withWinRetry(() => {
    // codeql[js/path-injection] target is a Resolved from fileManagerLocalBackend.resolve(): the root is server-derived from the profile (never client input), segments passed validateSegments() (no .., separators, drive letters, ADS, device names), realpath.native containment was verified per component, and protected-area and inode checks ran -- see ARCHITECTURE.md "File Manager".
    fs.unlinkSync(p);
  });
}

export function unlinkQuiet(p) {
  try {
    // codeql[js/path-injection] a panel temp file this module created inside a resolved root (random name from createTempFile()).
    fs.unlinkSync(p);
  } catch {
    /* already gone */
  }
}

export function rmdirPath(p) {
  withWinRetry(() => {
    // codeql[js/path-injection] target is a Resolved from fileManagerLocalBackend.resolve(): the root is server-derived from the profile (never client input), segments passed validateSegments() (no .., separators, drive letters, ADS, device names), realpath.native containment was verified per component, and protected-area and inode checks ran -- see ARCHITECTURE.md "File Manager".
    fs.rmdirSync(p);
  });
}

export function mkdirPath(p, mode = 0o755) {
  // codeql[js/path-injection] target is a Resolved from fileManagerLocalBackend.resolve(): the root is server-derived from the profile (never client input), segments passed validateSegments() (no .., separators, drive letters, ADS, device names), realpath.native containment was verified per component, and protected-area and inode checks ran -- see ARCHITECTURE.md "File Manager".
  fs.mkdirSync(p, { mode });
  try {
    // mkdir's mode is filtered by the umask; the spec's folder mode is 0755.
    // codeql[js/path-injection] the folder created on the line above.
    fs.chmodSync(p, mode);
  } catch {
    /* best effort on Windows and network shares */
  }
}

export function chownPath(p, uid, gid) {
  try {
    // codeql[js/path-injection] a folder this module just created inside a resolved root.
    fs.lchownSync(p, uid, gid);
  } catch {
    /* best effort */
  }
}

// Copy a whole regular file into a new panel temp file, both through fds:
// the source was opened O_NOFOLLOW and checked by the caller, so a source
// swapped for a link after resolve() is never followed.
export async function copyFdToFd(srcFd, dstFd, { start = 0, end } = {}) {
  const source = fs.createReadStream(null, { fd: srcFd, start, end, autoClose: false });
  // codeql[js/http-to-file-access] dstFd is a panel temp file from createTempFile(); the source is a regular file inside the same resolved root (a duplicate), size-capped and audited.
  const sink = fs.createWriteStream(null, { fd: dstFd, autoClose: false });
  await pipeline(source, sink);
}

// A new file holding `buffer`, created exclusively (never over an existing
// name, never through a link) with `mode`. Used for a Trash version copy,
// whose content was just read through a checked fd.
export function writeNewFileExcl(abs, buffer, mode = 0o600) {
  // codeql[js/path-injection, js/http-to-file-access] target is a Resolved from fileManagerLocalBackend.resolve(): the root is server-derived from the profile (never client input), segments passed validateSegments() (no .., separators, drive letters, ADS, device names), realpath.native containment was verified per component, and protected-area and inode checks ran -- see ARCHITECTURE.md "File Manager". Here: a payload inside a panel-generated Trash item folder, opened O_CREAT|O_EXCL|O_NOFOLLOW.
  const fd = fs.openSync(abs, CREATE_EXCL_FLAGS, 0o600);
  try {
    writeAllFd(fd, buffer);
    fchmodFd(fd, mode);
    fsyncFd(fd);
  } finally {
    closeFd(fd);
  }
}

// Remove a file, a link or a whole folder tree for good -- the file
// manager's own walker (spec §A6.6), never fs.rm({ recursive }): every entry
// is lstat'ed, files and links are unlinked (a link is never followed, so
// nothing outside the tree is touched), and folders are removed once empty.
// On Windows a folder junction can refuse unlink with EPERM; rmdir removes
// the junction itself without entering it.
export function deleteTree(abs, { onProgress = () => {}, maxEntries = Infinity } = {}) {
  let done = 0;
  const bump = () => {
    done++;
    if (done > maxEntries) {
      const err = new Error("entry cap reached");
      err.code = "EFMCAP";
      throw err;
    }
    if (done % 200 === 0) onProgress(done);
  };
  const removeEntry = (p, st) => {
    try {
      unlinkPath(p);
    } catch (err) {
      if (IS_WIN && err?.code === "EPERM" && st.isSymbolicLink()) rmdirPath(p);
      else throw err;
    }
  };

  const top = lstatBig(abs);
  if (!top.isDirectory()) {
    removeEntry(abs, top);
    bump();
    onProgress(done);
    return done;
  }
  const stack = [{ path: abs, expanded: false }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (!frame.expanded) {
      frame.expanded = true;
      const { names } = readDirNames(frame.path);
      for (const name of names) {
        const child = path.join(frame.path, name);
        const st = lstatBig(child);
        if (st.isDirectory()) {
          stack.push({ path: child, expanded: false });
        } else {
          removeEntry(child, st);
          bump();
        }
      }
    } else {
      rmdirPath(frame.path);
      stack.pop();
      bump();
    }
  }
  onProgress(done);
  return done;
}

// <dataDir>/file-manager-tmp: where a .zip's central-directory temp file
// goes. Inside the panel's own (sealed) data folder, fixed name.
export function ensurePanelTempDir() {
  const dir = path.join(getDataPaths().dataDir, "file-manager-tmp");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// A file of up to `max` bytes read through an fd opened O_NOFOLLOW; used for
// panel-owned files (a Trash item's meta.json). Returns null when missing,
// not a regular file, or larger than `max`.
export function readSmallFileNoFollow(abs, max) {
  let fd;
  try {
    fd = openForRead(abs);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buffer = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = fs.readSync(fd, buffer, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeFd(fd);
  }
}
