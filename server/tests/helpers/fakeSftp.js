// In-memory SFTP server and ssh2-sftp-client double for the Server Files SFTP
// backend (spec §A16 "SFTP tests").
//
// FakeSftpServer holds one POSIX-ish filesystem (folders, files, symlinks,
// modes, second-resolution mtimes) shared by every client it hands out, so
// the pool's metadata and transfer connections see the same files.
// FakeSftpClient mirrors the part of ssh2-sftp-client v12 the backend uses --
// its method names, result shapes and error shapes -- plus the raw `sftp`
// object for readlink, exclusive mkdir, rmdir, statvfs, setstat and the
// opendir/readdir/close of a listing (logged as one "list" op, then one
// "readdir" per batch of `readdirBatch` names, like OpenSSH's ~100).
//
// Semantics copied from OpenSSH's sftp-server where they matter:
// - plain rename never replaces an existing target (FAILURE);
// - posix-rename@openssh.com replaces a file, and is absent when the
//   `posixRename` toggle is off ("Server does not support this extended
//   request", thrown synchronously by ssh2 and surfacing as a rejection);
// - statvfs@openssh.com likewise behind the `statvfs` toggle;
// - REALPATH resolves links unless `realPathResolvesLinks` is off, in which
//   case it only normalizes (the servers §A4.5's readlink fallback is for);
// - errno mapping: ENOENT/ENOTDIR/ELOOP give NO_SUCH_FILE (2), EACCES gives
//   PERMISSION_DENIED (3), everything else FAILURE (4).
//
// Failure injection: server.inject(op, { error, hang, connectionLost, times,
// path }) makes the next matching call fail, hang forever, or drop its
// connection. stallReads/stallWrites freeze streamed transfers.
import { posix } from "path";
import { Readable, Writable } from "stream";
import { createSftpBackend } from "../../services/fileManagerSftpBackend.js";
import { _setFileManagerSftpTestHooks } from "../../services/fileManagerSftpPool.js";

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

const STATUS_TEXT = { 2: "No such file", 3: "Permission denied", 4: "Failure" };

function statusError(op, status, p) {
  const err = new Error(`${op}: ${STATUS_TEXT[status] || "Failure"} ${p}`);
  err.code = status;
  err.custom = true;
  return err;
}

// ssh2-sftp-client's _xstat() rewrites NO_SUCH_FILE (and FAILURE) this way.
function xstatMissing(p) {
  const err = new Error(`_xstat: No such file: ${p}`);
  err.code = "ENOENT";
  err.custom = true;
  return err;
}

export function connectionLostError(op = "sftp") {
  const err = new Error(`${op}: read ECONNRESET`);
  err.code = "ECONNRESET";
  return err;
}

function notConnectedError(op) {
  const err = new Error(`${op}: No SFTP connection available`);
  err.code = "ERR_NOT_CONNECTED";
  err.custom = true;
  return err;
}

function unsupportedError() {
  return new Error("Server does not support this extended request");
}

function permString(mode) {
  const chars = ["r", "w", "x"];
  let out = "";
  for (let i = 8; i >= 0; i--) out += mode & (1 << i) ? chars[(8 - i) % 3] : "-";
  // setuid/setgid/sticky shown the ls way.
  const arr = out.split("");
  if (mode & 0o4000) arr[2] = arr[2] === "x" ? "s" : "S";
  if (mode & 0o2000) arr[5] = arr[5] === "x" ? "s" : "S";
  if (mode & 0o1000) arr[8] = arr[8] === "x" ? "t" : "T";
  return arr.join("");
}

const never = () => new Promise(() => {});

export class FakeSftpServer {
  constructor({
    posixRename = true,
    statvfs = true,
    realPathResolvesLinks = true,
    password = null,
    umask = 0o022,
    statvfsResult = { f_bsize: 4096, f_frsize: 4096, f_blocks: 1000000, f_bfree: 400000, f_bavail: 250000 },
    readdirBatch = 100,
  } = {}) {
    this.options = { posixRename, statvfs, realPathResolvesLinks, password, umask, statvfsResult, readdirBatch };
    this.nodes = new Map([["/", { type: "dir", mode: 0o755, mtime: this.#now() }]]);
    this.clock = null;
    this.connects = 0;
    this.connectAttempts = 0;
    this.ends = 0;
    this.log = [];
    this.injections = [];
    this.clients = [];
    this.unreachable = false;
    this.hangConnect = false;
    this.stallReads = false;
    this.stallWrites = false;
    this.recursiveRmdirCalls = 0;
    this.lastConnect = null;
    this.dirHandles = new Map();
    this.handleCounter = 0;
    this.denyOpen = new Set();
    this.denySetstat = false;
    this.clientFactory = (name, callbacks) => this.createClient(name, callbacks);
  }

  // ---- clock (seconds, like SFTP attrs)

  #now() {
    return this.clock ?? Math.floor(Date.now() / 1000);
  }

  setClock(seconds) {
    this.clock = seconds;
  }

  // ---- test-side filesystem API (no injection, no logging)

  #parentOf(p) {
    return posix.dirname(p);
  }

  #touchParent(p) {
    const parent = this.nodes.get(this.#parentOf(p));
    if (parent) parent.mtime = this.#now();
  }

  mkdirp(p, { mode = 0o755 } = {}) {
    const parts = posix.normalize(p).split("/").filter(Boolean);
    let cur = "/";
    for (const part of parts) {
      cur = posix.join(cur, part);
      if (!this.nodes.has(cur)) {
        this.nodes.set(cur, { type: "dir", mode, mtime: this.#now() });
        this.#touchParent(cur);
      }
    }
    return cur;
  }

  writeFile(p, data, { mode = 0o644, mtime } = {}) {
    const abs = posix.normalize(p);
    this.mkdirp(posix.dirname(abs));
    this.nodes.set(abs, {
      type: "file",
      mode,
      data: Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data)),
      mtime: mtime ?? this.#now(),
    });
    this.#touchParent(abs);
    return abs;
  }

  symlink(p, target) {
    const abs = posix.normalize(p);
    this.mkdirp(posix.dirname(abs));
    this.nodes.set(abs, { type: "link", mode: 0o777, target, mtime: this.#now() });
    this.#touchParent(abs);
    return abs;
  }

  remove(p) {
    const abs = posix.normalize(p);
    for (const key of [...this.nodes.keys()]) {
      if (key === abs || key.startsWith(`${abs}/`)) this.nodes.delete(key);
    }
  }

  node(p) {
    return this.nodes.get(posix.normalize(p)) || null;
  }

  readFile(p) {
    const node = this.node(p);
    return node && node.type === "file" ? Buffer.from(node.data) : null;
  }

  exists(p) {
    return this.nodes.has(posix.normalize(p));
  }

  typeOf(p) {
    return this.node(p)?.type ?? null;
  }

  modeOf(p) {
    return this.node(p)?.mode ?? null;
  }

  childNames(p) {
    const abs = posix.normalize(p);
    const prefix = abs === "/" ? "/" : `${abs}/`;
    return [...this.nodes.keys()]
      .filter((key) => key !== abs && key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
      .map((key) => key.slice(prefix.length))
      .sort();
  }

  /** Every path at or below p, for leak checks. */
  allPaths() {
    return [...this.nodes.keys()].sort();
  }

  // ---- injection and bookkeeping

  /**
   * Make the next `times` calls of `op` (optionally only for `path`) fail
   * with `error`, never settle (`hang`), or drop the connection
   * (`connectionLost`, an ECONNRESET that also kills that client).
   */
  inject(op, { error = null, hang = false, connectionLost = false, times = 1, path = null } = {}) {
    this.injections.push({ op, error, hang, connectionLost, times, path });
  }

  opCount(op, { path } = {}) {
    return this.log.filter((entry) => entry.op === op && (path === undefined || entry.path === path)).length;
  }

  clearLog() {
    this.log = [];
  }

  /** Simulate the server closing every connection (idle kick, restart). */
  dropConnections() {
    for (const client of this.clients) client._drop();
  }

  async before(client, op, p) {
    this.log.push({ client: client.id, kind: client.name, op, path: p });
    const index = this.injections.findIndex((inj) => inj.op === op && (inj.path === null || inj.path === p));
    if (index === -1) return;
    const inj = this.injections[index];
    inj.times -= 1;
    if (inj.times <= 0) this.injections.splice(index, 1);
    if (inj.hang) await never();
    if (inj.connectionLost) {
      client._drop();
      throw connectionLostError(op);
    }
    if (inj.error) throw typeof inj.error === "function" ? inj.error() : inj.error;
  }

  createClient(name, callbacks = {}) {
    const client = new FakeSftpClient(this, name, callbacks, this.clients.length + 1);
    this.clients.push(client);
    return client;
  }

  // ---- path resolution

  // Resolve p the way the kernel would: links in the middle are always
  // followed, the last one only with followLast. Returns { path, node } or
  // { missing: true }.
  resolvePath(p, { followLast = true, budget = { hops: 40 } } = {}) {
    const parts = posix.normalize(p).split("/").filter(Boolean);
    let cur = "/";
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const next = posix.join(cur, parts[i]);
      const node = this.nodes.get(next);
      if (!node) return { missing: true, parent: cur };
      if (node.type === "link" && (!last || followLast)) {
        budget.hops -= 1;
        if (budget.hops < 0) return { missing: true, loop: true };
        const target = node.target.startsWith("/") ? node.target : posix.join(cur, node.target);
        const hop = this.resolvePath(target, { followLast: true, budget });
        if (hop.missing) return { missing: true };
        cur = hop.path;
        if (!last && hop.node.type !== "dir") return { missing: true };
        continue;
      }
      if (!last && node.type !== "dir") return { missing: true };
      cur = next;
    }
    return { path: cur, node: this.nodes.get(cur) };
  }

  // The directory entry itself (parents followed, last not).
  entryOf(p) {
    const abs = posix.normalize(p);
    if (abs === "/") return { path: "/", node: this.nodes.get("/") };
    const parent = this.resolvePath(posix.dirname(abs));
    if (parent.missing || parent.node.type !== "dir") return { missing: true };
    const path = posix.join(parent.path, posix.basename(abs));
    const node = this.nodes.get(path);
    return node ? { path, node, parentPath: parent.path } : { missing: true, parentPath: parent.path, path };
  }

  statsOf(node) {
    const typeBits = node.type === "dir" ? S_IFDIR : node.type === "link" ? S_IFLNK : S_IFREG;
    const size = node.type === "file" ? node.data.length : node.type === "link" ? node.target.length : 4096;
    return {
      mode: typeBits | node.mode,
      uid: node.uid ?? 1000,
      gid: node.gid ?? 1000,
      size,
      accessTime: node.mtime * 1000,
      modifyTime: node.mtime * 1000,
      isDirectory: node.type === "dir",
      isFile: node.type === "file",
      isBlockDevice: false,
      isCharacterDevice: false,
      isSymbolicLink: node.type === "link",
      isFIFO: false,
      isSocket: false,
    };
  }

  moveTree(from, to) {
    for (const key of [...this.nodes.keys()]) {
      if (key === from || key.startsWith(`${from}/`)) {
        const node = this.nodes.get(key);
        this.nodes.delete(key);
        this.nodes.set(to + key.slice(from.length), node);
      }
    }
    this.#touchParent(from);
    this.#touchParent(to);
  }

  createFile(path, mode) {
    const node = { type: "file", mode: mode & ~this.options.umask & 0o7777, data: Buffer.alloc(0), mtime: this.#now() };
    this.nodes.set(path, node);
    this.#touchParent(path);
    return node;
  }

  touch(node) {
    node.mtime = this.#now();
  }
}

export class FakeSftpClient {
  constructor(server, name, callbacks, id) {
    this.server = server;
    this.name = name;
    this.callbacks = callbacks;
    this.id = id;
    this.sftp = undefined;
    this.connected = false;
    this.ended = false;
  }

  _drop() {
    if (!this.connected) return;
    this.connected = false;
    this.sftp = undefined;
    this.callbacks?.close?.();
  }

  #requireConnection(op) {
    if (!this.connected) throw notConnectedError(op);
  }

  async connect(config) {
    const server = this.server;
    server.connectAttempts += 1;
    server.lastConnect = { host: config.host, port: config.port, username: config.username, readyTimeout: config.readyTimeout };
    await server.before(this, "connect", null);
    if (server.hangConnect) await never();
    if (server.unreachable) {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:22");
      err.code = "ECONNREFUSED";
      throw err;
    }
    if (server.options.password !== null && config.password !== server.options.password) {
      throw new Error("All configured authentication methods failed");
    }
    server.connects += 1;
    this.connected = true;
    this.sftp = this.#rawSftp();
    return this.sftp;
  }

  async end() {
    if (this.ended) return true;
    this.ended = true;
    if (this.connected) this.server.ends += 1;
    this.connected = false;
    this.sftp = undefined;
    return true;
  }

  async realPath(p) {
    this.#requireConnection("realPath");
    await this.server.before(this, "realPath", p);
    const server = this.server;
    const resolved = server.resolvePath(p);
    if (resolved.missing) return "";
    if (server.options.realPathResolvesLinks) return resolved.path;
    return posix.normalize(p);
  }

  async lstat(p) {
    this.#requireConnection("lstat");
    await this.server.before(this, "lstat", p);
    const entry = this.server.entryOf(p);
    if (entry.missing) throw xstatMissing(p);
    return this.server.statsOf(entry.node);
  }

  async stat(p) {
    this.#requireConnection("stat");
    await this.server.before(this, "stat", p);
    const resolved = this.server.resolvePath(p);
    if (resolved.missing) throw xstatMissing(p);
    return this.server.statsOf(resolved.node);
  }

  async exists(p) {
    this.#requireConnection("exists");
    const entry = this.server.entryOf(p);
    if (entry.missing) return false;
    return entry.node.type === "dir" ? "d" : entry.node.type === "link" ? "l" : "-";
  }

  async list(p) {
    this.#requireConnection("list");
    await this.server.before(this, "list", p);
    const server = this.server;
    const resolved = server.resolvePath(p);
    if (resolved.missing) throw statusError("list", 2, p);
    if (resolved.node.type !== "dir") throw statusError("list", 2, p);
    return server.childNames(resolved.path).map((name) => {
      const node = server.nodes.get(posix.join(resolved.path, name));
      const st = server.statsOf(node);
      const typeChar = node.type === "dir" ? "d" : node.type === "link" ? "l" : "-";
      const perms = permString(node.mode);
      return {
        type: typeChar,
        name,
        size: st.size,
        modifyTime: st.modifyTime,
        accessTime: st.accessTime,
        rights: {
          user: perms.slice(0, 3).replaceAll("-", ""),
          group: perms.slice(3, 6).replaceAll("-", ""),
          other: perms.slice(6, 9).replaceAll("-", ""),
        },
        owner: 1000,
        group: 1000,
        longname: `${typeChar}${perms}    1 1000     1000     ${String(st.size).padStart(8)} Jan  1 00:00 ${name}`,
      };
    });
  }

  async get(p, dst, options) {
    this.#requireConnection("get");
    await this.server.before(this, "get", p);
    const resolved = this.server.resolvePath(p);
    if (resolved.missing) throw statusError("get", 2, p);
    if (resolved.node.type !== "file") throw statusError("get", 4, p);
    const data = resolved.node.data;
    const start = options?.readStreamOptions?.start ?? 0;
    const end = options?.readStreamOptions?.end ?? data.length - 1;
    return Buffer.from(data.subarray(start, end + 1));
  }

  #openForWrite(op, p, flags = "w", mode = 0o666) {
    const server = this.server;
    const entry = server.entryOf(p);
    if (entry.missing && !entry.path) throw statusError(op, 2, p);
    if (!entry.missing) {
      if (flags.includes("x")) throw statusError(op, 4, p);
      let node = entry.node;
      if (node.type === "link") {
        const resolved = server.resolvePath(p);
        if (resolved.missing) throw statusError(op, 2, p);
        node = resolved.node;
      }
      if (node.type !== "file") throw statusError(op, 4, p);
      node.data = Buffer.alloc(0);
      server.touch(node);
      return node;
    }
    return server.createFile(entry.path, mode);
  }

  async put(src, p, options) {
    this.#requireConnection("put");
    await this.server.before(this, "put", p);
    const opts = options?.writeStreamOptions || {};
    const node = this.#openForWrite("_put", p, opts.flags, opts.mode ?? 0o666);
    if (Buffer.isBuffer(src)) {
      node.data = Buffer.from(src);
    } else {
      const chunks = [];
      for await (const chunk of src) chunks.push(Buffer.from(chunk));
      node.data = Buffer.concat(chunks);
    }
    this.server.touch(node);
    return `Uploaded data stream to ${p}`;
  }

  createReadStream(p, options = {}) {
    this.#requireConnection("createReadStream");
    const server = this.server;
    const client = this;
    let offset = options.start ?? 0;
    let end = null;
    let data = null;
    let waiting = false;
    const stream = new Readable({
      highWaterMark: 16 * 1024,
      read() {
        if (data === null) {
          waiting = true;
          return;
        }
        if (server.stallReads) return;
        if (offset > end || offset >= data.length) {
          this.push(null);
          return;
        }
        const stop = Math.min(end + 1, data.length, offset + 16 * 1024);
        const chunk = Buffer.from(data.subarray(offset, stop));
        offset = stop;
        this.push(chunk);
      },
    });
    // Like ssh2: the remote OPEN goes out as soon as the stream exists, and
    // its outcome is an 'open' + 'ready' or an 'error'.
    server
      .before(client, "createReadStream", p)
      .then(() => {
        const resolved = server.resolvePath(p);
        if (resolved.missing || resolved.node.type !== "file") throw statusError("createReadStream", 2, p);
        if (server.denyOpen?.has(resolved.path)) throw statusError("createReadStream", 3, p);
        data = resolved.node.data;
        end = options.end ?? data.length - 1;
        stream.emit("open", Buffer.from("handle"));
        stream.emit("ready");
        if (waiting) {
          waiting = false;
          stream._read();
        }
      })
      .catch((err) => stream.destroy(err));
    return stream;
  }

  createWriteStream(p, options = {}) {
    this.#requireConnection("createWriteStream");
    const server = this.server;
    const client = this;
    let node = null;
    let openError = null;
    const opening = server.before(client, "createWriteStream", p).then(
      () => {
        try {
          node = client.#openForWrite("createWriteStream", p, options.flags || "w", options.mode ?? 0o666);
        } catch (err) {
          openError = err;
        }
      },
      (err) => {
        openError = err;
      },
    );
    const stream = new Writable({
      highWaterMark: 16 * 1024,
      write(chunk, _encoding, callback) {
        opening.then(() => {
          if (openError) return callback(openError);
          if (server.stallWrites) return undefined;
          node.data = Buffer.concat([node.data, Buffer.from(chunk)]);
          server.touch(node);
          stream.bytesWritten += chunk.length;
          return callback();
        });
      },
      final(callback) {
        opening.then(() => callback(openError || undefined));
      },
      // Like ssh2: the handle is closed only once its open has finished.
      destroy(err, callback) {
        opening.then(() => callback(err));
      },
    });
    // Like ssh2's WriteStream: the bytes each WRITE reply acknowledged.
    stream.bytesWritten = 0;
    // ssh2 opens the handle as soon as the stream exists and reports a
    // failed open straight away.
    opening.then(() => {
      if (openError && !stream.destroyed) stream.destroy(openError);
    });
    return stream;
  }

  async rename(from, to) {
    this.#requireConnection("rename");
    await this.server.before(this, "rename", from);
    const server = this.server;
    const src = server.entryOf(from);
    if (src.missing) throw statusError("_rename", 2, from);
    const dst = server.entryOf(to);
    if (!dst.missing) throw statusError("_rename", 4, from);
    if (!dst.path) throw statusError("_rename", 2, to);
    if (dst.path === src.path || dst.path.startsWith(`${src.path}/`)) throw statusError("_rename", 4, from);
    server.moveTree(src.path, dst.path);
    return `Successfully renamed ${from} to ${to}`;
  }

  async posixRename(from, to) {
    this.#requireConnection("posixRename");
    await this.server.before(this, "posixRename", from);
    const server = this.server;
    if (!server.options.posixRename) throw unsupportedError();
    const src = server.entryOf(from);
    if (src.missing) throw statusError("_posixRename", 2, from);
    const dst = server.entryOf(to);
    if (!dst.path) throw statusError("_posixRename", 2, to);
    if (!dst.missing) {
      if (dst.node.type === "dir" && (src.node.type !== "dir" || server.childNames(dst.path).length > 0)) {
        throw statusError("_posixRename", 4, from);
      }
      if (dst.node.type !== "dir" && src.node.type === "dir") throw statusError("_posixRename", 4, from);
      server.remove(dst.path);
    }
    server.moveTree(src.path, dst.path);
    return `Successful POSIX rename ${from} to ${to}`;
  }

  async delete(p) {
    this.#requireConnection("delete");
    await this.server.before(this, "delete", p);
    const entry = this.server.entryOf(p);
    if (entry.missing) throw statusError("delete", 2, p);
    if (entry.node.type === "dir") throw statusError("delete", 4, p);
    this.server.nodes.delete(entry.path);
    return `Successfully deleted ${p}`;
  }

  async chmod(p, mode) {
    this.#requireConnection("chmod");
    await this.server.before(this, "chmod", p);
    const resolved = this.server.resolvePath(p);
    if (resolved.missing) throw statusError("_chmod", 2, p);
    resolved.node.mode = mode & 0o7777;
    return "Successfully change file mode";
  }

  // The library's own rmdir: recorded, so tests can prove the backend never
  // uses its recursive mode.
  async rmdir(p, recursive = false) {
    this.#requireConnection("rmdir");
    if (recursive) this.server.recursiveRmdirCalls += 1;
    await this.server.before(this, "rmdirLibrary", p);
    const entry = this.server.entryOf(p);
    if (entry.missing || entry.node.type !== "dir") throw statusError("rmdir", 2, p);
    if (recursive) this.server.remove(entry.path);
    else if (this.server.childNames(entry.path).length > 0) throw statusError("rmdir", 4, p);
    else this.server.nodes.delete(entry.path);
    return "Successfully removed directory";
  }

  // Minimal ssh2 SFTP object: the callback-style calls the backend makes
  // directly.
  #rawSftp() {
    const client = this;
    const server = this.server;
    const later = (cb, fn) => {
      Promise.resolve()
        .then(fn)
        .then(
          (result) => cb(null, result),
          (err) => cb(err),
        );
    };
    return {
      mkdir(p, attrs, cb) {
        const callback = typeof attrs === "function" ? attrs : cb;
        const mode = typeof attrs === "object" && attrs && typeof attrs.mode === "number" ? attrs.mode : 0o777;
        later(callback, async () => {
          await server.before(client, "mkdir", p);
          const entry = server.entryOf(p);
          if (!entry.path) throw statusError("mkdir", 2, p);
          if (!entry.missing) throw statusError("mkdir", 4, p);
          server.nodes.set(entry.path, { type: "dir", mode: mode & ~server.options.umask & 0o7777, mtime: server.clock ?? Math.floor(Date.now() / 1000) });
          const parent = server.nodes.get(posix.dirname(entry.path));
          if (parent) server.touch(parent);
          return undefined;
        });
      },
      rmdir(p, cb) {
        later(cb, async () => {
          await server.before(client, "rmdir", p);
          const entry = server.entryOf(p);
          if (entry.missing) throw statusError("rmdir", 2, p);
          if (entry.node.type !== "dir") throw statusError("rmdir", 2, p);
          if (server.childNames(entry.path).length > 0) throw statusError("rmdir", 4, p);
          server.nodes.delete(entry.path);
          return undefined;
        });
      },
      readlink(p, cb) {
        later(cb, async () => {
          await server.before(client, "readlink", p);
          const entry = server.entryOf(p);
          if (entry.missing) throw statusError("readlink", 2, p);
          if (entry.node.type !== "link") throw statusError("readlink", 4, p);
          return entry.node.target;
        });
      },
      opendir(p, cb) {
        later(cb, async () => {
          await server.before(client, "list", p);
          const resolved = server.resolvePath(p);
          if (resolved.missing) throw statusError("opendir", 2, p);
          if (resolved.node.type !== "dir") throw statusError("opendir", 4, p);
          const names = [".", "..", ...server.childNames(resolved.path)];
          const handle = Buffer.from(`dir-${client.id}-${++server.handleCounter}`);
          server.dirHandles.set(handle.toString(), { client: client.id, path: resolved.path, names, pos: 0 });
          return handle;
        });
      },
      // Like ssh2's: "." and ".." are dropped from each reply unless
      // opts.full, so a reply of just those two comes back empty.
      readdir(handle, opts, cb) {
        const callback = typeof opts === "function" ? opts : cb;
        const full = typeof opts === "object" && opts !== null && opts.full === true;
        later(callback, async () => {
          const open = server.dirHandles.get(Buffer.from(handle).toString());
          if (!open || open.client !== client.id) throw statusError("readdir", 4, "<handle>");
          await server.before(client, "readdir", open.path);
          if (open.pos >= open.names.length) throw Object.assign(new Error("EOF"), { code: 1 });
          const batch = open.names.slice(open.pos, open.pos + server.options.readdirBatch);
          open.pos += batch.length;
          return batch.filter((name) => full || (name !== "." && name !== "..")).map((name) => {
            const node = name === "." || name === ".." ? server.nodes.get(open.path) : server.nodes.get(posix.join(open.path, name));
            const st = server.statsOf(node);
            const typeChar = node.type === "dir" ? "d" : node.type === "link" ? "l" : "-";
            return {
              filename: name,
              longname: `${typeChar}${permString(node.mode)}    1 ${st.uid}     ${st.gid}     ${String(st.size).padStart(8)} Jan  1 00:00 ${name}`,
              attrs: { mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: st.accessTime / 1000, mtime: st.modifyTime / 1000 },
            };
          });
        });
      },
      close(handle, cb) {
        later(cb, async () => {
          server.dirHandles.delete(Buffer.from(handle).toString());
          return undefined;
        });
      },
      setstat(p, attrs, cb) {
        later(cb, async () => {
          await server.before(client, "setstat", p);
          if (server.denySetstat) throw statusError("setstat", 3, p);
          const resolved = server.resolvePath(p);
          if (resolved.missing) throw statusError("setstat", 2, p);
          if (typeof attrs?.mode === "number") resolved.node.mode = attrs.mode & 0o7777;
          if (Number.isInteger(attrs?.uid)) resolved.node.uid = attrs.uid;
          if (Number.isInteger(attrs?.gid)) resolved.node.gid = attrs.gid;
          return undefined;
        });
      },
      ext_openssh_statvfs(p, cb) {
        if (!server.options.statvfs) throw unsupportedError();
        later(cb, async () => {
          await server.before(client, "statvfs", p);
          const resolved = server.resolvePath(p);
          if (resolved.missing) throw statusError("statvfs", 2, p);
          return { ...server.options.statvfsResult };
        });
      },
    };
  }
}

/**
 * A ready SFTP backend over a fresh fake server, with `rootPath` created and
 * described. The shape runBackendConformance() can be pointed at:
 * `{ backend, root, spec, seed, read, exists, abs, server, cleanup }`, where
 * seed.{dir,file,link} create fixtures by root-relative path.
 */
export async function createFakeSftpFixture({
  rootPath = "/srv/pz/Zomboid",
  rootId = "data",
  server: serverOptions = {},
  settings: extraSettings = {},
  timeouts,
} = {}) {
  const server = new FakeSftpServer(serverOptions);
  server.mkdirp(rootPath);
  const settings = {
    panelBridgeSftpHost: "sftp.test",
    panelBridgeSftpPort: 2222,
    panelBridgeSftpUsername: "pz",
    panelBridgeSftpPassword: "fake-sftp-password",
    ...extraSettings,
  };
  _setFileManagerSftpTestHooks({ clientFactory: server.clientFactory, timeouts });
  const backend = createSftpBackend({ settings });
  const spec = { id: rootId, path: rootPath, warnings: [] };
  const root = await backend.describeRoot(spec);
  const abs = (rel = "") => (rel ? posix.join(rootPath, rel) : rootPath);
  return {
    server,
    settings,
    backend,
    spec,
    root,
    rootPath,
    abs,
    seed: {
      dir: (rel, opts) => server.mkdirp(abs(rel), opts),
      file: (rel, data, opts) => server.writeFile(abs(rel), data, opts),
      link: (rel, target) => server.symlink(abs(rel), target),
    },
    read: (rel) => server.readFile(abs(rel)),
    exists: (rel) => server.exists(abs(rel)),
    cleanup: () => _setFileManagerSftpTestHooks(),
  };
}
