// A REAL SSH server (ssh2's own Server class) with an in-memory SFTP
// subsystem that answers the way OpenSSH's sftp-server does, for the Server
// Files SFTP backend's tests. The panel's own ssh2-sftp-client connects to
// it over TCP, so every stream, WRITE and READDIR batch goes through the
// real ssh2 client code -- the fake client (fakeSftp.js) returns plain Node
// streams, whose semantics hid a broken upload once (ssh2's WriteStream
// never emits 'finish', and drops a refused WRITE's error).
//
// Knobs, mutable at runtime on the returned `state`:
//   failWrites     every WRITE answers FAILURE (what a full disk or a quota gives)
//   denyOpen       Set of absolute paths whose OPEN answers PERMISSION_DENIED
//   denySetstat    SETSTAT/FSETSTAT answer PERMISSION_DENIED
//   latencyMs      delay before every answer
//   readdirBatch   names per READDIR answer (OpenSSH: about 100)
//   loginUid/Gid   owner of what the login creates
//   shortNames     Map of alias path -> real path: Windows 8.3 names on an
//                  NTFS-backed host (PANELB~1 opens panelbridge)
//   log            every request as { op, path }
// and closeChannels() on the returned handle ends every SFTP channel while
// its SSH connection stays up (the server's sftp-server exited).
import { createRequire } from "module";
import { posix } from "path";

const require = createRequire(import.meta.url);
const { Server, utils } = require("ssh2");
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

let hostKey = null;
function getHostKey() {
  // A generated key now and then fails ssh2's own parser: retry.
  for (let i = 0; !hostKey && i < 20; i++) {
    const candidate = utils.generateKeyPairSync("ed25519").private;
    if (!(utils.parseKey(candidate) instanceof Error)) hostKey = candidate;
  }
  return hostKey;
}

const now = () => Math.floor(Date.now() / 1000);

export async function startRealSshSftpServer(opts = {}) {
  const state = {
    nodes: new Map([["/", { type: "dir", mode: 0o755, uid: 0, gid: 0, mtime: now() }]]),
    failWrites: false,
    denyOpen: new Set(),
    denySetstat: false,
    latencyMs: 0,
    readdirBatch: 100,
    loginUid: opts.loginUid ?? 0,
    loginGid: opts.loginGid ?? 0,
    shortNames: new Map(),
    log: [],
  };
  const channels = new Set();

  const fs = {
    mkdirp(p, { mode = 0o755, uid = state.loginUid, gid = state.loginGid } = {}) {
      let cur = "/";
      for (const part of posix.normalize(p).split("/").filter(Boolean)) {
        cur = posix.join(cur, part);
        if (!state.nodes.has(cur)) state.nodes.set(cur, { type: "dir", mode, uid, gid, mtime: now() });
      }
    },
    writeFile(p, data, { mode = 0o644, uid = state.loginUid, gid = state.loginGid, mtime = now() - 100 } = {}) {
      fs.mkdirp(posix.dirname(p));
      state.nodes.set(p, { type: "file", mode, uid, gid, data: Buffer.from(data), mtime });
    },
    symlink(p, target) {
      fs.mkdirp(posix.dirname(p));
      state.nodes.set(p, { type: "link", target, mode: 0o777, uid: state.loginUid, gid: state.loginGid, mtime: now() });
    },
    readFile(p) {
      const n = state.nodes.get(p);
      return n && n.type === "file" ? n.data : null;
    },
    node(p) {
      return state.nodes.get(p) || null;
    },
    children(p) {
      const prefix = p === "/" ? "/" : `${p}/`;
      return [...state.nodes.keys()]
        .filter((k) => k !== p && k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map((k) => k.slice(prefix.length))
        .sort();
    },
    allPaths() {
      return [...state.nodes.keys()].sort();
    },
  };

  function resolve(p, followLast = true, hops = 40) {
    let cur = "/";
    const parts = posix.normalize(p).split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      let next = posix.join(cur, parts[i]);
      if (!state.nodes.has(next) && state.shortNames.has(next)) next = state.shortNames.get(next);
      const n = state.nodes.get(next);
      if (!n) return null;
      if (n.type === "link" && (!last || followLast)) {
        if (--hops < 0) return null;
        const found = resolve(n.target.startsWith("/") ? n.target : posix.join(cur, n.target), true, hops);
        if (!found) return null;
        cur = found;
        continue;
      }
      cur = next;
    }
    return cur;
  }
  function entryPath(p) {
    const abs = posix.normalize(p);
    if (abs === "/") return "/";
    const parent = resolve(posix.dirname(abs));
    if (!parent) return null;
    const entry = posix.join(parent, posix.basename(abs));
    return !state.nodes.has(entry) && state.shortNames.has(entry) ? state.shortNames.get(entry) : entry;
  }
  function attrsOf(n) {
    const typeBits = n.type === "dir" ? S_IFDIR : n.type === "link" ? S_IFLNK : S_IFREG;
    const size = n.type === "file" ? n.data.length : n.type === "link" ? n.target.length : 4096;
    return { mode: typeBits | n.mode, uid: n.uid, gid: n.gid, size, atime: n.mtime, mtime: n.mtime };
  }
  function perm(mode) {
    const chars = "rwxrwxrwx";
    let out = "";
    for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? chars[i] : "-";
    return out;
  }
  function touchParent(p) {
    const parent = state.nodes.get(posix.dirname(p));
    if (parent) parent.mtime = now();
  }

  const server = new Server({ hostKeys: [getHostKey()] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => (ctx.method === "password" ? ctx.accept() : ctx.reject(["password"])));
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          channels.add(sftp);
          sftp.on("close", () => channels.delete(sftp));
          const handles = new Map();
          let nextHandle = 1;
          const newHandle = (value) => {
            const h = Buffer.alloc(4);
            h.writeUInt32BE(nextHandle++);
            handles.set(h.toString("hex"), value);
            return h;
          };
          const reply = (fn) => (state.latencyMs > 0 ? setTimeout(fn, state.latencyMs) : setImmediate(fn));
          const status = (id, code, msg) => reply(() => sftp.status(id, code, msg));
          const log = (op, path) => state.log.push({ op, path });
          const applyAttrs = (n, attrs) => {
            if (typeof attrs.mode === "number") n.mode = attrs.mode & 0o7777;
            if (typeof attrs.uid === "number") n.uid = attrs.uid;
            if (typeof attrs.gid === "number") n.gid = attrs.gid;
          };

          sftp.on("OPEN", (id, filename, flags, attrs) => {
            log("OPEN", filename);
            if (state.denyOpen.has(filename)) return status(id, STATUS_CODE.PERMISSION_DENIED, "Permission denied");
            const ep = entryPath(filename);
            if (!ep) return status(id, STATUS_CODE.NO_SUCH_FILE, "No such file");
            const existing = resolve(ep);
            if (existing) {
              if (flags & OPEN_MODE.EXCL && flags & OPEN_MODE.CREAT) return status(id, STATUS_CODE.FAILURE, "Failure");
              const n = state.nodes.get(existing);
              if (n.type !== "file") return status(id, STATUS_CODE.FAILURE, "Failure");
              if (flags & OPEN_MODE.TRUNC) n.data = Buffer.alloc(0);
              return reply(() => sftp.handle(id, newHandle({ kind: "file", path: existing })));
            }
            if (!(flags & OPEN_MODE.CREAT)) return status(id, STATUS_CODE.NO_SUCH_FILE, "No such file");
            const mode = (typeof attrs?.mode === "number" ? attrs.mode : 0o666) & 0o7777 & ~0o022;
            state.nodes.set(ep, { type: "file", mode, uid: state.loginUid, gid: state.loginGid, data: Buffer.alloc(0), mtime: now() });
            touchParent(ep);
            return reply(() => sftp.handle(id, newHandle({ kind: "file", path: ep })));
          });
          sftp.on("READ", (id, handle, offset, length) => {
            const h = handles.get(handle.toString("hex"));
            if (!h) return status(id, STATUS_CODE.FAILURE);
            const n = state.nodes.get(h.path);
            if (!n || offset >= n.data.length) return status(id, STATUS_CODE.EOF);
            const chunk = Buffer.from(n.data.subarray(offset, Math.min(n.data.length, offset + length)));
            return reply(() => sftp.data(id, chunk));
          });
          sftp.on("WRITE", (id, handle, offset, data) => {
            const h = handles.get(handle.toString("hex"));
            log("WRITE", h?.path);
            if (!h) return status(id, STATUS_CODE.FAILURE);
            if (state.failWrites) return status(id, STATUS_CODE.FAILURE, "Failure");
            const n = state.nodes.get(h.path);
            const need = offset + data.length;
            if (n.data.length < need) n.data = Buffer.concat([n.data, Buffer.alloc(need - n.data.length)]);
            Buffer.from(data).copy(n.data, offset);
            n.mtime = now();
            return status(id, STATUS_CODE.OK);
          });
          sftp.on("FSTAT", (id, handle) => {
            const h = handles.get(handle.toString("hex"));
            const n = h && state.nodes.get(h.path);
            if (!n) return status(id, STATUS_CODE.FAILURE);
            return reply(() => sftp.attrs(id, attrsOf(n)));
          });
          sftp.on("FSETSTAT", (id, handle, attrs) => {
            const h = handles.get(handle.toString("hex"));
            const n = h && state.nodes.get(h.path);
            log("FSETSTAT", h?.path);
            if (!n) return status(id, STATUS_CODE.FAILURE);
            if (state.denySetstat) return status(id, STATUS_CODE.PERMISSION_DENIED, "Permission denied");
            applyAttrs(n, attrs);
            return status(id, STATUS_CODE.OK);
          });
          sftp.on("SETSTAT", (id, path, attrs) => {
            log("SETSTAT", path);
            if (state.denySetstat) return status(id, STATUS_CODE.PERMISSION_DENIED, "Permission denied");
            const r = resolve(path);
            if (!r) return status(id, STATUS_CODE.NO_SUCH_FILE);
            applyAttrs(state.nodes.get(r), attrs);
            return status(id, STATUS_CODE.OK);
          });
          sftp.on("CLOSE", (id, handle) => {
            const key = handle.toString("hex");
            log("CLOSE", handles.get(key)?.path);
            if (!handles.has(key)) return status(id, STATUS_CODE.FAILURE);
            handles.delete(key);
            return status(id, STATUS_CODE.OK);
          });
          sftp.on("OPENDIR", (id, path) => {
            log("OPENDIR", path);
            const r = resolve(path);
            if (!r) return status(id, STATUS_CODE.NO_SUCH_FILE, "No such file");
            if (state.nodes.get(r).type !== "dir") return status(id, STATUS_CODE.FAILURE);
            const names = [".", "..", ...fs.children(r)];
            return reply(() => sftp.handle(id, newHandle({ kind: "dir", path: r, names, pos: 0 })));
          });
          sftp.on("READDIR", (id, handle) => {
            const h = handles.get(handle.toString("hex"));
            log("READDIR", h?.path);
            if (!h || h.kind !== "dir") return status(id, STATUS_CODE.FAILURE);
            if (h.pos >= h.names.length) return status(id, STATUS_CODE.EOF);
            const batch = h.names.slice(h.pos, h.pos + state.readdirBatch);
            h.pos += batch.length;
            const list = batch.map((name) => {
              const n = name === "." || name === ".." ? state.nodes.get(h.path) : state.nodes.get(posix.join(h.path, name));
              const a = attrsOf(n);
              const t = n.type === "dir" ? "d" : n.type === "link" ? "l" : "-";
              return { filename: name, longname: `${t}${perm(n.mode)}    1 ${n.uid} ${n.gid} ${a.size} Jan  1 00:00 ${name}`, attrs: a };
            });
            return reply(() => sftp.name(id, list));
          });
          const statHandler = (follow) => (id, path) => {
            log(follow ? "STAT" : "LSTAT", path);
            const p = follow ? resolve(path) : entryPath(path);
            const n = p && state.nodes.get(p);
            if (!n) return status(id, STATUS_CODE.NO_SUCH_FILE, "No such file");
            return reply(() => sftp.attrs(id, attrsOf(n)));
          };
          sftp.on("LSTAT", statHandler(false));
          sftp.on("STAT", statHandler(true));
          sftp.on("REMOVE", (id, path) => {
            log("REMOVE", path);
            const ep = entryPath(path);
            const n = ep && state.nodes.get(ep);
            if (!n) return status(id, STATUS_CODE.NO_SUCH_FILE, "No such file");
            if (n.type === "dir") return status(id, STATUS_CODE.FAILURE);
            state.nodes.delete(ep);
            touchParent(ep);
            return status(id, STATUS_CODE.OK);
          });
          sftp.on("RMDIR", (id, path) => {
            log("RMDIR", path);
            const ep = entryPath(path);
            const n = ep && state.nodes.get(ep);
            if (!n) return status(id, STATUS_CODE.NO_SUCH_FILE, "No such file");
            if (n.type !== "dir" || fs.children(ep).length) return status(id, STATUS_CODE.FAILURE);
            state.nodes.delete(ep);
            touchParent(ep);
            return status(id, STATUS_CODE.OK);
          });
          sftp.on("MKDIR", (id, path, attrs) => {
            log("MKDIR", path);
            const ep = entryPath(path);
            if (!ep) return status(id, STATUS_CODE.NO_SUCH_FILE, "No such file");
            if (state.nodes.has(ep)) return status(id, STATUS_CODE.FAILURE);
            const mode = (typeof attrs?.mode === "number" ? attrs.mode : 0o777) & 0o7777 & ~0o022;
            state.nodes.set(ep, { type: "dir", mode, uid: state.loginUid, gid: state.loginGid, mtime: now() });
            touchParent(ep);
            return status(id, STATUS_CODE.OK);
          });
          sftp.on("RENAME", (id, from, to) => {
            log("RENAME", `${from} -> ${to}`);
            const src = entryPath(from);
            if (!src || !state.nodes.has(src)) return status(id, STATUS_CODE.NO_SUCH_FILE, "No such file");
            const dst = entryPath(to);
            if (!dst) return status(id, STATUS_CODE.NO_SUCH_FILE, "No such file");
            if (state.nodes.has(dst)) return status(id, STATUS_CODE.FAILURE, "Failure");
            for (const key of [...state.nodes.keys()]) {
              if (key === src || key.startsWith(`${src}/`)) {
                const n = state.nodes.get(key);
                state.nodes.delete(key);
                state.nodes.set(dst + key.slice(src.length), n);
              }
            }
            touchParent(src);
            touchParent(dst);
            return status(id, STATUS_CODE.OK);
          });
          // Like OpenSSH's: a missing LAST component (or a dangling link's
          // missing target) is still answered, with the path it would have.
          const realPathOf = (p, hops = 40) => {
            const found = resolve(p);
            if (found || hops <= 0) return found;
            const ep = entryPath(p);
            const n = ep && state.nodes.get(ep);
            if (n?.type === "link") {
              return realPathOf(n.target.startsWith("/") ? n.target : posix.join(posix.dirname(ep), n.target), hops - 1);
            }
            return ep && !n && state.nodes.get(posix.dirname(ep))?.type === "dir" ? ep : null;
          };
          sftp.on("REALPATH", (id, path) => {
            const r = realPathOf(path === "." || path === "" ? "/" : posix.normalize(path));
            if (!r) return status(id, STATUS_CODE.NO_SUCH_FILE, "No such file");
            return reply(() => sftp.name(id, [{ filename: r, longname: r, attrs: {} }]));
          });
          sftp.on("READLINK", (id, path) => {
            const ep = entryPath(path);
            const n = ep && state.nodes.get(ep);
            if (!n || n.type !== "link") return status(id, STATUS_CODE.FAILURE);
            return reply(() => sftp.name(id, [{ filename: n.target, longname: n.target, attrs: {} }]));
          });
          sftp.on("SYMLINK", (id) => status(id, STATUS_CODE.OP_UNSUPPORTED));
        });
      });
    });
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  return {
    state,
    fs,
    port,
    closeChannels: () => {
      for (const channel of channels) channel.end();
    },
    settings: {
      panelBridgeSftpHost: "127.0.0.1",
      panelBridgeSftpPort: port,
      panelBridgeSftpUsername: "pz",
      panelBridgeSftpPassword: `pw-${port}`,
    },
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        // close() waits for live connections; the pool closes its own.
        setTimeout(done, 500).unref?.();
      }),
  };
}
