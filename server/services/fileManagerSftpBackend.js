// Server Files over the active remote profile's PanelBridge SFTP login
// (spec §A12, the FileBackend interface of §A13, remote resolution §A4.5).
//
// Division of work: the service layer (fileManagerService.js) owns policy --
// segment validation, protection classification on realRel, confirmations,
// live state, audit and limits. This backend owns containment and the
// filesystem steps, and only ever throws FmError. It returns every Resolved
// with `protection: null` and `worldState: false`; the service fills them in.
//
// Containment: every existing path component is lstat'ed from the root's
// realPath() down. A link is followed only when its target stays inside the
// root: the server's own REALPATH decides, and on servers whose REALPATH
// doesn't resolve links, readlink() does (an absolute target outside the
// root, or a relative one that climbs out, is FM_LINK_ESCAPES_ROOT). The
// SFTP account's own permissions are the real boundary; this keeps the file
// manager from wandering past the folder the operator chose.
//
// Nothing here uses the library's recursive rmdir: permanent delete walks
// the tree itself, unlinks links and files, and never follows a link.
import crypto from "crypto";
import { posix } from "path";
import { Readable } from "stream";
import { ErrorCode } from "../utils/errorCodes.js";
import { createLogger } from "../utils/logger.js";
import {
  FM_LIMITS,
  FmError,
  RENAME_TEMP_SUFFIX,
  RESOLVE_INTENTS,
  TRASH_DIR_NAME,
  TRASH_ID_RE,
  TRASH_REASONS,
  UPLOAD_TEMP_SUFFIX,
  validateName,
  validateSegments,
} from "./fileManagerContract.js";
import { validateRemoteRootPath } from "./fileManagerRemoteRoots.js";
import {
  closeFileManagerSftpPools,
  getFileManagerSftpPool,
  getFileManagerSftpTimeouts,
  SFTP_STATUS,
  sftpInfo,
  toFmError,
} from "./fileManagerSftpPool.js";
import { acquireMirrorLock, resetRemoteConfigSession, SFTP_CONFIG_PATH_KEY } from "./remoteConfigFiles.js";

const log = createLogger("FileManager:SFTP");

// The PanelBridge folder on the remote host (panelBridgeSftp.js).
const BRIDGE_PATH_KEY = "panelBridgeSftpBridgePath";
// realPath/readlink hops before a chain of links counts as a loop.
const MAX_LINK_HOPS = 32;
// meta.json is a few hundred bytes; anything bigger isn't ours.
const TRASH_META_MAX_BYTES = 64 * 1024;
const TRASH_RETENTION_MS = FM_LIMITS.TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
// Duplicate: files only, at most 2 GiB (spec §A6.5).
const COPY_MAX_BYTES = 2 * 1024 * 1024 * 1024;
// An orphaned temp file (a dropped upload, a crashed save) is swept on the
// next write into its folder once it is this old by mtime. An upload still
// in flight keeps its mtime fresh.
const ORPHAN_TEMP_AGE_MS = 60 * 60 * 1000;
const ORPHAN_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
// Room left in a 255-byte name for ".", ".<hex8>" and the suffix.
const TEMP_NAME_STEM_MAX_BYTES = 180;
// How long a failed transfer waits for its remote handle to close.
const SINK_CLOSE_WAIT_MS = 2000;
// Lazy Trash retention removes at most this many entries per pass, so the
// request that notices a big expired item isn't held up by all of it; the
// rest goes on the next pass.
const EXPIRY_ENTRY_BUDGET = 1000;
// A Windows 8.3 short name (PANELB~1, SSH~1, ZCP-TR~1): on an NTFS-backed
// SFTP server it opens the long-named folder, so it would get past the
// protected-area and reserved-name rules, which match the long names.
const SHORT_NAME_RE = /^[^.~/\s]{1,6}~\d{1,6}(?:\.[^.\s/]{1,3})?$/i;

// Resolution acts on the link itself, never its target, when the LAST
// segment is a link and the intent changes the directory entry.
const LINK_SELF_INTENTS = new Set(["delete", "rename", "move"]);

const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

// ============================================
// Small helpers
// ============================================

function fmError(errorCode, params) {
  return new FmError(errorCode, undefined, params);
}

// True when `child` is `parent` or below it (normalized absolute POSIX).
function isInside(parent, child) {
  if (parent === child) return true;
  const prefix = parent === "/" ? "/" : `${parent}/`;
  return child.startsWith(prefix);
}

function joinRel(parentRel, name) {
  return parentRel ? `${parentRel}/${name}` : name;
}

function parentRel(rel) {
  const index = rel.lastIndexOf("/");
  return index === -1 ? "" : rel.slice(0, index);
}

function relativeTo(rootReal, abs) {
  return abs === rootReal ? "" : posix.relative(rootReal, abs);
}

function typeFromStat(st) {
  if (st.isDirectory) return "dir";
  if (st.isFile) return "file";
  if (st.isSymbolicLink) return "link";
  return "other";
}

function typeFromListChar(ch) {
  if (ch === "d") return "dir";
  if (ch === "-") return "file";
  if (ch === "l") return "link";
  return "other";
}

function toStat(st) {
  return {
    type: typeFromStat(st),
    size: Number(st.size) || 0,
    mtimeMs: Number(st.modifyTime) || 0,
    mode: typeof st.mode === "number" ? st.mode & 0o7777 : null,
    dev: null,
    ino: null,
    uid: Number.isInteger(st.uid) ? st.uid : null,
    gid: Number.isInteger(st.gid) ? st.gid : null,
  };
}

// A raw READDIR entry ({ filename, longname, attrs }) in the shape
// ssh2-sftp-client's list() gives.
function listEntryOf(item) {
  const attrs = item?.attrs || {};
  const longname = typeof item?.longname === "string" ? item.longname : "";
  let type = longname.slice(0, 1);
  if (!["d", "-", "l"].includes(type) && typeof attrs.mode === "number") {
    const fmt = attrs.mode & 0o170000;
    type = fmt === 0o040000 ? "d" : fmt === 0o100000 ? "-" : fmt === 0o120000 ? "l" : "?";
  }
  return {
    type,
    name: item?.filename,
    size: attrs.size,
    modifyTime: (Number(attrs.mtime) || 0) * 1000,
    longname,
    owner: attrs.uid,
    group: attrs.gid,
  };
}

// What a refused WRITE looks like (ssh2 swallows the server's status on its
// already-destroyed stream, so only the byte count tells).
function writeRefused() {
  return toFmError(Object.assign(new Error("The server refused a write (Failure)"), { code: SFTP_STATUS.FAILURE }));
}

// Permission bits from an ls-style longname ("-rwxr-xr-x 1 ..."), which is
// all ssh2-sftp-client's list() keeps of the mode.
function modeFromLongname(longname) {
  if (typeof longname !== "string" || longname.length < 10) return null;
  const p = longname.slice(1, 10);
  if (!/^[r-][w-][xsS-][r-][w-][xsS-][r-][w-][xtT-]$/.test(p)) return null;
  let mode = 0;
  const triads = [
    [0, 0o400, 0o200, 0o100, 0o4000, "sS"],
    [3, 0o040, 0o020, 0o010, 0o2000, "sS"],
    [6, 0o004, 0o002, 0o001, 0o1000, "tT"],
  ];
  for (const [at, r, w, x, special, specialChars] of triads) {
    if (p[at] === "r") mode |= r;
    if (p[at + 1] === "w") mode |= w;
    const exec = p[at + 2];
    if (exec === "x" || exec === specialChars[0]) mode |= x;
    if (specialChars.includes(exec)) mode |= special;
  }
  return mode;
}

function statEtag(size, mtimeMs) {
  return `s:${Number(size) || 0}-${Number(mtimeMs) || 0}`;
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Cut a UTF-8 string to at most maxBytes without splitting a character.
function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

function tempName(name, suffix) {
  return `.${truncateUtf8(name, TEMP_NAME_STEM_MAX_BYTES)}.${crypto.randomBytes(4).toString("hex")}${suffix}`;
}

function isPanelTempName(name) {
  const lower = name.toLowerCase();
  return lower.endsWith(UPLOAD_TEMP_SUFFIX) || lower.endsWith(RENAME_TEMP_SUFFIX);
}

// Listings leave out Trash folders (the root's own at the top; a deeper one
// belongs to a nested root) and the panel's temp files.
function isOmitted(name) {
  return name.toLowerCase() === TRASH_DIR_NAME || isPanelTempName(name);
}

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

function newTrashId(date) {
  const stamp =
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return `${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

// Milliseconds encoded in a trashId (UTC), or NaN.
function trashIdTime(trashId) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(trashId);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function checkNewName(name) {
  const checked = validateName(name, { isNew: true });
  if (!checked.ok) throw fmError(ErrorCode.FM_INVALID_NAME, { reason: checked.reason });
  return checked.name;
}

function assertRoot(root) {
  if (!root || root.available === false || typeof root.real !== "string" || !root.real.startsWith("/")) {
    throw new FmError(ErrorCode.FM_ROOT_UNAVAILABLE, undefined, {
      reason: root?.unavailableReason || "sftpUnreachable",
    });
  }
}

function assertResolved(r) {
  if (!r || typeof r.abs !== "string" || !r.abs.startsWith("/") || typeof r.rel !== "string" || typeof r.realRel !== "string") {
    throw new FmError(ErrorCode.FM_INTERNAL);
  }
}

// A Resolved carries abs and realRel, and abs is always
// posix.join(root.real, realRel), so the root's real path falls out of them.
function rootRealOf(r) {
  assertResolved(r);
  if (r.realRel === "") return r.abs;
  const suffix = `/${r.realRel}`;
  if (!r.abs.endsWith(suffix)) throw new FmError(ErrorCode.FM_INTERNAL);
  return r.abs.slice(0, -suffix.length) || "/";
}

function assertDirectory(r) {
  if (r.isNew) throw fmError(ErrorCode.FM_NOT_FOUND);
  if (!r.stat || r.stat.type !== "dir") throw fmError(ErrorCode.FM_NOT_A_DIRECTORY);
}

function assertNotRoot(r) {
  if (r.realRel === "" || r.rel === "") throw fmError(ErrorCode.FM_ROOT_IMMUTABLE);
}

function isCode(err, errorCode) {
  return err instanceof FmError && err.code === errorCode;
}

// Wraps a callback-style ssh2 SFTP call the library doesn't expose
// (readlink, an exclusive mkdir, a plain rmdir, statvfs).
function rawCall(client, method, ...args) {
  return new Promise((resolve, reject) => {
    const sftp = client.sftp;
    if (!sftp) {
      const err = new Error("No SFTP connection available");
      err.code = "ERR_NOT_CONNECTED";
      reject(err);
      return;
    }
    try {
      sftp[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
    } catch (err) {
      reject(err);
    }
  });
}

// statvfs fields arrive as numbers or BigInts depending on ssh2's options.
function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ============================================
// Module-level caches (backends are cheap and may be made per request)
// ============================================

// meta.json of a Trash item never changes once written.
const TRASH_META_CACHE_MAX = 5000;
const trashMetaCache = new Map();
// When a folder was last swept for orphaned temp files.
const ORPHAN_SWEEP_CACHE_MAX = 2000;
const orphanSweeps = new Map();
// realPath() of the remote config and bridge folders, per pool.
const configRealCache = new Map();
// Trash items lazy retention removed, per pool and root, until the service
// drains them into a files.trash.expire audit row.
const expiredByRoot = new Map();
const EXPIRED_KEEP_MAX = 1000;

function remember(map, key, value, max) {
  if (map.size >= max && !map.has(key)) map.delete(map.keys().next().value);
  map.set(key, value);
}

function sanitizeTrashMeta(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  const checked = validateSegments(raw.originalPath);
  if (!checked.ok || checked.segments.length === 0) return null;
  if (raw.type !== "file" && raw.type !== "dir") return null;
  if (!TRASH_REASONS.includes(raw.reason)) return null;
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  const deletedAt =
    typeof raw.deletedAt === "string" && raw.deletedAt.length <= 40 && !Number.isNaN(Date.parse(raw.deletedAt))
      ? new Date(Date.parse(raw.deletedAt)).toISOString()
      : null;
  const who = raw.deletedBy && typeof raw.deletedBy === "object" ? raw.deletedBy : {};
  const text = (value) => (typeof value === "string" ? value.slice(0, 128) : null);
  return {
    v: 1,
    originalPath: checked.segments.join("/"),
    type: raw.type,
    bytes: count(raw.bytes),
    files: count(raw.files),
    deletedAt,
    deletedBy: { userId: text(who.userId), username: text(who.username) },
    reason: raw.reason,
  };
}

// ============================================
// Streams
// ============================================

// Wrap an SFTP read stream so a read that gets no bytes for the transfer
// idle limit fails with FM_SFTP_TIMEOUT. The clock only runs while the
// consumer is asking for data: a slow browser download is not an SFTP stall.
function guardIdleRead(source, lease) {
  const idleMs = getFileManagerSftpTimeouts().transferIdleMs;
  let timer = null;
  let stalled = false;
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    disarm();
    timer = setTimeout(() => {
      stalled = true;
      out.destroy(new FmError(ErrorCode.FM_SFTP_TIMEOUT));
    }, idleMs);
    timer.unref?.();
  };
  const out = new Readable({
    read() {
      arm();
      source.resume();
    },
    destroy(err, callback) {
      disarm();
      source.destroy();
      if (stalled || sftpInfo(err)?.connectionLost) lease.discard();
      else lease.release();
      callback(err);
    },
  });
  source.on("data", (chunk) => {
    disarm();
    if (out.push(chunk)) arm();
    else source.pause();
  });
  let ended = false;
  source.on("end", () => {
    ended = true;
    disarm();
    out.push(null);
  });
  source.on("error", (err) => out.destroy(toFmError(err)));
  // A handle closed under us (the connection went) without an error.
  source.on("close", () => {
    if (!ended && !out.destroyed) {
      const err = new Error("SFTP read closed early");
      err.code = "ECONNRESET";
      out.destroy(toFmError(err));
    }
  });
  source.pause();
  return out;
}

// Resolve once an ssh2 read stream's remote OPEN succeeded; reject with its
// error, or FM_SFTP_TIMEOUT after `ms`.
function waitForOpen(stream, ms) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("open", onOpen);
      stream.off("ready", onOpen);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      const err = new Error("SFTP read closed before it opened");
      err.code = "ECONNRESET";
      reject(err);
    };
    if (stream.handle || stream.pending === false) {
      resolve();
      return;
    }
    timer = setTimeout(() => {
      cleanup();
      reject(new FmError(ErrorCode.FM_SFTP_TIMEOUT));
    }, ms);
    timer.unref?.();
    stream.once("open", onOpen);
    stream.once("ready", onOpen);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

// Copy `source` into a new remote file at tmpAbs on the leased connection,
// counting and hashing on the way. Resolves once the remote handle is
// closed. Fails with FM_UPLOAD_SIZE_MISMATCH when the bytes run over
// declaredSize or maxBytes or stop short, and aborts after the transfer idle
// limit with no progress: FM_SFTP_TIMEOUT when the SFTP side is the one not
// accepting data (or `remoteSource`), FM_UPLOAD_SIZE_MISMATCH when the
// sender went quiet. The lease is always released or discarded.
//
// The source is never destroyed here unless it is our own (remoteSource):
// an HTTP request must stay open until the route has sent its response.
function streamIntoRemote(lease, source, tmpAbs, { declaredSize, maxBytes, remoteSource = false, mode = 0o600 }) {
  return new Promise((resolve, reject) => {
    const idleMs = getFileManagerSftpTimeouts().transferIdleMs;
    const hash = crypto.createHash("sha256");
    let received = 0;
    let settled = false;
    let sourceEnded = false;
    let endCalled = false;
    let waitingOnSink = false;
    let timer = null;
    let sink;
    try {
      // Created with its final mode: a host that refuses SETSTAT leaves the
      // mode the OPEN asked for, and 0600 would lock the game user out.
      sink = lease.client.createWriteStream(tmpAbs, { flags: "wx", mode });
    } catch (err) {
      lease.release();
      if (remoteSource) source.destroy();
      reject(toFmError(err));
      return;
    }

    const detach = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      source.off("data", onData);
      source.off("end", onEnd);
      source.off("error", onSourceError);
      source.off("close", onSourceClose);
      sink.off("drain", onDrain);
      sink.off("error", onSinkError);
      sink.off("close", onSinkClose);
    };
    const fail = (err, { discard = false } = {}) => {
      if (settled) return;
      settled = true;
      detach();
      if (remoteSource) source.destroy();
      else if (typeof source.pause === "function") source.pause();
      // A late error from the half-open handle has nowhere to go.
      sink.on("error", () => {});
      // Wait (briefly) for the remote handle to close, so the caller's
      // unlink of the temp file can't overtake the open that created it.
      const closed = new Promise((resolveClosed) => {
        if (sink.closed) {
          resolveClosed();
          return;
        }
        const wait = setTimeout(resolveClosed, SINK_CLOSE_WAIT_MS);
        wait.unref?.();
        sink.once("close", () => {
          clearTimeout(wait);
          resolveClosed();
        });
      });
      sink.destroy();
      closed.then(() => {
        if (discard) lease.discard();
        else lease.release();
        reject(err);
      });
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const remoteStall = remoteSource || waitingOnSink || sourceEnded;
        fail(new FmError(remoteStall ? ErrorCode.FM_SFTP_TIMEOUT : ErrorCode.FM_UPLOAD_SIZE_MISMATCH), {
          discard: remoteStall,
        });
      }, idleMs);
      timer.unref?.();
    };
    const onData = (chunk) => {
      received += chunk.length;
      if (received > declaredSize || received > maxBytes) {
        fail(new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH));
        return;
      }
      hash.update(chunk);
      arm();
      if (!sink.write(chunk)) {
        waitingOnSink = true;
        source.pause();
      }
    };
    const onDrain = () => {
      waitingOnSink = false;
      arm();
      if (!settled && !sourceEnded) source.resume();
    };
    const onEnd = () => {
      sourceEnded = true;
      if (received !== declaredSize) {
        fail(new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH));
        return;
      }
      arm();
      endCalled = true;
      sink.end();
    };
    const onSourceError = (err) => {
      fail(remoteSource ? toFmError(err) : new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH), {
        discard: remoteSource && Boolean(sftpInfo(toFmError(err))?.connectionLost),
      });
    };
    const onSourceClose = () => {
      if (!sourceEnded) fail(new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH));
    };
    const onSinkError = (err) => {
      const mapped = toFmError(err);
      fail(mapped, { discard: Boolean(sftpInfo(mapped)?.connectionLost) });
    };
    // ssh2's WriteStream never emits 'finish' (its _final closes the handle
    // first, so writableFinished stays false): the handle closing after
    // end() is how a transfer completes. A WRITE the server refused (a full
    // disk, a quota) ends the same way, its error dropped on the destroyed
    // stream, so the bytes the server acknowledged decide.
    const onSinkClose = () => {
      if (settled) return;
      if (!endCalled) {
        fail(sourceEnded ? new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH) : writeRefused());
        return;
      }
      const acknowledged = typeof sink.bytesWritten === "number" ? sink.bytesWritten : received;
      if (acknowledged !== received) {
        fail(writeRefused());
        return;
      }
      settled = true;
      detach();
      lease.release();
      resolve({ sha256: hash.digest("hex"), received });
    };

    source.on("data", onData);
    source.on("end", onEnd);
    source.on("error", onSourceError);
    source.on("close", onSourceClose);
    sink.on("drain", onDrain);
    sink.on("error", onSinkError);
    sink.on("close", onSinkClose);
    arm();
    if (typeof source.resume === "function") source.resume();
  });
}

// ============================================
// The backend
// ============================================

/**
 * Create a FileBackend (spec §A13) for the SFTP login in `settings`.
 * Cheap: connections come from the shared pool, opened on first use.
 *
 * Beyond the interface it exposes `remote` ({host, port, username}, never
 * the password), copyFile() takes an optional 4th argument
 * `{ overwrite, trashMeta }` for a duplicate that replaces an existing file
 * (spec §A8's `overwrite` token), and describeRoot() adds `bridgeReal`: the
 * server's real path of the PanelBridge folder, or null.
 *
 * @param {{ settings: Record<string, unknown>, root?: unknown }} args
 *   `root` is accepted for the service's convenience and unused: every
 *   method takes the root it acts on.
 * @returns {import("./fileManagerContract.js").FileBackend & { remote: { host: string, port: number, username: string } }}
 * @throws {FmError} FM_ROOT_UNAVAILABLE {reason:"remoteNotConfigured"} without a usable SFTP login
 */
export function createSftpBackend({ settings } = {}) {
  const pool = getFileManagerSftpPool(settings);
  const settingPath = (key) => {
    try {
      return validateRemoteRootPath(settings?.[key], { allowSlash: true });
    } catch {
      return null;
    }
  };
  const configPath = settingPath(SFTP_CONFIG_PATH_KEY);
  const bridgePath = settingPath(BRIDGE_PATH_KEY);

  // ---- SFTP primitives: each one is a pool call under the 20 s limit;
  // reads may be retried once on a dropped connection, writes never.

  const read = (fn) => pool.run(fn, { retry: true });
  const write = (fn) => pool.run(fn);

  async function lstatOrNull(abs) {
    try {
      return toStat(await read((c) => c.lstat(abs)));
    } catch (err) {
      if (isCode(err, ErrorCode.FM_NOT_FOUND)) return null;
      throw err;
    }
  }

  async function lstat(abs) {
    return toStat(await read((c) => c.lstat(abs)));
  }

  async function statFollow(abs) {
    return toStat(await read((c) => c.stat(abs)));
  }

  // "" from the library means the path doesn't exist.
  async function realPathOrNull(abs) {
    const real = await read((c) => c.realPath(abs));
    return typeof real === "string" && real.startsWith("/") ? posix.normalize(real) : null;
  }

  function readlink(abs) {
    return read((c) => rawCall(c, "readlink", abs));
  }

  // One READDIR round trip at a time, each under the operation timeout: a
  // folder of tens of thousands of entries over a slow link no longer has
  // to fit in one 20 s budget (and a slow listing no longer times out the
  // shared metadata connection for everyone). OpenSSH sends about 100 names
  // per reply. The OPENDIR is a read (retried once on a dropped pooled
  // connection); the READDIRs must stay on the connection that opened it.
  // Only EOF ends a listing: ssh2 left to itself drops "." and ".." from
  // each reply, so a reply holding just those two came back empty and read
  // as the end of the folder (`full` keeps them, and they are dropped here).
  async function listDir(abs) {
    const handle = await read((c) => rawCall(c, "opendir", abs));
    const out = [];
    try {
      for (;;) {
        let batch;
        try {
          batch = await write((c) => rawCall(c, "readdir", handle, { full: true }));
        } catch (err) {
          if (sftpInfo(err)?.status === SFTP_STATUS.EOF) break;
          throw err;
        }
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const item of batch) {
          if (item?.filename !== "." && item?.filename !== "..") out.push(listEntryOf(item));
        }
        if (out.length > FM_LIMITS.LIST_DIR_MAX_ENTRIES + 2) break;
      }
    } finally {
      await write((c) => rawCall(c, "close", handle)).catch(() => {});
    }
    return out;
  }

  async function readRange(abs, start, length) {
    if (length <= 0) return Buffer.alloc(0);
    const data = await read((c) =>
      c.get(abs, undefined, { readStreamOptions: { start, end: start + length - 1 } }),
    );
    return Buffer.isBuffer(data) ? data : Buffer.from(data ?? "");
  }

  // put() resolves once the remote handle closes, even when the server
  // refused a WRITE (ssh2 drops that status on its destroyed stream): a
  // full disk would leave an empty file behind a "successful" save. So the
  // size that landed is checked, and a short file removed and refused.
  async function putNew(abs, buffer, mode) {
    await write((c) => c.put(buffer, abs, { writeStreamOptions: { flags: "wx", mode } }));
    const st = await lstatOrNull(abs);
    if (!st || st.type !== "file" || st.size !== buffer.length) {
      await removeQuietly(abs);
      throw writeRefused();
    }
    return st;
  }

  function renameEntry(from, to) {
    return write((c) => c.rename(from, to));
  }

  function unlink(abs) {
    return write((c) => c.delete(abs));
  }

  function mkdirExclusive(abs, mode) {
    return write((c) => rawCall(c, "mkdir", abs, { mode }));
  }

  function rmdirEmpty(abs) {
    return write((c) => rawCall(c, "rmdir", abs));
  }

  async function chmodQuietly(abs, mode) {
    try {
      await write((c) => c.chmod(abs, mode));
    } catch (err) {
      // Some hosts refuse SETSTAT; the file keeps the server's default mode.
      log.debug(`SFTP chmod refused: ${err.code}`);
    }
  }

  // Give a temp file the owner of what it replaces (or of its folder): a
  // root (or shared-group) SFTP login would otherwise hand the game's own
  // files to itself, and a 0600/0640 ini would lock the game user out.
  // Refused (the login can't chown) is fine: nothing changes.
  async function matchOwner(abs, current, wanted) {
    if (!wanted || !Number.isInteger(wanted.uid) || !Number.isInteger(wanted.gid)) return;
    if (current && current.uid === wanted.uid && current.gid === wanted.gid) return;
    try {
      await write((c) => rawCall(c, "setstat", abs, { uid: wanted.uid, gid: wanted.gid }));
    } catch (err) {
      log.debug(`SFTP chown refused: ${err.code}`);
    }
  }

  async function removeQuietly(abs) {
    try {
      await unlink(abs);
    } catch {
      /* already gone, or the next orphan sweep takes it */
    }
  }

  async function renameQuietly(from, to) {
    try {
      await renameEntry(from, to);
      return true;
    } catch {
      return false;
    }
  }

  // Replace `target` with `tmp` in one step when the server has
  // posix-rename@openssh.com; otherwise move the target aside, rename tmp
  // into place and delete the old copy, putting it back if the second step
  // fails (spec §A12 text save).
  //
  // An older OpenSSH whose admin denied the extension (`sftp-server -P
  // posix-rename`) still offers it, and answers PERMISSION_DENIED; newer
  // ones stop offering it. A refusal is tried the three-step way (a real
  // permission problem fails there the same way), and remembered only once
  // that worked.
  async function replaceWith(tmp, target) {
    let refused = false;
    if (pool.capabilities.posixRename !== false) {
      try {
        await write((c) => c.posixRename(tmp, target));
        pool.capabilities.posixRename = true;
        return;
      } catch (err) {
        if (sftpInfo(err)?.unsupported) pool.capabilities.posixRename = false;
        else if (isCode(err, ErrorCode.FM_OS_PERMISSION_DENIED)) refused = true;
        else throw err;
      }
    }
    const aside = posix.join(posix.dirname(target), tempName(posix.basename(target), RENAME_TEMP_SUFFIX));
    await renameEntry(target, aside);
    try {
      await renameEntry(tmp, target);
    } catch (err) {
      if (!(await renameQuietly(aside, target))) {
        log.warn("SFTP save could not put the previous version back after a failed rename; it is still in Trash");
      }
      throw err;
    }
    if (refused) pool.capabilities.posixRename = false;
    await removeQuietly(aside);
  }

  // A plain SFTP rename never replaces an existing target, so a lost race
  // lands as FM_EXISTS instead of an overwrite.
  async function landNew(tmp, target) {
    try {
      await renameEntry(tmp, target);
    } catch (err) {
      if (await lstatOrNull(target)) throw fmError(ErrorCode.FM_EXISTS, { name: posix.basename(target) });
      throw err;
    }
  }

  // ---- The remote config mirror (remoteConfigFiles.js) caches the
  // Server/ folder; a write under it serializes with the mirror and drops
  // its session so the config editor re-pulls.

  // The real path of a folder named in the settings, or null. OpenSSH's
  // REALPATH answers a missing last component with the path it would have,
  // so only a folder that exists is remembered: one that doesn't yet is
  // looked up again next time.
  async function settingRealPath(abs) {
    if (!abs) return null;
    const key = `${pool.id}|${abs}`;
    if (configRealCache.has(key)) return configRealCache.get(key);
    try {
      const real = await realPathOrNull(abs);
      if (real && (await lstatOrNull(real))?.type === "dir") remember(configRealCache, key, real, 100);
      return real;
    } catch {
      return null;
    }
  }

  async function touchesConfig(absPaths) {
    if (!configPath) return false;
    if (absPaths.some((abs) => isInside(configPath, abs))) return true;
    const real = await settingRealPath(configPath);
    return Boolean(real) && absPaths.some((abs) => isInside(real, abs));
  }

  async function guardConfig(absPaths, fn) {
    if (!(await touchesConfig(absPaths))) return fn();
    const release = await acquireMirrorLock();
    try {
      return await fn();
    } finally {
      resetRemoteConfigSession();
      release();
    }
  }

  // ---- Links

  // Follow the link at linkAbs (whose parent is already real and inside the
  // root) and return where it really lands, or throw FM_LINK_ESCAPES_ROOT /
  // FM_NOT_FOUND. `budget.hops` bounds chains and loops.
  async function followLink(rootReal, linkAbs, budget) {
    budget.hops -= 1;
    if (budget.hops < 0) throw fmError(ErrorCode.FM_NOT_FOUND);
    let real;
    try {
      real = await realPathOrNull(linkAbs);
    } catch (err) {
      // A link loop comes back from REALPATH as a bare FAILURE (ELOOP).
      if (err.code === ErrorCode.FM_SFTP_ERROR && sftpInfo(err)?.status === SFTP_STATUS.FAILURE) {
        throw fmError(ErrorCode.FM_NOT_FOUND);
      }
      throw err;
    }
    if (real === null) throw fmError(ErrorCode.FM_NOT_FOUND);
    if (real !== linkAbs) {
      if (!isInside(rootReal, real)) throw fmError(ErrorCode.FM_LINK_ESCAPES_ROOT);
      return { abs: real, stat: await lstat(real) };
    }
    // This server's REALPATH hands a link back unresolved: judge it by its
    // readlink() target instead, then walk that target from the root so a
    // link inside it is checked too.
    const target = await readlink(linkAbs);
    if (typeof target !== "string" || target === "") throw fmError(ErrorCode.FM_NOT_FOUND);
    const lexical = target.startsWith("/")
      ? posix.normalize(target)
      : posix.normalize(posix.join(posix.dirname(linkAbs), target));
    if (!isInside(rootReal, lexical)) throw fmError(ErrorCode.FM_LINK_ESCAPES_ROOT);
    const segments = lexical === rootReal ? [] : relativeTo(rootReal, lexical).split("/");
    let cur = rootReal;
    let stat = await statFollow(rootReal);
    for (let i = 0; i < segments.length; i++) {
      const p = posix.join(cur, segments[i]);
      let st = await lstatOrNull(p);
      if (!st) throw fmError(ErrorCode.FM_NOT_FOUND);
      if (st.type === "link") {
        const hop = await followLink(rootReal, p, budget);
        cur = hop.abs;
        st = hop.stat;
      } else {
        cur = p;
      }
      if (i < segments.length - 1 && st.type !== "dir") throw fmError(ErrorCode.FM_NOT_FOUND);
      stat = st;
    }
    return { abs: cur, stat };
  }

  // What a listing may say about a link: inside or not and what it points
  // at -- never where. A link leaving the root is not probed any further.
  async function describeLink(rootReal, linkAbs) {
    try {
      const target = await followLink(rootReal, linkAbs, { hops: MAX_LINK_HOPS });
      const targetType = target.stat.type === "dir" || target.stat.type === "file" ? target.stat.type : "unknown";
      return { link: { inside: true, targetType }, realRel: relativeTo(rootReal, target.abs) };
    } catch (err) {
      if (isCode(err, ErrorCode.FM_NOT_FOUND)) {
        let inside = false;
        try {
          const target = await readlink(linkAbs);
          const lexical = String(target).startsWith("/")
            ? posix.normalize(String(target))
            : posix.normalize(posix.join(posix.dirname(linkAbs), String(target)));
          inside = isInside(rootReal, lexical);
        } catch {
          inside = false;
        }
        return { link: { inside, targetType: "missing" }, realRel: null };
      }
      return { link: { inside: false, targetType: "unknown" }, realRel: null };
    }
  }

  function rawEntry(name, rel, realRel, st) {
    return {
      name,
      rel,
      realRel,
      type: st.type,
      size: st.type === "file" ? st.size : null,
      mtimeMs: st.mtimeMs || null,
      mode: st.mode,
      dev: null,
      ino: null,
      etag: st.type === "file" ? statEtag(st.size, st.mtimeMs) : null,
    };
  }

  async function entryAt(rootReal, rel, abs) {
    const st = await lstat(abs);
    const entry = rawEntry(posix.basename(rel), rel, relativeTo(rootReal, abs), st);
    if (st.type === "link") {
      const described = await describeLink(rootReal, abs);
      entry.link = described.link;
      entry.realRel = described.realRel;
    }
    return entry;
  }

  // The regular file a Resolved names, re-read now.
  async function currentFile(r) {
    if (r.isNew) throw fmError(ErrorCode.FM_NOT_FOUND);
    const st = await lstat(r.abs);
    if (st.type !== "file") throw fmError(ErrorCode.FM_NOT_A_FILE);
    return st;
  }

  // ---- Orphaned temp files

  async function sweepOrphans(dirAbs) {
    const key = `${pool.id}|${dirAbs}`;
    const last = orphanSweeps.get(key);
    if (last && Date.now() - last < ORPHAN_SWEEP_INTERVAL_MS) return;
    remember(orphanSweeps, key, Date.now(), ORPHAN_SWEEP_CACHE_MAX);
    try {
      const entries = await listDir(dirAbs);
      const cutoff = Date.now() - ORPHAN_TEMP_AGE_MS;
      for (const e of entries) {
        if (e.type !== "-" || !isPanelTempName(e.name) || !e.name.startsWith(".")) continue;
        if (Number(e.modifyTime) > cutoff) continue;
        await removeQuietly(posix.join(dirAbs, e.name));
      }
    } catch (err) {
      log.debug(`SFTP orphan sweep skipped: ${err.code}`);
    }
  }

  // ---- Trash (spec §A6.6): <root>/.zcp-trash/<trashId>/{meta.json, payload/<name>}

  function trashNotWritable() {
    return fmError(ErrorCode.FM_TRASH_UNAVAILABLE, { reason: "notWritable" });
  }

  // The root's Trash folder, created on first use. Anything but a real
  // folder there (a file, or a link someone planted to redirect deletions)
  // makes Trash unavailable rather than being followed.
  async function ensureTrashDir(rootReal) {
    const trashAbs = posix.join(rootReal, TRASH_DIR_NAME);
    let st = await lstatOrNull(trashAbs);
    if (!st) {
      try {
        await mkdirExclusive(trashAbs, 0o700);
      } catch {
        // Lost a race with another request, or not writable: look again.
      }
      st = await lstatOrNull(trashAbs);
    }
    if (!st || st.type !== "dir") throw trashNotWritable();
    return trashAbs;
  }

  function trashMetaKey(itemAbs) {
    return `${pool.id}|${itemAbs}`;
  }

  async function readTrashMeta(itemAbs) {
    const key = trashMetaKey(itemAbs);
    if (trashMetaCache.has(key)) return trashMetaCache.get(key);
    const metaAbs = posix.join(itemAbs, "meta.json");
    const st = await lstatOrNull(metaAbs);
    if (!st || st.type !== "file" || st.size > TRASH_META_MAX_BYTES) return null;
    let meta = null;
    try {
      meta = sanitizeTrashMeta(JSON.parse((await readRange(metaAbs, 0, st.size)).toString("utf8")));
    } catch {
      meta = null;
    }
    if (meta) remember(trashMetaCache, key, meta, TRASH_META_CACHE_MAX);
    return meta;
  }

  // Remove a whole tree without ever following a link: files and links are
  // unlinked, folders emptied then rmdir'ed. Never the library's recursive
  // rmdir, which trusts list() types and deletes in parallel.
  async function removeTree(abs, onProgress = () => {}, budget = null) {
    const top = await lstatOrNull(abs);
    if (!top) return 0;
    const counter = { done: 0, budget };
    await removeNode(abs, top.type, counter, onProgress);
    return counter.done;
  }

  async function removeNode(abs, type, counter, onProgress) {
    if (counter.done >= FM_LIMITS.PERMANENT_DELETE_MAX_ENTRIES) {
      throw new FmError(ErrorCode.FM_TOO_MANY_ENTRIES, undefined, { limit: FM_LIMITS.PERMANENT_DELETE_MAX_ENTRIES });
    }
    if (counter.budget) {
      if (counter.budget.left <= 0) throw Object.assign(new Error("budget spent"), { budgetSpent: true });
      counter.budget.left -= 1;
    }
    try {
      if (type === "dir") {
        const children = await listDir(abs);
        for (const child of children) {
          if (child.name === "." || child.name === "..") continue;
          await removeNode(posix.join(abs, child.name), typeFromListChar(child.type), counter, onProgress);
        }
        await rmdirEmpty(abs);
      } else {
        await unlink(abs);
      }
    } catch (err) {
      // Already gone (a concurrent delete) is as good as deleted.
      if (!isCode(err, ErrorCode.FM_NOT_FOUND)) throw err;
    }
    counter.done += 1;
    onProgress(counter.done, null);
  }

  // True when the whole tree is gone.
  async function removeTreeQuietly(abs, budget = null) {
    try {
      await removeTree(abs, () => {}, budget);
      return true;
    } catch (err) {
      if (!err?.budgetSpent) log.debug(`SFTP Trash cleanup left something behind: ${err.code}`);
      return false;
    }
  }

  // Remove an item past the retention period, and remember it for the
  // service's files.trash.expire audit row once it is completely gone.
  async function expireTrashItem(rootReal, trashAbs, trashId, budget) {
    const itemAbs = posix.join(trashAbs, trashId);
    const gone = await removeTreeQuietly(itemAbs, budget);
    trashMetaCache.delete(trashMetaKey(itemAbs));
    if (!gone) return;
    const key = `${pool.id}|${rootReal}`;
    const ids = expiredByRoot.get(key) || [];
    ids.push(trashId);
    remember(expiredByRoot, key, ids.slice(-EXPIRED_KEEP_MAX), 100);
  }

  // Make a Trash item with its meta.json and an empty payload/ folder.
  async function createTrashItem(rootReal, info) {
    const trashAbs = await ensureTrashDir(rootReal);
    const now = new Date();
    const trashId = newTrashId(now);
    const itemAbs = posix.join(trashAbs, trashId);
    const meta = {
      v: 1,
      originalPath: info.originalPath,
      type: info.type,
      bytes: info.bytes,
      files: info.files,
      deletedAt: now.toISOString(),
      deletedBy: {
        userId: info.deletedBy?.userId ?? null,
        username: info.deletedBy?.username ?? null,
      },
      reason: TRASH_REASONS.includes(info.reason) ? info.reason : "deleted",
    };
    try {
      await mkdirExclusive(itemAbs, 0o700);
      await mkdirExclusive(posix.join(itemAbs, "payload"), 0o700);
      await putNew(posix.join(itemAbs, "meta.json"), Buffer.from(JSON.stringify(meta)), 0o600);
    } catch (err) {
      await removeTreeQuietly(itemAbs);
      if (isCode(err, ErrorCode.FM_SFTP_TIMEOUT)) throw err;
      throw trashNotWritable();
    }
    remember(trashMetaCache, trashMetaKey(itemAbs), meta, TRASH_META_CACHE_MAX);
    return { trashId, itemAbs, payloadDir: posix.join(itemAbs, "payload") };
  }

  // Lazy retention for remote roots (spec §A6.6): whenever a root's Trash
  // is written, items past 7 days go, and a file keeps at most 20 edited
  // versions. Best effort: a failure here never fails the write.
  async function pruneTrash(rootReal, { originalPath, reason }) {
    try {
      const trashAbs = posix.join(rootReal, TRASH_DIR_NAME);
      const entries = await listDir(trashAbs);
      const now = Date.now();
      const versions = [];
      const budget = { left: EXPIRY_ENTRY_BUDGET };
      for (const e of entries) {
        if (e.type !== "d" || !TRASH_ID_RE.test(e.name)) continue;
        const itemAbs = posix.join(trashAbs, e.name);
        if (now - trashIdTime(e.name) > TRASH_RETENTION_MS) {
          if (budget.left > 0) await expireTrashItem(rootReal, trashAbs, e.name, budget);
          continue;
        }
        if (reason !== "edited") continue;
        const meta = await readTrashMeta(itemAbs);
        if (meta && meta.reason === "edited" && meta.originalPath === originalPath) {
          versions.push({ trashId: e.name, at: Date.parse(meta.deletedAt) || trashIdTime(e.name) });
        }
      }
      // Newest first; trashIds only carry whole seconds, so the ms-precise
      // deletedAt orders saves made within the same second.
      versions.sort((a, b) => b.at - a.at || (a.trashId < b.trashId ? 1 : -1));
      for (const { trashId } of versions.slice(FM_LIMITS.TRASH_VERSIONS_PER_FILE)) {
        const itemAbs = posix.join(trashAbs, trashId);
        await removeTreeQuietly(itemAbs);
        trashMetaCache.delete(trashMetaKey(itemAbs));
      }
    } catch (err) {
      log.debug(`SFTP Trash retention skipped: ${err.code}`);
    }
  }

  // Rename the entry at abs into a new Trash item. SFTP reports a
  // cross-device rename (and little else, for a fresh target name) as a
  // bare FAILURE, so that is what FAILURE means here.
  async function moveIntoTrash(rootReal, abs, info, { prune = true } = {}) {
    const item = await createTrashItem(rootReal, info);
    try {
      await renameEntry(abs, posix.join(item.payloadDir, posix.basename(abs)));
    } catch (err) {
      await removeTreeQuietly(item.itemAbs);
      trashMetaCache.delete(trashMetaKey(item.itemAbs));
      if (err.code === ErrorCode.FM_SFTP_ERROR && sftpInfo(err)?.status === SFTP_STATUS.FAILURE) {
        throw fmError(ErrorCode.FM_TRASH_UNAVAILABLE, { reason: "crossDevice" });
      }
      throw err;
    }
    if (prune) await pruneTrash(rootReal, info);
    return item.trashId;
  }

  // Put a copy of `bytes` (the version being replaced) into a new Trash item.
  async function copyIntoTrash(rootReal, name, bytes, mode, info) {
    const item = await createTrashItem(rootReal, info);
    try {
      await putNew(posix.join(item.payloadDir, name), bytes, mode ?? 0o600);
      if (mode !== null) await chmodQuietly(posix.join(item.payloadDir, name), mode);
    } catch (err) {
      await removeTreeQuietly(item.itemAbs);
      trashMetaCache.delete(trashMetaKey(item.itemAbs));
      if (isCode(err, ErrorCode.FM_SFTP_TIMEOUT)) throw err;
      throw trashNotWritable();
    }
    await pruneTrash(rootReal, info);
    return item.trashId;
  }

  // Drop the "edited" version of a save that didn't happen, so retries of a
  // failing save can't push real versions out of the 20 kept per file.
  async function discardTrashItem(rootReal, trashId) {
    const itemAbs = posix.join(rootReal, TRASH_DIR_NAME, trashId);
    await removeTreeQuietly(itemAbs);
    trashMetaCache.delete(trashMetaKey(itemAbs));
  }

  // Undo moveIntoTrash(): the payload goes back to `target` and the item is
  // removed. Used when the step after a replace fails.
  async function putBackFromTrash(rootReal, trashId, target) {
    const itemAbs = posix.join(rootReal, TRASH_DIR_NAME, trashId);
    const restored = await renameQuietly(posix.join(itemAbs, "payload", posix.basename(target)), target);
    if (!restored) {
      log.warn("SFTP replace failed and the previous file could not be put back; it is still in Trash");
      return;
    }
    await removeTreeQuietly(itemAbs);
    trashMetaCache.delete(trashMetaKey(itemAbs));
  }

  // Refuse unless `existing` is what an upload or duplicate may land on.
  function checkReplaceable(existing, overwriteEtag, name) {
    if (overwriteEtag === null || overwriteEtag === undefined) {
      if (existing) throw fmError(ErrorCode.FM_EXISTS, { name });
      return;
    }
    if (!existing) throw fmError(ErrorCode.FM_CONFLICT, { currentEtag: null });
    if (existing.type !== "file") throw fmError(ErrorCode.FM_NOT_A_FILE);
    const current = statEtag(existing.size, existing.mtimeMs);
    if (current !== overwriteEtag) throw fmError(ErrorCode.FM_CONFLICT, { currentEtag: current });
  }

  // Land a finished temp file at target: new, or replacing `existing`
  // (which goes to Trash first, and comes back if the final rename fails).
  // Trash retention runs only once the new file is in place: pruning a big
  // expired item first would leave the live file missing all that time.
  async function landTemp(rootReal, tmp, target, originalPath, existing, trashInfo) {
    if (!existing) {
      await landNew(tmp, target);
      return null;
    }
    const info = { ...trashInfo, originalPath, type: "file", bytes: existing.size, files: 1 };
    const trashId = await moveIntoTrash(rootReal, target, info, { prune: false });
    try {
      await renameEntry(tmp, target);
    } catch (err) {
      await putBackFromTrash(rootReal, trashId, target);
      throw err;
    }
    await pruneTrash(rootReal, info);
    return trashId;
  }

  // ============================================
  // FileBackend methods
  // ============================================

  async function describeRoot(spec) {
    const base = {
      id: spec?.id,
      backend: "sftp",
      displayPath: typeof spec?.path === "string" ? spec.path : null,
      writable: null,
      freeBytes: null,
      totalBytes: null,
      warnings: Array.isArray(spec?.warnings) ? [...spec.warnings] : [],
      trashItemCount: null,
      real: null,
    };
    const unavailable = (reason, detail) => ({
      ...base,
      available: false,
      unavailableReason: reason,
      ...(detail ? { unavailableDetail: detail } : {}),
    });
    if (spec?.unavailable) return unavailable(spec.unavailable.reason, spec.unavailable.detail);
    if (typeof spec?.path !== "string" || !spec.path.startsWith("/")) return unavailable("notConfigured");

    let real;
    let st;
    try {
      real = await realPathOrNull(spec.path);
      if (!real) return unavailable("missing");
      st = await statFollow(real);
    } catch (err) {
      if (isCode(err, ErrorCode.FM_NOT_FOUND)) return unavailable("missing");
      if (isCode(err, ErrorCode.FM_OS_PERMISSION_DENIED)) return unavailable("unreadable", "EACCES");
      if (isCode(err, ErrorCode.FM_SFTP_TIMEOUT)) return unavailable("sftpUnreachable", "SFTP_TIMEOUT");
      if (isCode(err, ErrorCode.FM_ROOT_UNAVAILABLE)) return unavailable("sftpUnreachable");
      return unavailable("sftpUnreachable", err.params?.sftpCode);
    }
    if (st.type !== "dir") return unavailable("missing");

    // Where the bridge folder really is: the settings may reach it through
    // a link the root's real path went past, and the service matches the
    // protected folder against this as well as the settings' spelling.
    const bridgeReal = await settingRealPath(bridgePath);
    const descriptor = { ...base, available: true, real, bridgeReal };
    try {
      const space = await freeSpace({ available: true, real });
      descriptor.freeBytes = space.free;
      descriptor.totalBytes = space.total;
    } catch {
      /* free space is optional */
    }
    try {
      const trashAbs = posix.join(real, TRASH_DIR_NAME);
      const trashSt = await lstatOrNull(trashAbs);
      descriptor.trashItemCount =
        trashSt && trashSt.type === "dir"
          ? (await listDir(trashAbs)).filter((e) => e.type === "d" && TRASH_ID_RE.test(e.name)).length
          : 0;
    } catch {
      descriptor.trashItemCount = null;
    }
    return descriptor;
  }

  async function resolve(root, segments, intent) {
    assertRoot(root);
    if (!RESOLVE_INTENTS.includes(intent)) throw fmError(ErrorCode.FM_INVALID_REQUEST, { field: "intent" });
    const checked = validateSegments(Array.isArray(segments) ? segments.join("/") : null);
    if (!checked.ok) throw fmError(ErrorCode.FM_INVALID_PATH, { reason: checked.reason });
    const segs = checked.segments;
    // The Trash and in-flight temp files are panel-owned: never reachable
    // through the ordinary routes.
    if (segs.some((s) => s.toLowerCase() === TRASH_DIR_NAME)) throw fmError(ErrorCode.FM_NOT_FOUND);
    if (segs.some(isPanelTempName)) throw fmError(ErrorCode.FM_NOT_FOUND);
    // Remote names are never canonicalised (no realpath per component), so
    // a Windows short name would reach the Trash, the bridge folder or .ssh
    // under a spelling no rule matches: refused like a missing entry.
    if (segs.some((seg) => SHORT_NAME_RE.test(seg))) throw fmError(ErrorCode.FM_NOT_FOUND);

    const rootReal = root.real;
    const budget = { hops: MAX_LINK_HOPS };
    // The name as navigated, and whether the last segment is a link acted
    // on as itself: the service reads both off every Resolved, as it does
    // from the local backend's.
    const name = segs.length ? segs[segs.length - 1] : "";
    let linkSelf = false;
    let cur = rootReal;
    let stat = segs.length === 0 ? await statFollow(rootReal) : null;
    for (let i = 0; i < segs.length; i++) {
      const last = i === segs.length - 1;
      const p = posix.join(cur, segs[i]);
      let st = await lstatOrNull(p);
      if (!st) {
        if (last && intent === "create") {
          return {
            rootId: root.id,
            rel: segs.join("/"),
            realRel: relativeTo(rootReal, p),
            abs: p,
            isNew: true,
            stat: null,
            protection: null,
            worldState: false,
            name,
            linkSelf: false,
          };
        }
        throw fmError(ErrorCode.FM_NOT_FOUND);
      }
      if (st.type === "link" && !(last && LINK_SELF_INTENTS.has(intent))) {
        const target = await followLink(rootReal, p, budget);
        cur = target.abs;
        st = target.stat;
      } else {
        if (st.type === "link") linkSelf = true;
        cur = p;
      }
      if (!last && st.type !== "dir") throw fmError(ErrorCode.FM_NOT_A_DIRECTORY);
      stat = st;
    }
    const realRel = relativeTo(rootReal, cur);
    if (realRel.split("/").some((s) => s.toLowerCase() === TRASH_DIR_NAME)) throw fmError(ErrorCode.FM_NOT_FOUND);
    return {
      rootId: root.id,
      rel: segs.join("/"),
      realRel,
      abs: cur,
      isNew: false,
      stat,
      protection: null,
      worldState: false,
      name,
      linkSelf,
    };
  }

  // One segment below a folder resolve() already checked: the same rules as
  // resolve()'s last step, in one round trip instead of one per level from
  // the root (a folder upload checks hundreds of files in one folder).
  async function resolveChild(root, parent, name, intent) {
    assertRoot(root);
    assertResolved(parent);
    assertDirectory(parent);
    if (!RESOLVE_INTENTS.includes(intent)) throw fmError(ErrorCode.FM_INVALID_REQUEST, { field: "intent" });
    const checked = validateSegments(name);
    if (!checked.ok || checked.segments.length !== 1) throw fmError(ErrorCode.FM_INVALID_PATH, { reason: checked.ok ? "slash" : checked.reason });
    if (name.toLowerCase() === TRASH_DIR_NAME || isPanelTempName(name) || SHORT_NAME_RE.test(name)) {
      throw fmError(ErrorCode.FM_NOT_FOUND);
    }
    const rootReal = root.real;
    const rel = joinRel(parent.rel, name);
    const p = posix.join(parent.abs, name);
    let st = await lstatOrNull(p);
    if (!st) {
      if (intent !== "create") throw fmError(ErrorCode.FM_NOT_FOUND);
      return { rootId: root.id, rel, realRel: relativeTo(rootReal, p), abs: p, isNew: true, stat: null, protection: null, worldState: false, name, linkSelf: false };
    }
    let cur = p;
    let linkSelf = false;
    if (st.type === "link" && !LINK_SELF_INTENTS.has(intent)) {
      const target = await followLink(rootReal, p, { hops: MAX_LINK_HOPS });
      cur = target.abs;
      st = target.stat;
    } else if (st.type === "link") {
      linkSelf = true;
    }
    const realRel = relativeTo(rootReal, cur);
    if (realRel.split("/").some((seg) => seg.toLowerCase() === TRASH_DIR_NAME)) throw fmError(ErrorCode.FM_NOT_FOUND);
    return { rootId: root.id, rel, realRel, abs: cur, isNew: false, stat: st, protection: null, worldState: false, name, linkSelf };
  }

  async function list(dir, { offset = 0, limit = FM_LIMITS.LIST_PAGE_DEFAULT, sort = "name", order = "asc" } = {}) {
    assertResolved(dir);
    assertDirectory(dir);
    const rootReal = rootRealOf(dir);
    let raw = await listDir(dir.abs);
    const truncated = raw.length > FM_LIMITS.LIST_DIR_MAX_ENTRIES;
    if (truncated) raw = raw.slice(0, FM_LIMITS.LIST_DIR_MAX_ENTRIES);
    const visible = raw.filter((e) => e.name !== "." && e.name !== ".." && !isOmitted(e.name));

    // Folders change mtime only to the second over SFTP, so the names join
    // the mtime in the folder's etag.
    const names = visible.map((e) => e.name).sort();
    const dirEtag = `d:${dir.stat.mtimeMs}-${names.length}-${crypto
      .createHash("sha256")
      .update(names.join("\0"))
      .digest("hex")
      .slice(0, 16)}`;

    const sortLimited = visible.length > FM_LIMITS.LIST_FULL_STAT_MAX;
    const direction = order === "desc" ? -1 : 1;
    const byName = (a, b) => COLLATOR.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (sortLimited) {
      visible.sort((a, b) => direction * byName(a, b));
    } else {
      const key = (e) => (sort === "size" ? Number(e.size) || 0 : sort === "modified" ? Number(e.modifyTime) || 0 : 0);
      visible.sort((a, b) => {
        const aDir = a.type === "d";
        const bDir = b.type === "d";
        if (aDir !== bDir) return aDir ? -1 : 1;
        const primary = sort === "size" || sort === "modified" ? key(a) - key(b) : 0;
        return direction * (primary || byName(a, b));
      });
    }

    const start = Math.max(0, Math.floor(Number(offset)) || 0);
    const count = Math.max(0, Math.min(FM_LIMITS.LIST_PAGE_MAX, Math.floor(Number(limit)) || FM_LIMITS.LIST_PAGE_DEFAULT));
    const entries = [];
    for (const e of visible.slice(start, start + count)) {
      const type = typeFromListChar(e.type);
      const mtimeMs = Number(e.modifyTime) || 0;
      const entry = rawEntry(e.name, joinRel(dir.rel, e.name), joinRel(dir.realRel, e.name), {
        type,
        size: Number(e.size) || 0,
        mtimeMs,
        mode: modeFromLongname(e.longname),
      });
      if (type === "link") {
        const described = await describeLink(rootReal, posix.join(dir.abs, e.name));
        entry.link = described.link;
        entry.realRel = described.realRel;
      }
      entries.push(entry);
    }
    return { entries, total: visible.length, sortLimited, truncated, dirEtag };
  }

  async function stat(r) {
    assertResolved(r);
    if (r.isNew) throw fmError(ErrorCode.FM_NOT_FOUND);
    return entryAt(rootRealOf(r), r.rel, r.abs);
  }

  async function readBytes(r, { maxBytes, tail = false } = {}) {
    assertResolved(r);
    const st = await currentFile(r);
    const cap = Math.max(0, Math.floor(Number(maxBytes)) || 0);
    const start = tail ? Math.max(0, st.size - cap) : 0;
    const length = Math.min(cap, st.size - start);
    const buffer = await readRange(r.abs, start, length);
    return { buffer, size: st.size, truncated: tail ? start > 0 : st.size > cap };
  }

  async function openReadStream(r) {
    assertResolved(r);
    const st = await currentFile(r);
    const lease = await pool.lease();
    let source;
    try {
      // Bounded to the size just read, so Content-Length stays true even if
      // the file grows while it streams.
      source = st.size === 0 ? Readable.from([]) : lease.client.createReadStream(r.abs, { start: 0, end: st.size - 1 });
    } catch (err) {
      lease.release();
      throw toFmError(err);
    }
    // ssh2 opens the file as soon as the stream exists and reports a refused
    // OPEN (a file this login can stat but not read) only as a later
    // 'error'. Wait for the open, so a refusal is still a proper error the
    // route can answer instead of a download it already started and then
    // cuts off.
    if (st.size > 0) {
      try {
        await waitForOpen(source, getFileManagerSftpTimeouts().opMs);
      } catch (err) {
        const mapped = toFmError(err);
        source.destroy?.();
        if (isCode(mapped, ErrorCode.FM_SFTP_TIMEOUT) || sftpInfo(mapped)?.connectionLost) lease.discard();
        else lease.release();
        throw mapped;
      }
    }
    const stream = guardIdleRead(source, lease);
    return {
      stream,
      size: st.size,
      close: async () => {
        stream.destroy();
      },
    };
  }

  async function writeBytesCas(r, bytes, { expectedHash = null, trashMeta = {} } = {}) {
    assertResolved(r);
    if (!Buffer.isBuffer(bytes)) throw fmError(ErrorCode.FM_INVALID_REQUEST, { field: "content" });
    if (bytes.length > FM_LIMITS.TEXT_EDIT_MAX_BYTES) {
      throw fmError(ErrorCode.FM_FILE_TOO_LARGE_FOR_EDITOR, { limit: FM_LIMITS.TEXT_EDIT_MAX_BYTES });
    }
    const rootReal = rootRealOf(r);
    const parentAbs = posix.dirname(r.abs);
    const name = posix.basename(r.abs);
    const wanted = typeof expectedHash === "string" ? expectedHash.replace(/^h:/, "") : null;
    await sweepOrphans(parentAbs);

    return guardConfig([r.abs], async () => {
      const existing = await lstatOrNull(r.abs);
      if (wanted === null) {
        if (existing) throw fmError(ErrorCode.FM_EXISTS, { name });
        const tmp = posix.join(parentAbs, tempName(name, RENAME_TEMP_SUFFIX));
        try {
          const written = await putNew(tmp, bytes, 0o644);
          await chmodQuietly(tmp, 0o644);
          // A new file gets its folder's owner, like an upload.
          await matchOwner(tmp, written, await lstatOrNull(parentAbs));
          await landNew(tmp, r.abs);
        } catch (err) {
          await removeQuietly(tmp);
          throw err;
        }
        return { entry: await entryAt(rootReal, r.rel, r.abs), previousTrashId: null, sha256Before: null };
      }

      if (!existing) throw fmError(ErrorCode.FM_CONFLICT, { currentEtag: null });
      if (existing.type !== "file") throw fmError(ErrorCode.FM_NOT_A_FILE);
      if (existing.size > FM_LIMITS.TEXT_EDIT_MAX_BYTES) {
        throw fmError(ErrorCode.FM_FILE_TOO_LARGE_FOR_EDITOR, { limit: FM_LIMITS.TEXT_EDIT_MAX_BYTES });
      }
      const current = await readRange(r.abs, 0, existing.size);
      const currentHash = sha256Hex(current);
      if (currentHash !== wanted) throw fmError(ErrorCode.FM_CONFLICT, { currentEtag: `h:${currentHash}` });

      const mode = existing.mode === null ? 0o644 : existing.mode & 0o777;
      const tmp = posix.join(parentAbs, tempName(name, RENAME_TEMP_SUFFIX));
      let trashId = null;
      try {
        const written = await putNew(tmp, bytes, mode);
        await chmodQuietly(tmp, mode);
        await matchOwner(tmp, written, existing);
        // The version is stored under the name it has on disk, and its path
        // to match: a file opened through a link keeps a readable version.
        trashId = await copyIntoTrash(rootReal, name, current, mode, {
          ...trashMeta,
          reason: trashMeta.reason || "edited",
          originalPath: r.realRel,
          type: "file",
          bytes: current.length,
          files: 1,
        });
        await replaceWith(tmp, r.abs);
      } catch (err) {
        await removeQuietly(tmp);
        // The file is still the old one: a version of it for a save that
        // didn't happen would only push real versions out.
        if (trashId && (await lstatOrNull(r.abs).catch(() => null))) await discardTrashItem(rootReal, trashId);
        throw err;
      }
      return { entry: await entryAt(rootReal, r.rel, r.abs), previousTrashId: trashId, sha256Before: currentHash };
    });
  }

  async function receiveUpload(dir, name, source, { declaredSize, maxBytes, overwriteEtag = null, trashMeta = {} } = {}) {
    assertResolved(dir);
    assertDirectory(dir);
    const checkedName = checkNewName(name);
    const size = Number(declaredSize);
    if (!Number.isSafeInteger(size) || size < 0) throw fmError(ErrorCode.FM_INVALID_REQUEST, { field: "declaredSize" });
    const limit = Number.isFinite(Number(maxBytes)) ? Number(maxBytes) : FM_LIMITS.UPLOAD_MAX_BYTES.sftp;
    if (size > limit) throw fmError(ErrorCode.FM_UPLOAD_TOO_LARGE, { limit });

    const rootReal = rootRealOf(dir);
    const target = posix.join(dir.abs, checkedName);
    const targetRel = joinRel(dir.rel, checkedName);
    const before = await lstatOrNull(target);
    checkReplaceable(before, overwriteEtag, checkedName);
    await sweepOrphans(dir.abs);

    const tmp = posix.join(dir.abs, tempName(checkedName, UPLOAD_TEMP_SUFFIX));
    let tmpMayExist = false;
    try {
      const lease = await pool.lease();
      tmpMayExist = true;
      const { sha256 } = await streamIntoRemote(lease, source, tmp, {
        declaredSize: size,
        maxBytes: limit,
        mode: before && before.mode !== null ? before.mode & 0o777 : 0o644,
      });
      const written = await lstat(tmp);
      if (written.type !== "file" || written.size !== size) throw fmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH);
      return await guardConfig([target], async () => {
        // Checked again: the upload may have taken a while.
        const existing = await lstatOrNull(target);
        checkReplaceable(existing, overwriteEtag, checkedName);
        await chmodQuietly(tmp, existing && existing.mode !== null ? existing.mode & 0o777 : 0o644);
        await matchOwner(tmp, written, existing || dir.stat);
        const replacedTrashId = await landTemp(rootReal, tmp, target, joinRel(dir.realRel, checkedName), existing, {
          ...trashMeta,
          reason: trashMeta.reason || "replaced",
        });
        return { entry: await entryAt(rootReal, targetRel, target), sha256, replacedTrashId };
      });
    } catch (err) {
      if (tmpMayExist) await removeQuietly(tmp);
      throw err;
    }
  }

  async function mkdir(parent, name) {
    assertResolved(parent);
    assertDirectory(parent);
    const checkedName = checkNewName(name);
    const rootReal = rootRealOf(parent);
    const abs = posix.join(parent.abs, checkedName);
    return guardConfig([abs], async () => {
      if (await lstatOrNull(abs)) throw fmError(ErrorCode.FM_EXISTS, { name: checkedName });
      try {
        await mkdirExclusive(abs, 0o755);
      } catch (err) {
        if (await lstatOrNull(abs)) throw fmError(ErrorCode.FM_EXISTS, { name: checkedName });
        throw err;
      }
      // Its parent's owner, like a new file (and a folder a restore or a
      // folder upload recreates): a root login would otherwise leave the
      // game user a folder it can't write into.
      await matchOwner(abs, null, parent.stat);
      return entryAt(rootReal, joinRel(parent.rel, checkedName), abs);
    });
  }

  async function rename(r, newName) {
    assertResolved(r);
    assertNotRoot(r);
    if (r.isNew) throw fmError(ErrorCode.FM_NOT_FOUND);
    const checkedName = checkNewName(newName);
    const rootReal = rootRealOf(r);
    const parentAbs = posix.dirname(r.abs);
    const oldName = posix.basename(r.abs);
    if (checkedName === oldName) throw fmError(ErrorCode.FM_EXISTS, { name: checkedName });
    const target = posix.join(parentAbs, checkedName);
    const newRel = joinRel(parentRel(r.rel), checkedName);

    return guardConfig([r.abs, target], async () => {
      if (checkedName.toLowerCase() === oldName.toLowerCase()) {
        // Case-only: two steps through a temp name, so a case-insensitive
        // host sees a real rename and a case-sensitive one still refuses
        // an existing target (spec §A6.5).
        const aside = posix.join(parentAbs, tempName(oldName, RENAME_TEMP_SUFFIX));
        await renameEntry(r.abs, aside);
        try {
          await renameEntry(aside, target);
        } catch (err) {
          await renameQuietly(aside, r.abs);
          if (await lstatOrNull(target)) throw fmError(ErrorCode.FM_EXISTS, { name: checkedName });
          throw err;
        }
      } else {
        if (await lstatOrNull(target)) throw fmError(ErrorCode.FM_EXISTS, { name: checkedName });
        await landNew(r.abs, target);
      }
      return entryAt(rootReal, newRel, target);
    });
  }

  async function move(r, destDir) {
    assertResolved(r);
    assertResolved(destDir);
    assertNotRoot(r);
    if (r.isNew) throw fmError(ErrorCode.FM_NOT_FOUND);
    assertDirectory(destDir);
    const rootReal = rootRealOf(r);
    if (rootRealOf(destDir) !== rootReal) throw fmError(ErrorCode.FM_INVALID_REQUEST, { field: "destDir" });
    if (isInside(r.abs, destDir.abs)) throw fmError(ErrorCode.FM_MOVE_INTO_SELF);
    const name = posix.basename(r.abs);
    const target = posix.join(destDir.abs, name);
    return guardConfig([r.abs, target], async () => {
      if (await lstatOrNull(target)) throw fmError(ErrorCode.FM_EXISTS, { name });
      await landNew(r.abs, target);
      return entryAt(rootReal, joinRel(destDir.rel, name), target);
    });
  }

  // An existing target is replaced only when `overwriteEtag` names its
  // current version (the service passes what it showed the user), exactly
  // like an upload's X-File-Overwrite-Etag.
  async function copyFile(r, destDir, newName, { overwriteEtag = null, trashMeta = {} } = {}) {
    assertResolved(r);
    assertResolved(destDir);
    assertDirectory(destDir);
    const rootReal = rootRealOf(destDir);
    const st = await currentFile(r);
    if (st.size > COPY_MAX_BYTES) throw fmError(ErrorCode.FM_UPLOAD_TOO_LARGE, { limit: COPY_MAX_BYTES });
    const checkedName = checkNewName(newName);
    const target = posix.join(destDir.abs, checkedName);
    const targetRel = joinRel(destDir.rel, checkedName);
    checkReplaceable(await lstatOrNull(target), overwriteEtag, checkedName);

    const tmp = posix.join(destDir.abs, tempName(checkedName, RENAME_TEMP_SUFFIX));
    let tmpMayExist = false;
    try {
      const lease = await pool.lease();
      tmpMayExist = true;
      let source;
      try {
        source = st.size === 0 ? Readable.from([]) : lease.client.createReadStream(r.abs, { start: 0, end: st.size - 1 });
      } catch (err) {
        lease.release();
        throw toFmError(err);
      }
      await streamIntoRemote(lease, source, tmp, {
        declaredSize: st.size,
        maxBytes: COPY_MAX_BYTES,
        remoteSource: true,
        mode: 0o644,
      });
      // Like an upload: what landed must be every byte of the source.
      const written = await lstat(tmp);
      if (written.type !== "file" || written.size !== st.size) throw fmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH);
      return await guardConfig([target], async () => {
        const existing = await lstatOrNull(target);
        checkReplaceable(existing, overwriteEtag, checkedName);
        // A copy is a new file: 0644, never executable (spec §A6.3).
        await chmodQuietly(tmp, 0o644);
        await matchOwner(tmp, written, existing || destDir.stat);
        await landTemp(rootReal, tmp, target, joinRel(destDir.realRel, checkedName), existing, {
          ...trashMeta,
          reason: trashMeta.reason || "replaced",
        });
        return entryAt(rootReal, targetRel, target);
      });
    } catch (err) {
      if (tmpMayExist) await removeQuietly(tmp);
      // The source changed size while it was being copied.
      if (isCode(err, ErrorCode.FM_UPLOAD_SIZE_MISMATCH)) throw fmError(ErrorCode.FM_CONFLICT, { currentEtag: null });
      throw err;
    }
  }

  // Breadth-first over list() (like the local walk: a search that runs out
  // of time has looked at every shallow folder, not one deep subtree),
  // never following a link. Yields everything below `r` (not `r` itself,
  // and nothing for a file), as the service and the conformance suite
  // expect: { name, rel, realRel, type, size, mtimeMs, dev, ino, depth },
  // with root-relative paths as navigated and depth 1 for `r`'s own
  // children. dev/ino are always null over SFTP. Stops early at maxEntries,
  // maxMs or an abort; folders deeper than maxDepth aren't entered, and
  // `prune(entry)` returning true skips a folder's contents. After the loop,
  // `.truncated` and `.truncatedReason` ('entries'|'depth'|'time'|'aborted')
  // say whether and why it stopped short. A folder that vanishes or can't
  // be read mid-walk is skipped (`.skipped` counts them, and
  // `onUnreadable({ rel, realRel, folder: true })` hears about it);
  // `onDepthLimit()` hears about the first folder left unopened.
  function walk(
    r,
    { maxEntries = Infinity, maxDepth = Infinity, maxMs = Infinity, signal, prune, onUnreadable, onDepthLimit } = {},
  ) {
    const state = { truncated: false, truncatedReason: null, skipped: 0 };
    const stop = (reason) => {
      state.truncated = true;
      if (!state.truncatedReason) state.truncatedReason = reason;
    };
    async function* generate() {
      assertResolved(r);
      if (r.isNew || !r.stat) throw fmError(ErrorCode.FM_NOT_FOUND);
      const started = Date.now();
      let visited = 0;
      if (r.stat.type !== "dir") return;
      const queue = [{ abs: r.abs, rel: r.rel, realRel: r.realRel, depth: 1 }];
      let depthReported = false;
      while (queue.length > 0) {
        if (signal?.aborted) {
          stop("aborted");
          return;
        }
        if (Date.now() - started > maxMs) {
          stop("time");
          return;
        }
        const frame = queue.shift();
        let children;
        try {
          children = await listDir(frame.abs);
        } catch (err) {
          if (isCode(err, ErrorCode.FM_NOT_FOUND) || isCode(err, ErrorCode.FM_OS_PERMISSION_DENIED)) {
            state.skipped += 1;
            onUnreadable?.({ rel: frame.rel, realRel: frame.realRel, folder: true });
            continue;
          }
          throw err;
        }
        children = children
          .filter((e) => e.name !== "." && e.name !== ".." && !isOmitted(e.name))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        if (frame.depth > maxDepth) {
          if (children.length > 0) {
            stop("depth");
            if (!depthReported) {
              depthReported = true;
              onDepthLimit?.({ rel: frame.rel, realRel: frame.realRel });
            }
          }
          continue;
        }
        const subfolders = [];
        for (const e of children) {
          if (visited >= maxEntries) {
            stop("entries");
            return;
          }
          const type = typeFromListChar(e.type);
          const entry = {
            name: e.name,
            rel: joinRel(frame.rel, e.name),
            realRel: joinRel(frame.realRel, e.name),
            type,
            size: type === "file" ? Number(e.size) || 0 : 0,
            mtimeMs: Number(e.modifyTime) || 0,
            dev: null,
            ino: null,
            depth: frame.depth,
          };
          visited += 1;
          yield entry;
          if (type === "dir" && !(prune && prune(entry))) {
            subfolders.push({
              abs: posix.join(frame.abs, e.name),
              rel: entry.rel,
              realRel: entry.realRel,
              depth: frame.depth + 1,
            });
          }
        }
        queue.push(...subfolders);
      }
    }
    return {
      [Symbol.asyncIterator]: generate,
      get truncated() {
        return state.truncated;
      },
      get truncatedReason() {
        return state.truncatedReason;
      },
      get skipped() {
        return state.skipped;
      },
    };
  }

  async function trashMove(r, meta = {}) {
    assertResolved(r);
    assertNotRoot(r);
    if (r.isNew) throw fmError(ErrorCode.FM_NOT_FOUND);
    const rootReal = rootRealOf(r);
    const st = await lstat(r.abs);
    const type = st.type === "dir" ? "dir" : "file";
    let bytes = Number.isSafeInteger(meta.bytes) ? meta.bytes : null;
    let files = Number.isSafeInteger(meta.files) ? meta.files : null;
    if (bytes === null || files === null) {
      if (type === "file") {
        bytes = st.type === "file" ? st.size : 0;
        files = 1;
      } else {
        bytes = 0;
        files = 0;
        const walker = walk(
          { ...r, stat: st },
          { maxEntries: FM_LIMITS.PREVIEW_WALK_MAX_ENTRIES, maxMs: FM_LIMITS.PREVIEW_WALK_MAX_MS },
        );
        for await (const e of walker) {
          if (e.type !== "dir") files += 1;
          bytes += e.size;
        }
      }
    }
    return guardConfig([r.abs], async () => ({
      trashId: await moveIntoTrash(rootReal, r.abs, {
        ...meta,
        reason: meta.reason || "deleted",
        originalPath: r.realRel,
        type,
        bytes,
        files,
      }),
    }));
  }

  async function trashList(root) {
    assertRoot(root);
    const trashAbs = posix.join(root.real, TRASH_DIR_NAME);
    const st = await lstatOrNull(trashAbs);
    if (!st || st.type !== "dir") return [];
    const now = Date.now();
    const items = [];
    const budget = { left: EXPIRY_ENTRY_BUDGET };
    for (const e of await listDir(trashAbs)) {
      if (e.type !== "d" || !TRASH_ID_RE.test(e.name)) continue;
      const itemAbs = posix.join(trashAbs, e.name);
      const created = trashIdTime(e.name);
      if (now - created > TRASH_RETENTION_MS) {
        // Remote retention is lazy: expired items go when Trash is looked at
        // (a bounded amount per look; drainExpiredTrash() hands them to the
        // audit trail).
        if (budget.left > 0) await expireTrashItem(root.real, trashAbs, e.name, budget);
        continue;
      }
      const meta = await readTrashMeta(itemAbs);
      if (!meta) continue;
      items.push({
        trashId: e.name,
        originalPath: meta.originalPath,
        type: meta.type,
        bytes: meta.bytes,
        files: meta.files,
        deletedAt: meta.deletedAt || new Date(created).toISOString(),
        deletedBy: { username: meta.deletedBy.username },
        reason: meta.reason,
        expiresAt: new Date(created + TRASH_RETENTION_MS).toISOString(),
      });
    }
    // Newest first (deletedAt is ms-precise; the trashId only to the second).
    items.sort(
      (a, b) =>
        Date.parse(b.deletedAt) - Date.parse(a.deletedAt) || (a.trashId < b.trashId ? 1 : a.trashId > b.trashId ? -1 : 0),
    );
    return items;
  }

  async function trashRestore(root, trashId, restoreAs) {
    assertRoot(root);
    if (typeof trashId !== "string" || !TRASH_ID_RE.test(trashId)) throw fmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
    const itemAbs = posix.join(root.real, TRASH_DIR_NAME, trashId);
    const itemSt = await lstatOrNull(itemAbs);
    if (!itemSt || itemSt.type !== "dir") throw fmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
    // meta.json is untrusted: its path goes back through resolve().
    const meta = await readTrashMeta(itemAbs);
    if (!meta) throw fmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
    const segments = meta.originalPath.split("/");
    const originalName = segments[segments.length - 1];
    const payloadAbs = posix.join(itemAbs, "payload", originalName);
    if (!(await lstatOrNull(payloadAbs))) throw fmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
    const name = restoreAs === undefined || restoreAs === null ? originalName : checkNewName(restoreAs);
    const parent = await resolve(root, segments.slice(0, -1), "list");
    assertDirectory(parent);
    const target = posix.join(parent.abs, name);
    return guardConfig([target], async () => {
      if (await lstatOrNull(target)) throw fmError(ErrorCode.FM_EXISTS, { name });
      await landNew(payloadAbs, target);
      await removeTreeQuietly(itemAbs);
      trashMetaCache.delete(trashMetaKey(itemAbs));
      return entryAt(root.real, joinRel(parent.rel, name), target);
    });
  }

  // The first maxBytes of a Trash item that is a file (the editor's
  // "Previous versions"). The payload is found the way trashRestore finds it.
  async function trashReadBytes(root, trashId, { maxBytes } = {}) {
    assertRoot(root);
    if (typeof trashId !== "string" || !TRASH_ID_RE.test(trashId)) throw fmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
    const itemAbs = posix.join(root.real, TRASH_DIR_NAME, trashId);
    const itemSt = await lstatOrNull(itemAbs);
    if (!itemSt || itemSt.type !== "dir") throw fmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
    const meta = await readTrashMeta(itemAbs);
    if (!meta) throw fmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
    const segments = meta.originalPath.split("/");
    const payloadAbs = posix.join(itemAbs, "payload", segments[segments.length - 1]);
    const st = await lstatOrNull(payloadAbs);
    if (!st) throw fmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
    if (st.type !== "file") throw fmError(ErrorCode.FM_NOT_A_FILE);
    const cap = Math.max(0, Math.floor(Number(maxBytes)) || 0);
    const buffer = await readRange(payloadAbs, 0, Math.min(cap, st.size));
    return { buffer, size: st.size, truncated: st.size > cap };
  }

  async function deletePermanent(target, onProgress = () => {}) {
    const progress = typeof onProgress === "function" ? onProgress : () => {};
    if (target && typeof target === "object" && "trashId" in target && target.root) {
      assertRoot(target.root);
      if (typeof target.trashId !== "string" || !TRASH_ID_RE.test(target.trashId)) {
        throw fmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
      }
      const itemAbs = posix.join(target.root.real, TRASH_DIR_NAME, target.trashId);
      const st = await lstatOrNull(itemAbs);
      if (!st || st.type !== "dir") throw fmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
      await removeTree(itemAbs, progress);
      trashMetaCache.delete(trashMetaKey(itemAbs));
      return;
    }
    assertResolved(target);
    assertNotRoot(target);
    if (target.isNew) throw fmError(ErrorCode.FM_NOT_FOUND);
    await guardConfig([target.abs], () => removeTree(target.abs, progress));
  }

  async function freeSpace(root) {
    assertRoot(root);
    const none = { free: null, total: null };
    if (pool.capabilities.statvfs === false) return none;
    let st;
    try {
      st = await read((c) => rawCall(c, "ext_openssh_statvfs", root.real));
    } catch (err) {
      if (sftpInfo(err)?.unsupported) {
        pool.capabilities.statvfs = false;
        return none;
      }
      throw err;
    }
    pool.capabilities.statvfs = true;
    const blockSize = toNumber(st?.f_frsize) || toNumber(st?.f_bsize);
    const available = toNumber(st?.f_bavail);
    const blocks = toNumber(st?.f_blocks);
    if (!blockSize || available === null || blocks === null) return none;
    return { free: available * blockSize, total: blocks * blockSize };
  }

  // The Trash items lazy retention removed from this root since the last
  // call (the service writes their files.trash.expire audit row).
  function drainExpiredTrash(rootReal) {
    const key = `${pool.id}|${rootReal}`;
    const ids = expiredByRoot.get(key) || [];
    expiredByRoot.delete(key);
    return ids;
  }

  return {
    kind: "sftp",
    remote: pool.remote,
    describeRoot,
    resolve,
    resolveChild,
    statEtag: (st) => statEtag(st?.size, st?.mtimeMs),
    drainExpiredTrash,
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
  };
}

// server/index.js calls this during graceful shutdown.
export async function closeFileManagerSftpPool() {
  await closeFileManagerSftpPools();
}
