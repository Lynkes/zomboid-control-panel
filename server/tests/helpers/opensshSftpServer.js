// A REAL OpenSSH sftp-server behind an ssh2 SSH server, for the Server Files
// SFTP backend's tests. The panel's own ssh2-sftp-client connects over TCP to
// an ssh2 Server (same host key and password auth as realSshSftpServer.js)
// whose "sftp" subsystem is piped, byte for byte, to a spawned sftp-server
// binary on stdio -- so every reply, status code, READDIR batch, rename rule
// and extension is OpenSSH's own, not a model of it. (The in-memory servers,
// fakeSftp.js and realSshSftpServer.js, answer the way their authors thought
// OpenSSH does; this one can't be wrong about that.)
//
// Each SFTP session spawns its own sftp-server, with its working directory
// (and `-d`, its start directory) set to a fresh temp folder, `localRoot`.
// `denyRequests` (mutable on the returned handle, read at each session's
// spawn) becomes sftp-server's `-P` list: a denied request is answered
// PERMISSION_DENIED, which is how an admin's `ForceCommand internal-sftp -P
// posix-rename` (or a hosting panel's equivalent) looks to the client.
// `umask` becomes `-u`. `latencyMs` (mutable) holds back each chunk of
// sftp-server's replies, like a slow link. `log` (mutable; on by default)
// runs sftp-server at DEBUG1 and parses what it says it did into `log`, as
// { op, path } with the ops the in-memory server logs (LSTAT, STAT,
// REALPATH, OPENDIR, READDIR, CLOSE, OPEN, SETSTAT, WRITE, RENAME,
// POSIX-RENAME, REMOVE, MKDIR, RMDIR, READLINK; a rename's path is
// "from -> to"): the server's own account of every request. When a session
// ends, sftp-server closes and logs (FORCED-CLOSE) every handle still open:
// after the pool closes its connections, `settle()` then `leakedHandles()`
// name every file or folder handle the panel never closed.
//
// Binary: $ZCP_SFTP_SERVER_BIN, else the first of Git for Windows'
// C:/Program Files/Git/usr/lib/ssh/sftp-server.exe, /usr/lib/ssh/sftp-server.exe,
// /usr/lib/openssh/sftp-server (Debian/Ubuntu, package openssh-sftp-server),
// /usr/libexec/openssh/sftp-server (Fedora/RHEL), /usr/lib/sftp-server.
// None found: `sftpServerSkipReason` says so and the suites skip -- or,
// with ZCP_REQUIRE_SFTP_SERVER=1 (CI), fail.
//
// Remote paths. On Linux and macOS a remote path IS the local path. Git for
// Windows' sftp-server is an MSYS2 (Cygwin) program: it serves the MSYS
// namespace, where C:\Users\x is /c/Users/x -- and, because MSYS mounts the
// user's temp folder on /tmp, C:\Users\x\AppData\Local\Temp\y is also
// /tmp/y. Both spellings open the same files, and REALPATH keeps whichever
// it was given (it resolves links, not mounts). `remoteRoot` is the temp
// folder in the mount's spelling (/tmp/...), and `toRemote(local)` /
// `toLocal(remote)` convert either way. The MSYS server also has Windows
// semantics underneath: names are case-insensitive, chmod only toggles the
// read-only attribute, chown is ignored, and a file symlink needs Developer
// Mode (a junction doesn't, and MSYS follows it like a symlink).
import { spawn, spawnSync } from "child_process";
import { Transform } from "stream";
import fs from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";

const require = createRequire(import.meta.url);
const { Server, utils } = require("ssh2");

const CANDIDATES = [
  "C:/Program Files/Git/usr/lib/ssh/sftp-server.exe",
  "/usr/lib/ssh/sftp-server.exe",
  "/usr/lib/openssh/sftp-server",
  "/usr/libexec/openssh/sftp-server",
  "/usr/lib/sftp-server",
];

function findBinary() {
  const fromEnv = process.env.ZCP_SFTP_SERVER_BIN;
  if (fromEnv) return fs.existsSync(fromEnv) ? fromEnv : null;
  return CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;
}

/** The sftp-server binary the suites run against, or null. */
export const SFTP_SERVER_BIN = findBinary();

/** Why the real-OpenSSH suites skip, or null when they run. */
export const sftpServerSkipReason = SFTP_SERVER_BIN
  ? null
  : process.env.ZCP_SFTP_SERVER_BIN
    ? `ZCP_SFTP_SERVER_BIN=${process.env.ZCP_SFTP_SERVER_BIN} does not exist`
    : `no OpenSSH sftp-server binary found (set ZCP_SFTP_SERVER_BIN, or install openssh-sftp-server); looked in ${CANDIDATES.join(", ")}`;

/** CI sets ZCP_REQUIRE_SFTP_SERVER=1: without a binary the suites then fail instead of skipping. */
export const SFTP_SERVER_REQUIRED = process.env.ZCP_REQUIRE_SFTP_SERVER === "1";

/**
 * An MSYS2/Cygwin build (Git for Windows): paths are /c/..., semantics are
 * NTFS's. On Windows the binary is taken to be one (Win32-OpenSSH's own
 * sftp-server spells paths /C:/... and isn't supported here).
 */
export const SFTP_SERVER_IS_MSYS = Boolean(SFTP_SERVER_BIN) && process.platform === "win32";

let hostKey = null;
function getHostKey() {
  // A generated key now and then fails ssh2's own parser: retry.
  for (let i = 0; !hostKey && i < 20; i++) {
    const candidate = utils.generateKeyPairSync("ed25519").private;
    if (!(utils.parseKey(candidate) instanceof Error)) hostKey = candidate;
  }
  return hostKey;
}

// MSYS spelling of a Windows path: C:\a\b -> /c/a/b.
function msysDrivePath(local) {
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(local);
  if (!m) return local.replace(/\\/g, "/");
  const rest = m[2].replace(/\\/g, "/");
  return `/${m[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
}

// The MSYS mount table (`mount` output: "C:/Users/x/AppData/Local/Temp on /tmp type ..."),
// longest Windows prefix first, so a path under a mount gets the mount's
// spelling (/tmp/...), the one MSYS's own tools print.
let msysMounts = null;
function getMsysMounts() {
  if (msysMounts) return msysMounts;
  msysMounts = [];
  const mountBin = path.join(path.dirname(path.dirname(path.dirname(SFTP_SERVER_BIN))), "bin", "mount.exe");
  const out = fs.existsSync(mountBin) ? spawnSync(mountBin, [], { encoding: "utf8" }).stdout || "" : "";
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.+?) on (\/\S*) type /.exec(line);
    if (!m || !/^[A-Za-z]:/.test(m[1])) continue;
    // Drive mounts (C: on /c) are the fallback spelling already.
    if (/^[A-Za-z]:$/.test(m[1])) continue;
    msysMounts.push({ win: m[1].replace(/\\/g, "/").replace(/\/+$/, ""), posix: m[2] });
  }
  msysMounts.sort((a, b) => b.win.length - a.win.length);
  return msysMounts;
}

/** A local absolute path in the server's spelling. */
export function toRemotePath(local) {
  if (!SFTP_SERVER_IS_MSYS) return local;
  const win = path.resolve(local).replace(/\\/g, "/");
  for (const { win: prefix, posix } of getMsysMounts()) {
    if (win.toLowerCase() === prefix.toLowerCase()) return posix;
    if (win.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) return `${posix === "/" ? "" : posix}${win.slice(prefix.length)}`;
  }
  return msysDrivePath(win);
}

/** A remote absolute path (either MSYS spelling) back to a local one. */
export function toLocalPath(remote) {
  if (!SFTP_SERVER_IS_MSYS) return remote;
  for (const { win, posix } of getMsysMounts()) {
    if (remote === posix) return path.normalize(win);
    if (remote.startsWith(`${posix}/`)) return path.normalize(win + remote.slice(posix.length));
  }
  const m = /^\/([a-z])(\/.*)?$/i.exec(remote);
  if (m) return path.normalize(`${m[1].toUpperCase()}:${m[2] || "/"}`);
  return remote;
}

// One line of `sftp-server -l DEBUG1` output as { op, path }, or null.
function parseLogLine(raw) {
  const line = raw.replace(/^debug1: request \d+: /, "");
  // A handle still open when its session ends: sftp-server closes it itself.
  let m = /^forced (close|closedir) "(.*?)"/.exec(line);
  if (m) return { op: "FORCED-CLOSE", path: m[2] };
  m = /^(rename|posix-rename) old "(.*)" new "(.*)"$/.exec(line);
  if (m) return { op: m[1].toUpperCase(), path: `${m[2]} -> ${m[3]}` };
  m = /^(lstat|stat|remove|mkdir|rmdir|readlink) name "(.*?)"/.exec(line);
  if (m) return { op: m[1].toUpperCase(), path: m[2] };
  m = /^(realpath|opendir|readdir|closedir|open|close|set|write|fsetstat) "(.*?)"/.exec(line);
  if (!m) return null;
  const op = { closedir: "CLOSE", set: "SETSTAT", fsetstat: "SETSTAT" }[m[1]] || m[1].toUpperCase();
  return { op, path: m[2] };
}

/**
 * Start an SSH server whose SFTP subsystem is a real OpenSSH sftp-server
 * rooted in a fresh temp folder. Throws when there is no binary (check
 * `sftpServerSkipReason` first).
 * @param {{ denyRequests?: string[], umask?: string, latencyMs?: number, log?: boolean }} [opts]
 */
export async function startOpensshSftpServer({ denyRequests = [], umask = "022", latencyMs = 0, log = true } = {}) {
  if (!SFTP_SERVER_BIN) throw new Error(sftpServerSkipReason);
  const localRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "zcp-openssh-")));
  const remoteRoot = toRemotePath(localRoot);
  const handle = {
    denyRequests: [...denyRequests],
    umask,
    latencyMs,
    stalled: false,
    /** Parse sftp-server's DEBUG1 log into `log` (read at each session's spawn). */
    logRequests: log,
    /** Every request the sftp-servers logged, as { op, path }, in arrival order. */
    log: [],
    /** sftp-server processes spawned so far (one per SFTP session). */
    sessions: 0,
    /** stderr of every sftp-server, for a failing test's message. */
    stderr: [],
    /**
     * Called with each entry as it is logged (sftp-server logs a request
     * when it reads it, before it answers), e.g. to kill the server in the
     * middle of a client's sequence of requests.
     * @type {((entry: { op: string, path: string }) => void) | null}
     */
    onRequest: null,
  };
  const children = new Set();
  const settleWaiters = [];
  const aliases = [];
  const held = [];
  const connections = new Set();

  const server = new Server({ hostKeys: [getHostKey()] }, (client) => {
    connections.add(client);
    client.on("close", () => connections.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) => (ctx.method === "password" ? ctx.accept() : ctx.reject(["password"])));
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        // No 'sftp' listener: ssh2 then hands the subsystem over as a raw
        // channel, which carries sftp-server's own bytes both ways.
        session.on("subsystem", (accept, reject, info) => {
          if (info.name !== "sftp") return reject();
          const args = ["-e", "-l", handle.logRequests ? "DEBUG1" : "ERROR", "-d", remoteRoot, "-u", handle.umask];
          if (handle.denyRequests.length) args.push("-P", handle.denyRequests.join(","));
          const child = spawn(SFTP_SERVER_BIN, args, { cwd: localRoot, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
          handle.sessions += 1;
          children.add(child);
          const channel = accept();
          // Each reply chunk waits latencyMs (in order), like a slow link;
          // while `stalled`, none gets through at all.
          const slowLink = new Transform({
            transform(chunk, _encoding, callback) {
              const pass = () => (handle.latencyMs > 0 ? setTimeout(() => callback(null, chunk), handle.latencyMs) : callback(null, chunk));
              if (handle.stalled) held.push(pass);
              else pass();
            },
          });
          child.stdout.pipe(slowLink).pipe(channel);
          channel.pipe(child.stdin);
          let pending = "";
          child.stderr.on("data", (chunk) => {
            const text = chunk.toString();
            handle.stderr.push(text);
            pending += text;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop();
            for (const line of lines) {
              const entry = parseLogLine(line.trim());
              if (entry) {
                handle.log.push(entry);
                handle.onRequest?.(entry);
              }
            }
          });
          child.on("error", (err) => {
            handle.stderr.push(String(err));
            channel.destroy();
          });
          child.stdin.on("error", () => {});
          channel.on("error", () => {});
          child.on("exit", () => {
            children.delete(child);
            if (children.size === 0) for (const done of settleWaiters.splice(0)) done();
            try {
              channel.exit(0);
            } catch {
              /* already closed */
            }
            channel.end();
          });
          channel.on("close", () => {
            if (child.exitCode === null) child.stdin.end();
          });
        });
      });
    });
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const local = (rel = "") => (rel ? path.join(localRoot, ...rel.split("/")) : localRoot);

  return Object.assign(handle, {
    port,
    localRoot,
    remoteRoot,
    local,
    remote: (rel = "") => (rel ? path.posix.join(remoteRoot, rel) : remoteRoot),
    toRemote: toRemotePath,
    toLocal: toLocalPath,
    settings: {
      panelBridgeSftpHost: "127.0.0.1",
      panelBridgeSftpPort: port,
      panelBridgeSftpUsername: "pz",
      panelBridgeSftpPassword: `pw-${port}`,
    },
    // Direct access to the served folder, by root-relative path.
    fs: {
      mkdir: (rel) => fs.mkdirSync(local(rel), { recursive: true }),
      writeFile: (rel, content) => {
        fs.mkdirSync(path.dirname(local(rel)), { recursive: true });
        fs.writeFileSync(local(rel), content);
      },
      readFile: (rel) => (fs.existsSync(local(rel)) && fs.lstatSync(local(rel)).isFile() ? fs.readFileSync(local(rel)) : null),
      exists: (rel) => {
        try {
          fs.lstatSync(local(rel));
          return true;
        } catch {
          return false;
        }
      },
      children: (rel = "") => {
        try {
          return fs.readdirSync(local(rel)).sort();
        } catch {
          return [];
        }
      },
    },
    /** Hold every reply back (true), or let the held ones through (false). */
    stall: (on) => {
      handle.stalled = Boolean(on);
      if (!on) for (const pass of held.splice(0)) pass();
    },
    /** Kill every sftp-server: each SFTP channel closes, its SSH connection stays. */
    killSessions: () => {
      for (const child of children) child.kill("SIGKILL");
    },
    /** Cut every SSH connection off, like a network drop. */
    dropConnections: () => {
      for (const connection of connections) connection._sock?.destroy();
    },
    /**
     * Wait (up to `ms`) until every sftp-server has exited. Once the pool
     * has closed its connections, each server has logged a FORCED-CLOSE for
     * every handle the panel left open.
     */
    settle: (ms = 3000) =>
      new Promise((done) => {
        if (children.size === 0) return done();
        settleWaiters.push(done);
        setTimeout(done, ms).unref?.();
      }),
    /**
     * A second spelling of `remoteRoot` that the server's REALPATH turns
     * back into `remoteRoot`: a link to the folder (a junction on Windows,
     * which MSYS follows like a symlink and needs no Developer Mode).
     */
    aliasRoot: () => {
      const alias = `${localRoot}-alias`;
      if (!fs.existsSync(alias)) fs.symlinkSync(localRoot, alias, process.platform === "win32" ? "junction" : "dir");
      aliases.push(alias);
      return toRemotePath(alias);
    },
    /** The files and folders whose handles the panel never closed (after settle()). */
    leakedHandles: () => handle.log.filter((e) => e.op === "FORCED-CLOSE").map((e) => e.path),
    close: () =>
      new Promise((done) => {
        for (const child of children) child.kill();
        server.close(() => done());
        // close() waits for live connections; the pool closes its own.
        setTimeout(done, 500).unref?.();
      }).then(() => {
        // The link only, never what it points at (a junction is removed
        // with rmdir on Windows).
        for (const alias of aliases) {
          try {
            fs.unlinkSync(alias);
          } catch {
            try {
              fs.rmdirSync(alias);
            } catch {
              /* already gone */
            }
          }
        }
        try {
          fs.rmSync(localRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {
          /* best effort: a Windows handle still closing */
        }
      }),
  });
}
