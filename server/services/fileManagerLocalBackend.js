// The local Server Files backend (spec §A4.3, §A6): folders on this computer
// or bind-mounted into the panel's container. It owns containment (resolve)
// and the atomic filesystem steps; policy -- name rules, protected areas,
// confirmations, live state, audit, limits -- stays in fileManagerService.js.
//
// Every filesystem call goes through fileManagerLocalFs.js. Every error this
// module throws is an FmError whose message is a code, never a path.
import os from "os";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import { ErrorCode } from "../utils/errorCodes.js";
import { getDiskFree } from "../utils/diskSpace.js";
import { isContainerized } from "../utils/dockerDetect.js";
import { getOwnMountInfo } from "../utils/containerMountInfo.js";
import { getDataPaths, getPanelProgramDir } from "../utils/paths.js";
import { isPidAlive } from "../utils/pidLiveness.js";
import { createLogger } from "../utils/logger.js";
import { installDirKey } from "./bridgeDisk.js";
import {
  FM_LIMITS,
  FmError,
  RENAME_TEMP_SUFFIX,
  TRASH_DIR_NAME,
  UPLOAD_TEMP_SUFFIX,
} from "./fileManagerContract.js";
import * as lfs from "./fileManagerLocalFs.js";
import * as trash from "./fileManagerTrash.js";
import { withFileLocks } from "./fileManagerLocks.js";
import { CASE_FOLD, isInsideAbs, relFromRoot } from "./fileManagerProtectedAreas.js";
import { hashEtag, sha256Hex } from "./fileManagerTextCodec.js";

const log = createLogger("FileManager:Local");

const IS_WIN = process.platform === "win32";
const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const ORPHAN_TEMP_RE = /^\..*\.(\d+)\.[0-9a-f]{8}\.(zcpupload|zcptmp)$/i;
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
const ORPHAN_SWEEP_MAX_NAMES = 20000;
// When this process started: a temp file older than that can't be one of
// ours, whatever pid it names (in a container the panel is PID 1 every time).
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;
// link(2) refusals that mean "no hard links here", not "the name is taken":
// FAT32/exFAT on Windows answer ERROR_INVALID_FUNCTION, which libuv reports
// as EISDIR (or EINVAL for ERROR_INVALID_PARAMETER).
const NO_HARDLINK_CODES = new Set(["EPERM", "ENOTSUP", "EXDEV", "ENOSYS", "EOPNOTSUPP", "EISDIR", "EINVAL"]);
// A case-only rename's temp name: hidden like the other temps (.zcptmp), but
// with no pid in it, so the orphan sweep never takes a user's file that a
// twice-failed case rename left under it.
const CASE_TEMP_TAG = "case";

// ============================================
// Errors
// ============================================

/**
 * Map an OS error to an FmError. Only err.code ever reaches the client (as
 * params.detail); err.message holds absolute paths and stays in the log.
 */
export function mapFsError(err, { name, create = false, dirs = [], deleting = false } = {}) {
  if (err instanceof FmError) return err;
  const osCode = typeof err?.code === "string" ? err.code : null;
  switch (osCode) {
    case "ENOENT":
    case "ENOTDIR":
      return new FmError(ErrorCode.FM_NOT_FOUND);
    case "ENOTEMPTY":
      // A folder that kept filling up while it was being deleted: something
      // (usually the running server) is writing into it.
      if (deleting) return new FmError(ErrorCode.FM_FILE_IN_USE);
      return new FmError(ErrorCode.FM_EXISTS, undefined, { name: name ?? "" });
    case "EEXIST":
      return new FmError(ErrorCode.FM_EXISTS, undefined, { name: name ?? "" });
    case "EACCES":
      return new FmError(ErrorCode.FM_OS_PERMISSION_DENIED, undefined, { detail: osCode });
    case "EPERM":
      // Windows reports both "access denied by the folder's permissions" and
      // "another program holds this file" as EPERM. Creating something can
      // only be the former; for a rename or move, a folder the panel can't
      // even create a file in is the former too.
      if (!IS_WIN || create || dirs.some((dir) => !canCreateIn(dir))) {
        return new FmError(ErrorCode.FM_OS_PERMISSION_DENIED, undefined, { detail: osCode });
      }
      return new FmError(ErrorCode.FM_FILE_IN_USE);
    case "EBUSY":
    case "ETXTBSY":
      return new FmError(ErrorCode.FM_FILE_IN_USE);
    case "ENOSPC":
    case "EDQUOT":
      return new FmError(ErrorCode.FM_INSUFFICIENT_SPACE, undefined, { free: null, required: null });
    case "EROFS":
      return new FmError(ErrorCode.FM_ROOT_READ_ONLY, undefined, { reason: "mount" });
    case "EXDEV":
      return new FmError(ErrorCode.FM_CROSS_DEVICE);
    case "ELOOP":
      return new FmError(ErrorCode.FM_CONFLICT);
    case "ENAMETOOLONG":
      return new FmError(ErrorCode.FM_INVALID_NAME, undefined, { reason: "tooLong" });
    case "EISDIR":
      return new FmError(ErrorCode.FM_NOT_A_FILE);
    case "EFMCAP":
      return new FmError(ErrorCode.FM_TOO_MANY_ENTRIES, undefined, { limit: FM_LIMITS.PERMANENT_DELETE_MAX_ENTRIES });
    default:
      log.warn(`Unexpected filesystem error: ${osCode || err?.name || "unknown"}`);
      return new FmError(ErrorCode.FM_INTERNAL);
  }
}

// Whether the panel's account may create a file in `dirAbs` right now: a
// panel temp file is created and removed at once. Only asked on Windows,
// where the OS can't be asked about a folder's permissions without trying.
function canCreateIn(dirAbs) {
  let temp;
  try {
    temp = lfs.createTempFile(dirAbs, "zcp-probe", RENAME_TEMP_SUFFIX);
  } catch (err) {
    return !(err?.code === "EPERM" || err?.code === "EACCES" || err?.code === "EROFS");
  }
  lfs.closeFd(temp.fd);
  lfs.unlinkQuiet(temp.path);
  return true;
}

// A panel temp file, or the error mapped for a create (EPERM there is the
// folder's permissions, never a file in use).
function createTemp(dirAbs, name, suffix) {
  try {
    return lfs.createTempFile(dirAbs, name, suffix);
  } catch (err) {
    throw mapFsError(err, { name, create: true });
  }
}

// ============================================
// Stats and entries
// ============================================

function typeOf(st) {
  if (st.isSymbolicLink()) return "link";
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "dir";
  return "other";
}

export function toStat(st) {
  return {
    type: typeOf(st),
    size: Number(st.size),
    mtimeMs: Number(st.mtimeNs / 1000000n),
    mtimeNs: st.mtimeNs,
    mode: IS_WIN ? null : Number(st.mode & 0o777n),
    rawMode: Number(st.mode),
    dev: st.dev,
    ino: st.ino,
    uid: Number(st.uid),
    gid: Number(st.gid),
  };
}

// Opaque etags: a stat etag for files (size, mtime, inode) and folders.
export function statEtag(stat) {
  if (!stat) return null;
  if (stat.type === "dir") return `d:${stat.ino}-${stat.mtimeNs}`;
  return `s:${stat.size}-${stat.mtimeNs}-${stat.ino}`;
}

function joinRel(parentRel, name) {
  return parentRel ? `${parentRel}/${name}` : name;
}

function readOnlyOnWindows(stat) {
  return IS_WIN && stat && stat.type === "file" && (stat.rawMode & 0o200) === 0;
}

// A RawEntry for `abs`, a child of a resolved folder. Links are described,
// never followed for the listing itself; `link.targetType` is only looked up
// for a link that stays inside the root.
function entryFor(rootReal, parentRel, parentRealRel, name, abs, st) {
  const stat = toStat(st);
  const locRel = joinRel(parentRealRel, name);
  const entry = {
    name,
    rel: joinRel(parentRel, name),
    locRel,
    realRel: locRel,
    type: stat.type,
    size: stat.type === "dir" ? null : stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
    dev: stat.dev,
    ino: stat.ino,
    etag: statEtag(stat),
  };
  if (stat.type === "link") {
    let real = null;
    try {
      real = lfs.realpathNative(abs);
    } catch {
      entry.link = { inside: false, targetType: "missing" };
      entry.realRel = null;
      return entry;
    }
    if (!isInsideAbs(rootReal, real)) {
      entry.link = { inside: false, targetType: "unknown" };
      entry.realRel = null;
      return entry;
    }
    let targetType = "unknown";
    try {
      const target = toStat(lfs.statBig(real));
      targetType = target.type === "dir" ? "dir" : target.type === "file" ? "file" : "unknown";
      entry.targetDev = target.dev;
      entry.targetIno = target.ino;
    } catch {
      targetType = "missing";
    }
    entry.link = { inside: true, targetType };
    entry.realRel = relFromRoot(rootReal, real);
  }
  return entry;
}

function entryForResolved(r) {
  const stat = r.stat;
  return {
    name: r.name,
    rel: r.rel,
    locRel: r.realRel,
    realRel: r.realRel,
    type: stat.type,
    size: stat.type === "dir" ? null : stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
    dev: stat.dev,
    ino: stat.ino,
    etag: statEtag(stat),
    ...(r.linkSelf ? { link: r.link || { inside: false, targetType: "unknown" } } : {}),
  };
}

// Panel-owned names are left out of listings: the Trash folder (a root's own
// at the top; one deeper is a nested root's, such as a Zomboid folder inside
// the game folder) and the temp files of uploads and saves in flight.
function isHiddenName(name) {
  const lower = name.toLowerCase();
  if (lower === TRASH_DIR_NAME) return true;
  return lower.endsWith(UPLOAD_TEMP_SUFFIX) || lower.endsWith(RENAME_TEMP_SUFFIX);
}

// ============================================
// Root probing (spec §A3.2)
// ============================================

function trimSep(p) {
  const root = path.parse(p).root;
  let out = p;
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
}

function fold(p) {
  return IS_WIN ? trimSep(p).toLowerCase() : trimSep(p);
}

function tooBroadLists() {
  if (IS_WIN) {
    const drive = process.env.SystemDrive || "C:";
    const inside = [process.env.SystemRoot || `${drive}\\Windows`];
    const equal = [
      `${drive}\\Program Files`,
      `${drive}\\Program Files (x86)`,
      `${drive}\\ProgramData`,
      `${drive}\\Users`,
      "C:\\Program Files",
      "C:\\Program Files (x86)",
      "C:\\ProgramData",
      "C:\\Users",
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.ProgramData,
    ].filter(Boolean);
    return { inside, equal };
  }
  return {
    inside: ["/etc", "/bin", "/sbin", "/boot", "/proc", "/sys", "/dev", "/run", "/lib", "/lib64", "/usr/bin", "/usr/sbin", "/usr/lib"],
    equal: ["/usr", "/usr/local", "/var", "/var/lib", "/opt", "/srv", "/home", "/root", "/mnt", "/media", "/tmp"],
  };
}

/**
 * A drive root, the home folder or one of its ancestors, a system folder or
 * anything inside one, or exactly one of the broad shared folders. Inside a
 * broad folder is fine: C:\Program Files (x86)\Steam\... and /opt/pz are
 * ordinary installs.
 */
export function isTooBroad(real) {
  const r = fold(real);
  if (r === fold(path.parse(real).root)) return true;
  const home = os.homedir();
  if (home && isInsideAbs(real, home)) return true;
  const { inside, equal } = tooBroadLists();
  if (inside.some((dir) => isInsideAbs(dir, real))) return true;
  if (equal.some((dir) => fold(dir) === r)) return true;
  return false;
}

function panelDirsReal() {
  const { dataDir, logsDir } = getDataPaths();
  const out = [];
  for (const dir of [dataDir, logsDir, getPanelProgramDir()]) {
    try {
      out.push(lfs.realpathNative(dir));
    } catch {
      if (dir) out.push(path.resolve(dir));
    }
  }
  return out;
}

// Inside a container, a folder only the image provides (no mount other than
// "/" covers it) is lost when the container is recreated.
function isContainerOnly(real) {
  if (!isContainerized()) return false;
  const mounts = getOwnMountInfo();
  if (!mounts) return false;
  let best = null;
  for (const mount of mounts) {
    const point = mount.mountPoint;
    if (!point) continue;
    if (real === point || real.startsWith(point.endsWith("/") ? point : `${point}/`)) {
      if (!best || point.length > best.length) best = point;
    }
  }
  return best === null || best === "/";
}

function unavailableDescriptor(spec, reason, detail) {
  return {
    id: spec.id,
    backend: isContainerized() ? "docker" : "local",
    displayPath: spec.path || null,
    available: false,
    unavailableReason: reason,
    ...(detail ? { unavailableDetail: detail } : {}),
    writable: null,
    freeBytes: null,
    totalBytes: null,
    warnings: [...(spec.warnings || [])],
    trashItemCount: null,
    real: null,
    path: spec.path || null,
    key: null,
  };
}

async function describeRoot(spec) {
  const configured = spec.path;
  if (!configured || typeof configured !== "string" || !path.isAbsolute(configured)) {
    return unavailableDescriptor(spec, "notConfigured");
  }
  let real;
  try {
    real = lfs.realpathNative(configured);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      const underMount = /^\/(pz-server|zomboid)(\/|$)/.test(configured);
      return unavailableDescriptor(spec, isContainerized() && underMount ? "notMounted" : "missing");
    }
    return unavailableDescriptor(spec, "unreadable", typeof err?.code === "string" ? err.code : "unknown");
  }
  let st;
  try {
    st = lfs.lstatBig(real);
  } catch (err) {
    return unavailableDescriptor(spec, "unreadable", typeof err?.code === "string" ? err.code : "unknown");
  }
  if (!st.isDirectory()) return unavailableDescriptor(spec, "missing");
  if (isTooBroad(real)) return unavailableDescriptor(spec, "tooBroad");
  if (panelDirsReal().some((dir) => isInsideAbs(dir, real))) return unavailableDescriptor(spec, "overlapsPanel");

  let writable = true;
  let readOnlyReason;
  try {
    lfs.assertWritable(real);
  } catch (err) {
    writable = false;
    readOnlyReason = err?.code === "EROFS" ? "mount" : "permissions";
  }
  // Windows' access check only looks at the read-only attribute, which a
  // folder never has: a game folder under Program Files the panel's account
  // can't write would look writable. Try it instead.
  if (writable && IS_WIN && !canCreateIn(real)) {
    writable = false;
    readOnlyReason = "permissions";
  }
  const space = await getDiskFree(real);
  const warnings = [...(spec.warnings || [])];
  if (isContainerOnly(real)) warnings.push("containerOnly");
  let trashItemCount = null;
  try {
    trashItemCount = trash.countTrashItems(real);
  } catch {
    trashItemCount = null;
  }
  return {
    id: spec.id,
    backend: isContainerized() ? "docker" : "local",
    displayPath: configured,
    available: true,
    writable,
    ...(readOnlyReason ? { readOnlyReason } : {}),
    freeBytes: space ? space.free : null,
    totalBytes: space ? space.total : null,
    warnings,
    trashItemCount,
    real,
    path: configured,
    key: installDirKey(real),
  };
}

// ============================================
// Resolution (spec §A4.3)
// ============================================

function notFound() {
  return new FmError(ErrorCode.FM_NOT_FOUND);
}

function escapes() {
  return new FmError(ErrorCode.FM_LINK_ESCAPES_ROOT);
}

function realParentInside(rootReal, p) {
  let parentReal;
  try {
    parentReal = lfs.realpathNative(path.dirname(p));
  } catch {
    throw notFound();
  }
  if (!isInsideAbs(rootReal, parentReal)) throw escapes();
  return path.join(parentReal, path.basename(p));
}

async function resolve(root, segments, intent) {
  if (!root?.available || !root.real) {
    throw new FmError(ErrorCode.FM_ROOT_UNAVAILABLE, undefined, { reason: root?.unavailableReason || "missing" });
  }
  const rootReal = root.real;
  const actOnEntry = intent === "delete" || intent === "rename" || intent === "move";
  let cur = rootReal;
  let isNew = false;
  let linkSelf = false;

  for (let i = 0; i < segments.length; i++) {
    const last = i === segments.length - 1;
    const p = path.join(cur, segments[i]);
    let lst;
    try {
      lst = lfs.lstatBig(p);
    } catch (err) {
      if (err?.code === "ENOENT" && last && intent === "create") {
        isNew = true;
        cur = p;
        break;
      }
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") throw notFound();
      throw mapFsError(err);
    }
    if (lst.isSymbolicLink()) {
      // Junctions and volume mount points report as links on Windows.
      if (last && actOnEntry) {
        // Delete, rename and move act on the link itself, never its target.
        linkSelf = true;
        cur = p;
        break;
      }
      let real;
      try {
        real = lfs.realpathNative(p);
      } catch {
        throw notFound();
      }
      if (!isInsideAbs(rootReal, real)) throw escapes();
      cur = real;
    } else {
      cur = p;
    }
  }

  let abs;
  let stat = null;
  let link;
  if (segments.length === 0) {
    abs = rootReal;
    stat = toStat(lfs.lstatBig(rootReal));
  } else if (isNew) {
    abs = realParentInside(rootReal, cur);
  } else if (linkSelf) {
    abs = realParentInside(rootReal, cur);
    try {
      stat = toStat(lfs.lstatBig(abs));
    } catch {
      throw notFound();
    }
    // Describe the link the way a listing would, without following it.
    try {
      const target = lfs.realpathNative(abs);
      link = { inside: isInsideAbs(rootReal, target), targetType: "unknown" };
    } catch {
      link = { inside: false, targetType: "missing" };
    }
  } else {
    // Canonical name: realpath resolves 8.3 short names and case aliases on
    // Windows, so protection is always classified on the real spelling.
    let real;
    try {
      real = lfs.realpathNative(cur);
    } catch {
      throw notFound();
    }
    if (!isInsideAbs(rootReal, real)) throw escapes();
    abs = real;
    try {
      stat = toStat(lfs.lstatBig(abs));
    } catch {
      throw notFound();
    }
  }

  const realRel = relFromRoot(rootReal, abs);
  if (realRel === null) throw escapes();
  return {
    rootId: root.id,
    rel: segments.join("/"),
    realRel,
    abs,
    isNew,
    stat,
    protection: null,
    worldState: false,
    name: segments.length ? segments[segments.length - 1] : "",
    linkSelf,
    ...(link ? { link } : {}),
    rootReal,
    lexicalAbs: root.path ? path.join(root.path, ...segments) : abs,
  };
}

// ============================================
// Reading
// ============================================

// Open a resolved regular file for reading: O_NOFOLLOW|O_NONBLOCK, then the
// fd must still be a regular file with the (dev, ino) resolve() saw. A file
// swapped for a link, a FIFO or another file in between is FM_CONFLICT.
function openChecked(r) {
  if (!r.stat || r.stat.type !== "file") throw new FmError(ErrorCode.FM_NOT_A_FILE);
  let fd;
  try {
    fd = lfs.openForRead(r.abs);
  } catch (err) {
    if (err?.code === "ELOOP" || err?.code === "ENXIO") throw new FmError(ErrorCode.FM_CONFLICT);
    throw mapFsError(err);
  }
  let st;
  try {
    st = lfs.fstatBig(fd);
  } catch (err) {
    lfs.closeFd(fd);
    throw mapFsError(err);
  }
  if (!st.isFile() || st.dev !== r.stat.dev || st.ino !== r.stat.ino) {
    lfs.closeFd(fd);
    throw new FmError(ErrorCode.FM_CONFLICT);
  }
  return { fd, st };
}

function readRange(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = lfs.readFd(fd, buffer, read, length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  return buffer.subarray(0, read);
}

async function readBytes(r, { maxBytes, tail = false }) {
  const { fd, st } = openChecked(r);
  try {
    const size = Number(st.size);
    const length = Math.min(size, maxBytes);
    const position = tail ? size - length : 0;
    const buffer = readRange(fd, position, length);
    return { buffer, size, truncated: length < size };
  } catch (err) {
    throw mapFsError(err);
  } finally {
    lfs.closeFd(fd);
  }
}

async function openReadStream(r) {
  const { fd, st } = openChecked(r);
  const size = Number(st.size);
  if (size === 0) {
    lfs.closeFd(fd);
    const stream = Readable.from([]);
    return { stream, size, close: async () => stream.destroy() };
  }
  const stream = lfs.createFdReadStream(fd, { start: 0, end: size - 1 });
  return { stream, size, close: async () => stream.destroy() };
}

// ============================================
// Writing helpers
// ============================================

function ownerFor(existingStat, parentAbs) {
  if (!RUNNING_AS_ROOT) return null;
  if (existingStat) return { uid: existingStat.uid, gid: existingStat.gid };
  try {
    const parent = toStat(lfs.lstatBig(parentAbs));
    return { uid: parent.uid, gid: parent.gid };
  } catch {
    return null;
  }
}

// Leftover upload/save temps (.<name>.<pid>.<hex8>.zcpupload|.zcptmp) older
// than an hour, swept on the next write into a folder: those of a process
// that is gone, and any from before this process started (a container's
// panel is PID 1 on every start, so the pid alone can't tell).
export function sweepOrphanTemps(dirAbs, now = Date.now()) {
  let names;
  try {
    const listed = lfs.readDirNames(dirAbs, ORPHAN_SWEEP_MAX_NAMES);
    if (listed.truncated) return 0;
    names = listed.names;
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = ORPHAN_TEMP_RE.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    const abs = path.join(dirAbs, name);
    try {
      const st = toStat(lfs.lstatBig(abs));
      if (st.type !== "file" || now - st.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
      const beforeThisProcess = st.mtimeMs < PROCESS_STARTED_AT;
      if (!beforeThisProcess && (pid === process.pid || isPidAlive(pid))) continue;
      lfs.unlinkQuiet(abs);
      removed++;
    } catch {
      /* gone already */
    }
  }
  return removed;
}

// A temp file this module writes into: `fd` is owned here and closed exactly
// once, by sealTemp() or discardTemp(), whichever runs first.
function openTemp(dirAbs, name, suffix) {
  const temp = createTemp(dirAbs, name, suffix);
  return { ...temp, closed: false };
}

function closeTemp(temp) {
  if (temp.closed) return;
  temp.closed = true;
  lfs.closeFd(temp.fd);
}

function discardTemp(temp) {
  closeTemp(temp);
  lfs.unlinkQuiet(temp.path);
}

// Finish a temp file: final mode, owner, flushed, closed. A flush or close
// that says the bytes never reached the disk (EIO, ENOSPC, EDQUOT: a network
// share or a quota reports them only here) removes the temp and throws.
function sealTemp(temp, mode, owner, name) {
  lfs.fchmodFd(temp.fd, mode);
  if (owner) lfs.fchownFd(temp.fd, owner.uid, owner.gid);
  temp.closed = true;
  try {
    lfs.syncAndCloseFd(temp.fd);
  } catch (err) {
    lfs.unlinkQuiet(temp.path);
    throw mapFsError(err, { name });
  }
}

// Land a finished temp file under a NEW name. link(2) refuses an existing
// name atomically; where the filesystem has no hard links, fall back to
// "must not exist, then rename" (a documented residual race).
function landNew(tempPath, target, name) {
  try {
    lfs.linkPath(tempPath, target);
  } catch (err) {
    if (err?.code === "EEXIST") {
      lfs.unlinkQuiet(tempPath);
      throw new FmError(ErrorCode.FM_EXISTS, undefined, { name });
    }
    if (!NO_HARDLINK_CODES.has(err?.code)) {
      lfs.unlinkQuiet(tempPath);
      throw mapFsError(err, { name });
    }
    try {
      lfs.lstatBig(target);
      lfs.unlinkQuiet(tempPath);
      throw new FmError(ErrorCode.FM_EXISTS, undefined, { name });
    } catch (probe) {
      if (probe instanceof FmError) throw probe;
      if (probe?.code !== "ENOENT") {
        lfs.unlinkQuiet(tempPath);
        throw mapFsError(probe, { name });
      }
    }
    try {
      lfs.renamePath(tempPath, target);
    } catch (renameErr) {
      lfs.unlinkQuiet(tempPath);
      throw mapFsError(renameErr, { name, dirs: [path.dirname(target)] });
    }
    return;
  }
  lfs.unlinkQuiet(tempPath);
}

// Replace an existing file with a finished temp file, keeping the old one in
// Trash ("replaced"). If the second rename fails, the old file goes back.
function landReplace(rootReal, tempPath, target, name, oldStat, metaInput) {
  let slot;
  try {
    slot = trash.prepareTrashSlot(rootReal, path.basename(target), {
      ...metaInput,
      type: "file",
      bytes: oldStat.size,
      files: 1,
      reason: "replaced",
    });
  } catch (err) {
    lfs.unlinkQuiet(tempPath);
    throw err;
  }
  try {
    lfs.renamePath(target, slot.payloadPath);
  } catch (err) {
    slot.discard();
    lfs.unlinkQuiet(tempPath);
    if (err?.code === "EXDEV") throw new FmError(ErrorCode.FM_TRASH_UNAVAILABLE, undefined, { reason: "crossDevice" });
    throw mapFsError(err, { name, dirs: [path.dirname(target)] });
  }
  try {
    lfs.renamePath(tempPath, target);
  } catch (err) {
    try {
      lfs.renamePath(slot.payloadPath, target);
      slot.discard();
    } catch (restoreErr) {
      // The old file stays in Trash, restorable; say so in the log.
      log.error(`Could not put a replaced file back after a failed upload (${restoreErr?.code || "error"}); it is in Trash as ${slot.trashId}`);
    }
    lfs.unlinkQuiet(tempPath);
    throw mapFsError(err, { name, dirs: [path.dirname(target)] });
  }
  return slot.trashId;
}

function currentStatOf(abs) {
  try {
    return toStat(lfs.lstatBig(abs));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw mapFsError(err);
  }
}

function entryAt(rootReal, parentRel, parentAbs, name) {
  const abs = path.join(parentAbs, name);
  const parentRealRel = relFromRoot(rootReal, parentAbs) ?? "";
  return entryFor(rootReal, parentRel, parentRealRel, name, abs, lfs.lstatBig(abs));
}

function parentRelOf(rel) {
  const idx = rel.lastIndexOf("/");
  return idx === -1 ? "" : rel.slice(0, idx);
}

// The same directory entry: (dev, ino) when the filesystem reports a real
// inode, else null (unknown).
function sameEntry(a, b) {
  if (!a || !b) return false;
  if (a.ino === undefined || a.ino === null || BigInt(a.ino) === 0n || b.ino === undefined || b.ino === null) return null;
  return String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
}

// ============================================
// Mutations
// ============================================

async function writeBytesCas(r, bytes, { expectedHash, trashMeta }) {
  const parentAbs = path.dirname(r.abs);
  const name = path.basename(r.abs);
  return withFileLocks([r.lexicalAbs, r.abs], () => {
    sweepOrphanTemps(parentAbs);
    if (expectedHash === null) {
      if (currentStatOf(r.abs)) throw new FmError(ErrorCode.FM_EXISTS, undefined, { name });
      const temp = openTemp(parentAbs, name, RENAME_TEMP_SUFFIX);
      try {
        lfs.writeAllFd(temp.fd, bytes);
        sealTemp(temp, 0o644, ownerFor(null, parentAbs), name);
      } catch (err) {
        discardTemp(temp);
        throw mapFsError(err, { name });
      }
      landNew(temp.path, r.abs, name);
      return {
        entry: entryAt(r.rootReal, parentRelOf(r.rel), parentAbs, name),
        previousTrashId: null,
        sha256Before: null,
      };
    }

    // Compare-and-swap: re-read the current bytes through a checked fd and
    // compare their hash with the one the editor loaded. A file that grew
    // past the editor limit since is refused before it is read.
    const { fd } = openChecked(r);
    let current;
    try {
      const size = Number(lfs.fstatBig(fd).size);
      if (size > FM_LIMITS.TEXT_EDIT_MAX_BYTES) {
        throw new FmError(ErrorCode.FM_FILE_TOO_LARGE_FOR_EDITOR, undefined, { limit: FM_LIMITS.TEXT_EDIT_MAX_BYTES });
      }
      current = readRange(fd, 0, size);
    } finally {
      lfs.closeFd(fd);
    }
    const currentEtag = hashEtag(current);
    if (currentEtag !== expectedHash) {
      throw new FmError(ErrorCode.FM_CONFLICT, undefined, { currentEtag });
    }
    if (readOnlyOnWindows(r.stat)) throw new FmError(ErrorCode.FM_TARGET_READ_ONLY);

    const temp = openTemp(parentAbs, name, RENAME_TEMP_SUFFIX);
    try {
      lfs.writeAllFd(temp.fd, bytes);
      // Exactly the old permission bits: keeps +x, drops setuid/setgid/sticky.
      sealTemp(temp, r.stat.mode ?? 0o644, ownerFor(r.stat, parentAbs), name);
    } catch (err) {
      discardTemp(temp);
      throw mapFsError(err, { name });
    }

    // The previous version goes to Trash in the same step as the write
    // (FM-I9): if it can't be kept, nothing is written. It is taken only
    // once the new bytes are safely in their temp file, and dropped again
    // when the final rename fails, so a save that didn't happen leaves no
    // version behind to push real ones out.
    let previousTrashId;
    try {
      previousTrashId = trash.copyVersionToTrash(r.rootReal, {
        name,
        buffer: current,
        mode: r.stat.mode ?? 0o644,
        originalPath: r.realRel,
        deletedBy: trashMeta?.deletedBy,
        reason: "edited",
      });
    } catch (err) {
      lfs.unlinkQuiet(temp.path);
      log.warn(`Could not keep the previous version in Trash: ${err?.code || err?.name || "error"}`);
      if (err instanceof FmError) throw err;
      throw mapFsError(err, { name });
    }
    try {
      lfs.renamePath(temp.path, r.abs);
    } catch (err) {
      lfs.unlinkQuiet(temp.path);
      trash.discardTrashItem(r.rootReal, previousTrashId);
      throw mapFsError(err, { name, dirs: [parentAbs] });
    }
    return {
      entry: entryAt(r.rootReal, parentRelOf(r.rel), parentAbs, name),
      previousTrashId,
      sha256Before: sha256Hex(current),
    };
  }).then(async (result) => {
    // Outside the locked block: only the check, the version copy and the
    // write itself need to be one synchronous step.
    if (result.previousTrashId) {
      await trash.pruneEditedVersions(r.rootReal, r.realRel).catch(() => {
        /* the janitor still expires old versions */
      });
    }
    return result;
  });
}

// Stream the request body into a panel temp file, hashing on the way.
//
// The fd belongs to the caller, which closes it once this settles: the sink
// is never destroy()ed (that closes the fd even with autoClose off, and a
// write still in flight would then close it again later, hitting whatever
// file got that number in between). On failure the source is unpiped and
// this waits for the sink's pending write to finish before rejecting. A
// write error at the very end (end()'s callback) fails the upload too, and
// the bytes the sink wrote must be the bytes received.
function receiveIntoTemp(source, fd, { declaredSize, maxBytes }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = crypto.createHash("sha256");
    const sink = lfs.createFdWriteStream(fd);
    let received = 0;
    let settled = false;
    let idleTimer = null;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      source.removeListener("data", onData);
      source.removeListener("end", onEnd);
      source.removeListener("error", onSourceError);
      source.removeListener("aborted", onAborted);
      source.removeListener("close", onClose);
    };
    // Resolves once no write is in flight on the fd: the sink finished or
    // errored (an error only arrives after the write that failed returned).
    const sinkIdle = () =>
      new Promise((done) => {
        if (sink.writableFinished || sink.errored || sink.destroyed) {
          done();
          return;
        }
        const finish = () => {
          sink.off("finish", finish);
          sink.off("error", finish);
          done();
        };
        sink.on("finish", finish);
        sink.on("error", finish);
        if (!sink.writableEnded) sink.end();
      });
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      source.unpipe?.(sink);
      source.resume?.();
      sinkIdle().then(() => rejectPromise(err));
    };
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fail(new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH));
        source.destroy?.();
      }, FM_LIMITS.UPLOAD_IDLE_MS);
      idleTimer.unref?.();
    };
    const onData = (chunk) => {
      received += chunk.length;
      if (received > declaredSize || received > maxBytes) {
        fail(new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH));
        source.destroy?.();
        return;
      }
      hash.update(chunk);
      armIdle();
    };
    const onEnd = () => {
      if (settled) return;
      if (received !== declaredSize) {
        fail(new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH));
        return;
      }
      if (idleTimer) clearTimeout(idleTimer);
      sink.end((err) => {
        if (settled) return;
        if (err) {
          fail(mapFsError(err));
          return;
        }
        if (sink.bytesWritten !== received) {
          log.warn(`An upload wrote ${sink.bytesWritten} of ${received} bytes`);
          fail(new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH));
          return;
        }
        settled = true;
        cleanup();
        resolvePromise({ sha256: hash.digest("hex"), received });
      });
    };
    const onSourceError = () => fail(new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH));
    const onAborted = () => fail(new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH));
    const onClose = () => {
      if (!settled && received !== declaredSize) fail(new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH));
    };
    sink.on("error", (err) => {
      // After a failure (or a finished upload) a late sink error has nothing
      // left to report.
      if (!settled) fail(mapFsError(err));
    });
    source.on("data", onData);
    source.on("end", onEnd);
    source.on("error", onSourceError);
    source.on("aborted", onAborted);
    source.on("close", onClose);
    armIdle();
    source.pipe(sink, { end: false });
  });
}

async function receiveUpload(dir, name, source, { declaredSize, maxBytes, overwriteEtag, trashMeta }) {
  if (!dir.stat || dir.stat.type !== "dir") throw new FmError(ErrorCode.FM_NOT_A_DIRECTORY);
  const target = path.join(dir.abs, name);
  sweepOrphanTemps(dir.abs);
  const temp = openTemp(dir.abs, name, UPLOAD_TEMP_SUFFIX);
  let sha256;
  try {
    ({ sha256 } = await receiveIntoTemp(source, temp.fd, { declaredSize, maxBytes }));
  } catch (err) {
    discardTemp(temp);
    throw err instanceof FmError ? err : mapFsError(err, { name });
  }
  const lexicalTarget = dir.lexicalAbs ? path.join(dir.lexicalAbs, name) : target;
  return withFileLocks([lexicalTarget, target], () => {
    let replacedTrashId = null;
    if (overwriteEtag === null || overwriteEtag === undefined) {
      try {
        sealTemp(temp, 0o644, ownerFor(null, dir.abs), name);
      } catch (err) {
        discardTemp(temp);
        throw mapFsError(err, { name });
      }
      landNew(temp.path, target, name);
    } else {
      const refuse = (err) => {
        discardTemp(temp);
        throw err;
      };
      let oldStat;
      try {
        oldStat = currentStatOf(target);
      } catch (err) {
        refuse(err);
      }
      if (!oldStat) refuse(new FmError(ErrorCode.FM_CONFLICT));
      if (oldStat.type !== "file") refuse(new FmError(ErrorCode.FM_NOT_A_FILE));
      if (statEtag(oldStat) !== overwriteEtag) {
        refuse(new FmError(ErrorCode.FM_CONFLICT, undefined, { currentEtag: statEtag(oldStat) }));
      }
      if (readOnlyOnWindows(oldStat)) refuse(new FmError(ErrorCode.FM_TARGET_READ_ONLY));
      try {
        sealTemp(temp, oldStat.mode ?? 0o644, ownerFor(oldStat, dir.abs), name);
      } catch (err) {
        discardTemp(temp);
        throw err;
      }
      replacedTrashId = landReplace(dir.rootReal, temp.path, target, name, oldStat, {
        originalPath: joinRel(dir.realRel, name),
        deletedBy: trashMeta?.deletedBy,
      });
    }
    return {
      entry: entryAt(dir.rootReal, dir.rel, dir.abs, name),
      sha256,
      replacedTrashId,
    };
  });
}

async function mkdir(parent, name) {
  if (!parent.stat || parent.stat.type !== "dir") throw new FmError(ErrorCode.FM_NOT_A_DIRECTORY);
  const target = path.join(parent.abs, name);
  return withFileLocks([target], () => {
    try {
      lfs.mkdirPath(target, 0o755);
    } catch (err) {
      throw mapFsError(err, { name, create: true });
    }
    const owner = ownerFor(null, parent.abs);
    if (owner) lfs.chownPath(target, owner.uid, owner.gid);
    return entryAt(parent.rootReal, parent.rel, parent.abs, name);
  });
}

async function rename(r, newName) {
  const parentAbs = path.dirname(r.abs);
  const oldName = path.basename(r.abs);
  const target = path.join(parentAbs, newName);
  return withFileLocks([r.abs, target], () => {
    // What the new name already names on disk decides the rename, not how
    // JavaScript folds case: the same entry (a case-insensitive folder, a
    // case-only change) goes through a temp name so the rename is a real
    // one; any OTHER entry is refused, even in a case-sensitive folder on
    // Windows or macOS, where the final rename would silently replace it.
    const existing = currentStatOf(target);
    let same = existing ? sameEntry(existing, r.stat) : false;
    if (same === null) same = CASE_FOLD && newName.toLowerCase() === oldName.toLowerCase();
    if (existing && !same) throw new FmError(ErrorCode.FM_EXISTS, undefined, { name: newName });
    if (existing) {
      const tempName = `.${oldName.slice(0, 80)}.${CASE_TEMP_TAG}.${crypto.randomBytes(4).toString("hex")}${RENAME_TEMP_SUFFIX}`;
      const tempPath = path.join(parentAbs, tempName);
      try {
        lfs.renamePath(r.abs, tempPath);
      } catch (err) {
        throw mapFsError(err, { name: newName, dirs: [parentAbs] });
      }
      try {
        lfs.renamePath(tempPath, target);
      } catch (err) {
        restoreFromCaseTemp(tempPath, r.abs, parentAbs, oldName);
        throw mapFsError(err, { name: newName, dirs: [parentAbs] });
      }
    } else {
      try {
        lfs.renamePath(r.abs, target);
      } catch (err) {
        throw mapFsError(err, { name: newName, dirs: [parentAbs] });
      }
    }
    return entryAt(r.rootReal, parentRelOf(r.rel), parentAbs, newName);
  });
}

// A case-only rename failed halfway: put the item back under its old name,
// or at least under a visible one, never leaving it hidden under the temp.
function restoreFromCaseTemp(tempPath, originalAbs, parentAbs, oldName) {
  try {
    lfs.renamePath(tempPath, originalAbs);
    return;
  } catch {
    /* try a visible name next */
  }
  const ext = path.extname(oldName);
  const hasExt = Boolean(ext) && ext !== oldName;
  const base = hasExt ? oldName.slice(0, -ext.length) : oldName;
  const recovery = path.join(parentAbs, `${base} (rename interrupted ${crypto.randomBytes(2).toString("hex")})${hasExt ? ext : ""}`);
  try {
    lfs.renamePath(tempPath, recovery);
    log.error("A case-only rename failed halfway; the item now has a new visible name in its folder");
  } catch {
    log.error(`A case-only rename failed halfway; the item keeps the hidden name ${path.basename(tempPath)}`);
  }
}

async function move(r, destDir) {
  if (!destDir.stat || destDir.stat.type !== "dir") throw new FmError(ErrorCode.FM_NOT_A_DIRECTORY);
  const name = path.basename(r.abs);
  const target = path.join(destDir.abs, name);
  return withFileLocks([r.abs, target], () => {
    if (currentStatOf(target)) throw new FmError(ErrorCode.FM_EXISTS, undefined, { name });
    try {
      lfs.renamePath(r.abs, target);
    } catch (err) {
      throw mapFsError(err, { name, dirs: [destDir.abs, path.dirname(r.abs)] });
    }
    return entryAt(destDir.rootReal, destDir.rel, destDir.abs, name);
  });
}

async function copyFile(r, destDir, newName, { overwriteEtag = null, trashMeta } = {}) {
  if (!destDir.stat || destDir.stat.type !== "dir") throw new FmError(ErrorCode.FM_NOT_A_DIRECTORY);
  const target = path.join(destDir.abs, newName);
  sweepOrphanTemps(destDir.abs);
  const { fd: srcFd, st } = openChecked(r);
  const size = Number(st.size);
  let temp;
  try {
    temp = openTemp(destDir.abs, newName, RENAME_TEMP_SUFFIX);
    const copied = await lfs.copyFdToFd(srcFd, temp.fd, size);
    // The source shrank while it was being copied.
    if (copied !== size) throw new FmError(ErrorCode.FM_CONFLICT);
  } catch (err) {
    if (temp) discardTemp(temp);
    throw mapFsError(err, { name: newName });
  } finally {
    lfs.closeFd(srcFd);
  }
  return withFileLocks([target], () => {
    if (overwriteEtag === null) {
      try {
        sealTemp(temp, 0o644, ownerFor(null, destDir.abs), newName);
      } catch (err) {
        discardTemp(temp);
        throw err;
      }
      landNew(temp.path, target, newName);
    } else {
      let oldStat;
      try {
        oldStat = currentStatOf(target);
      } catch (err) {
        discardTemp(temp);
        throw err;
      }
      if (!oldStat || oldStat.type !== "file" || statEtag(oldStat) !== overwriteEtag) {
        discardTemp(temp);
        throw new FmError(ErrorCode.FM_CONFLICT, undefined, oldStat ? { currentEtag: statEtag(oldStat) } : {});
      }
      // Like an upload over it: the Windows read-only attribute is honoured.
      if (readOnlyOnWindows(oldStat)) {
        discardTemp(temp);
        throw new FmError(ErrorCode.FM_TARGET_READ_ONLY);
      }
      try {
        sealTemp(temp, oldStat.mode ?? 0o644, ownerFor(oldStat, destDir.abs), newName);
      } catch (err) {
        discardTemp(temp);
        throw err;
      }
      landReplace(destDir.rootReal, temp.path, target, newName, oldStat, {
        originalPath: joinRel(destDir.realRel, newName),
        deletedBy: trashMeta?.deletedBy,
      });
    }
    return entryAt(destDir.rootReal, destDir.rel, destDir.abs, newName);
  });
}

// ============================================
// Walking, listing
// ============================================

/**
 * Breadth-first walk under a resolved folder that never follows links.
 * Yields { name, rel, realRel, type, size, mtimeMs, dev, ino, depth }. Stops
 * quietly at the caps; callers that must report truncation count entries
 * and depth themselves. `prune(entry)` returning true skips a folder's
 * contents. `onUnreadable({ rel, realRel, name, folder })` hears about a
 * folder that couldn't be listed and an entry that couldn't be looked at
 * (both are otherwise skipped), and `onDepthLimit()` about a folder left
 * unopened at maxDepth.
 */
async function* walk(
  r,
  { maxEntries = Infinity, maxDepth = Infinity, maxMs = Infinity, signal, prune, onUnreadable, onDepthLimit } = {},
) {
  if (!r.stat || r.stat.type !== "dir") return;
  const started = Date.now();
  const queue = [{ abs: r.abs, rel: r.rel, realRel: r.realRel, depth: 0 }];
  let yielded = 0;
  let depthReported = false;
  while (queue.length) {
    const dir = queue.shift();
    if (dir.depth >= maxDepth) {
      // Only a folder with something in it was really cut short.
      if (onDepthLimit && !depthReported) {
        try {
          if (lfs.readDirNames(dir.abs, 16).names.some((name) => !isHiddenName(name))) {
            depthReported = true;
            onDepthLimit({ rel: dir.rel, realRel: dir.realRel });
          }
        } catch {
          /* unreadable: nothing to report as cut short */
        }
      }
      continue;
    }
    let listed;
    try {
      ({ entries: listed } = lfs.readDirEntries(dir.abs, FM_LIMITS.LIST_DIR_MAX_ENTRIES));
    } catch {
      onUnreadable?.({ rel: dir.rel, realRel: dir.realRel, folder: true });
      continue;
    }
    for (const item of listed) {
      if (signal?.aborted || yielded >= maxEntries || Date.now() - started > maxMs) return;
      const { name } = item;
      if (isHiddenName(name)) continue;
      const abs = lfs.childPathOf(dir.abs, item);
      let st;
      try {
        st = toStat(lfs.lstatBig(abs));
      } catch {
        onUnreadable?.({ rel: joinRel(dir.rel, name), realRel: joinRel(dir.realRel, name), folder: false });
        continue;
      }
      const entry = {
        name,
        rel: joinRel(dir.rel, name),
        realRel: joinRel(dir.realRel, name),
        type: st.type,
        size: st.type === "file" ? st.size : 0,
        mtimeMs: st.mtimeMs,
        dev: st.dev,
        ino: st.ino,
        depth: dir.depth + 1,
        // A name that isn't valid Unicode: `name` is lossy, so the entry
        // can be counted and reported but never reached by its path.
        ...(item.raw ? { unrepresentable: true } : {}),
      };
      yielded++;
      yield entry;
      if (st.type === "dir" && !(prune && prune(entry))) {
        queue.push({ abs, rel: entry.rel, realRel: entry.realRel, depth: dir.depth + 1 });
      }
      if (yielded % 500 === 0) await new Promise((done) => setImmediate(done));
    }
  }
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function isFolderLike(entry) {
  return entry.type === "dir" || (entry.type === "link" && entry.link?.targetType === "dir");
}

function compareEntries(sort, order) {
  const dir = order === "desc" ? -1 : 1;
  return (a, b) => {
    const fa = isFolderLike(a);
    const fb = isFolderLike(b);
    if (fa !== fb) return fa ? -1 : 1;
    let cmp = 0;
    if (sort === "size") cmp = (a.size ?? -1) - (b.size ?? -1);
    else if (sort === "modified") cmp = (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0);
    if (cmp === 0) cmp = collator.compare(a.name, b.name);
    return cmp * dir;
  };
}

async function list(dir, { offset = 0, limit = FM_LIMITS.LIST_PAGE_DEFAULT, sort = "name", order = "asc" } = {}) {
  if (!dir.stat || dir.stat.type !== "dir") throw new FmError(ErrorCode.FM_NOT_A_DIRECTORY);
  let listed;
  try {
    listed = lfs.readDirEntries(dir.abs, FM_LIMITS.LIST_DIR_MAX_ENTRIES);
  } catch (err) {
    throw mapFsError(err);
  }
  const items = listed.entries.filter((item) => !isHiddenName(item.name));
  const total = items.length;
  const dirEtag = statEtag(dir.stat);
  const describe = (item) => {
    try {
      const abs = lfs.childPathOf(dir.abs, item);
      const entry = entryFor(dir.rootReal, dir.rel, dir.realRel, item.name, path.join(dir.abs, item.name), lfs.lstatBig(abs));
      // Shown (so the folder doesn't look emptier than it is), but a name
      // that isn't valid Unicode can't be reached through a path.
      if (item.raw) entry.unrepresentable = true;
      return entry;
    } catch {
      return null;
    }
  };

  if (total <= FM_LIMITS.LIST_FULL_STAT_MAX) {
    const entries = items.map(describe).filter(Boolean);
    entries.sort(compareEntries(sort, order));
    return {
      entries: entries.slice(offset, offset + limit),
      total: entries.length,
      sortLimited: false,
      truncated: listed.truncated,
      dirEtag,
    };
  }
  // Big folder: sort names only, stat just the requested page.
  const sorted = [...items].sort((a, b) => collator.compare(a.name, b.name) * (order === "desc" ? -1 : 1));
  const page = sorted.slice(offset, offset + limit).map(describe).filter(Boolean);
  return { entries: page, total, sortLimited: true, truncated: listed.truncated, dirEtag };
}

async function stat(r) {
  if (!r.stat) throw new FmError(ErrorCode.FM_NOT_FOUND);
  if (r.linkSelf) {
    const parentAbs = path.dirname(r.abs);
    try {
      return entryFor(r.rootReal, parentRelOf(r.rel), relFromRoot(r.rootReal, parentAbs) ?? "", r.name, r.abs, lfs.lstatBig(r.abs));
    } catch (err) {
      throw mapFsError(err);
    }
  }
  return entryForResolved(r);
}

// ============================================
// Trash
// ============================================

async function trashMove(r, meta) {
  if (!r.stat) throw new FmError(ErrorCode.FM_NOT_FOUND);
  return withFileLocks([r.lexicalAbs, r.abs], () => {
    try {
      const trashId = trash.moveToTrash(r.rootReal, r.abs, {
        originalPath: r.realRel,
        type: r.stat.type === "dir" ? "dir" : "file",
        bytes: meta?.bytes ?? (r.stat.type === "file" ? r.stat.size : 0),
        files: meta?.files ?? (r.stat.type === "dir" ? 0 : 1),
        deletedBy: meta?.deletedBy,
        reason: meta?.reason || "deleted",
        dev: r.stat.dev,
      });
      return { trashId };
    } catch (err) {
      throw mapFsError(err, { name: r.name });
    }
  });
}

async function trashList(root) {
  return trash.listTrash(root.real);
}

async function trashRestore(root, trashId, restoreAs) {
  const item = trash.findTrashItem(root.real, trashId);
  const originalPath = item.meta?.originalPath;
  if (!originalPath) throw new FmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
  const segments = originalPath.split("/");
  const name = restoreAs || segments[segments.length - 1];
  const parent = await resolve(root, segments.slice(0, -1), "list");
  if (!parent.stat || parent.stat.type !== "dir") throw new FmError(ErrorCode.FM_NOT_FOUND);
  const target = path.join(parent.abs, name);
  return withFileLocks([target], () => {
    try {
      if (currentStatOf(target)) throw new FmError(ErrorCode.FM_EXISTS, undefined, { name });
      const payloadStat = toStat(lfs.lstatBig(item.payloadAbs));
      if (payloadStat.type === "file") {
        // A file lands with link(2), which refuses a name taken meanwhile.
        try {
          lfs.linkPath(item.payloadAbs, target);
          lfs.unlinkPath(item.payloadAbs);
        } catch (err) {
          if (err?.code === "EEXIST") throw new FmError(ErrorCode.FM_EXISTS, undefined, { name });
          if (!NO_HARDLINK_CODES.has(err?.code)) throw err;
          lfs.renamePath(item.payloadAbs, target);
        }
      } else {
        lfs.renamePath(item.payloadAbs, target);
      }
      trash.finishRestore(item);
      return entryAt(root.real, parent.rel, parent.abs, name);
    } catch (err) {
      throw mapFsError(err, { name });
    }
  });
}

/**
 * The first maxBytes of a Trash item that is a file, read through the same
 * checked descriptor as readBytes (the editor's "Previous versions").
 */
async function trashReadBytes(root, trashId, { maxBytes }) {
  const item = trash.findTrashItem(root.real, trashId);
  let stat;
  try {
    stat = toStat(lfs.lstatBig(item.payloadAbs));
  } catch {
    throw new FmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
  }
  if (stat.type !== "file") throw new FmError(ErrorCode.FM_NOT_A_FILE);
  return readBytes({ abs: item.payloadAbs, stat }, { maxBytes });
}

async function deletePermanent(target, onProgress = () => {}) {
  try {
    if (target && typeof target.trashId === "string") {
      await trash.purgeTrashItem(target.root.real, target.trashId, {
        onProgress: (done) => onProgress(done, null),
        maxEntries: FM_LIMITS.PERMANENT_DELETE_MAX_ENTRIES,
      });
      return;
    }
    await lfs.deleteTree(target.abs, {
      onProgress: (done) => onProgress(done, null),
      maxEntries: FM_LIMITS.PERMANENT_DELETE_MAX_ENTRIES,
    });
  } catch (err) {
    if (err?.code === "EPERM" && IS_WIN) throw new FmError(ErrorCode.FM_FILE_IN_USE);
    throw mapFsError(err, { deleting: true });
  }
}

async function freeSpace(root) {
  const space = root?.real ? await getDiskFree(root.real) : null;
  return { free: space ? space.free : null, total: space ? space.total : null };
}

/**
 * Whether Trash can take `items` (each with a stat.dev): it must be
 * creatable and on the same device as every item.
 */
export function trashAvailability(root, items) {
  const probe = trash.probeTrash(root.real);
  if (!probe.usable) return { available: false, reason: probe.reason || "notWritable" };
  for (const item of items) {
    if (item?.stat?.dev !== undefined && item.stat.dev !== null && probe.dev !== null && item.stat.dev !== probe.dev) {
      return { available: false, reason: "crossDevice" };
    }
  }
  return { available: true };
}

/** @type {import("./fileManagerContract.js").FileBackend & Record<string, unknown>} */
export const localBackend = Object.freeze({
  kind: "local",
  describeRoot,
  resolve,
  list,
  stat,
  readBytes,
  openReadStream,
  writeBytesCas,
  receiveUpload,
  mkdir,
  rename,
  move,
  copyFile,
  walk,
  trashMove,
  trashList,
  trashRestore,
  trashReadBytes,
  deletePermanent,
  freeSpace,
  trashAvailability,
  statEtag,
});

export function createLocalBackend() {
  return localBackend;
}
