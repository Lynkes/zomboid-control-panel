// SFTP connections for Server Files (spec §A12), kept apart from
// PanelBridgeSftpTransport so a slow download or a big listing can never
// stall the bridge's poll loop.
//
// One pool per SFTP login, keyed by sha256(host|port|user|password): a
// credentials change gets a new pool and closes the old one. A pool holds at
// most three ssh2-sftp-client connections, opened on first use and closed
// after a minute idle: one for metadata calls (list, stat, rename, small
// reads and writes) and two for streamed transfers. The password is read from
// settings here and never leaves this module: the backend only ever sees a
// pool handle.
//
// There is no host-key verification, the same as the two SFTP clients that
// already send this password on every poll (spec F10; pinning is a follow-up
// for all three at once).
import crypto from "crypto";
import SftpClient from "ssh2-sftp-client";
import { ErrorCode } from "../utils/errorCodes.js";
import { createLogger } from "../utils/logger.js";
import { FM_LIMITS, FmError } from "./fileManagerContract.js";
import { classifySftpErrorCode } from "./panelBridgeSftp.js";
import { validateRemoteConfigTransport } from "./remoteConfigFiles.js";

const log = createLogger("FileManager:SFTP");

// SSH_FX_* status codes (SFTP draft 02 §7). ssh2 puts them on err.code.
const SFTP_STATUS = Object.freeze({
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
});
const SFTP_STATUS_NAMES = new Map(Object.entries(SFTP_STATUS).map(([name, value]) => [value, name]));
export { SFTP_STATUS };

const TRANSFER_CLIENTS = FM_LIMITS.SFTP_MAX_CLIENTS - 1;
// Each in-flight ssh2-sftp-client call adds three listeners to the shared
// ssh2 connection; past ten, Node warns. Metadata calls queue beyond this.
const META_MAX_IN_FLIGHT = 6;
// connect() carries its own readyTimeout; this only catches a connect that
// never settles at all.
const CONNECT_GRACE_MS = 5000;
// After end(), a connection that still hasn't closed is destroyed.
const END_GRACE_MS = 2000;

const DEFAULT_TIMEOUTS = Object.freeze({
  readyMs: FM_LIMITS.SFTP_READY_TIMEOUT_MS,
  opMs: FM_LIMITS.SFTP_OP_TIMEOUT_MS,
  transferIdleMs: FM_LIMITS.SFTP_TRANSFER_IDLE_MS,
  idleCloseMs: FM_LIMITS.SFTP_IDLE_CLOSE_MS,
});

let timeouts = DEFAULT_TIMEOUTS;

function defaultClientFactory(name, callbacks) {
  return new SftpClient(name, callbacks);
}

let clientFactory = defaultClientFactory;

/** The timeouts in force (FM_LIMITS unless a test replaced them). */
export function getFileManagerSftpTimeouts() {
  return timeouts;
}

/**
 * Test seam: swap the SftpClient constructor (fakeSftp.js) and shorten the
 * timeouts. Called with no arguments, restores both and drops every pool.
 * @param {{ clientFactory?: (name: string, callbacks: object) => object, timeouts?: Partial<typeof DEFAULT_TIMEOUTS> }} [hooks]
 */
export function _setFileManagerSftpTestHooks({ clientFactory: factory, timeouts: overrides } = {}) {
  clientFactory = factory || defaultClientFactory;
  timeouts = Object.freeze({ ...DEFAULT_TIMEOUTS, ...(overrides || {}) });
  const all = [...pools.values()];
  pools.clear();
  for (const pool of all) void pool.close();
}

// ============================================
// Errors
// ============================================

const SFTP_INFO = Symbol("fileManagerSftpInfo");

/**
 * What the pool learned about the SFTP failure behind an FmError, kept off
 * the wire (a non-enumerable symbol property): the raw status, whether the
 * server lacks the extension that was called, and whether the connection
 * died.
 * @returns {{ status: unknown, unsupported: boolean, connectionLost: boolean }|null}
 */
export function sftpInfo(err) {
  return (err && err[SFTP_INFO]) || null;
}

function messageOf(err) {
  return typeof err?.message === "string" ? err.message : String(err ?? "");
}

function isUnsupported(err) {
  return err?.code === SFTP_STATUS.OP_UNSUPPORTED || /does not support|not supported|unsupported/i.test(messageOf(err));
}

const CONNECTION_LOST_CODES = new Set([
  SFTP_STATUS.NO_CONNECTION,
  SFTP_STATUS.CONNECTION_LOST,
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ERR_NOT_CONNECTED",
]);

// "No response from server" is what ssh2 fails every pending request with
// when the SFTP channel closes under it.
function isConnectionLost(err) {
  return (
    CONNECTION_LOST_CODES.has(err?.code) ||
    /no sftp connection|not connected|unexpected (?:end|close) event|connection lost|socket hang up|no response from server/i.test(
      messageOf(err),
    )
  );
}

// A short, path-free word for params.detail: the SSH_FX name for a status
// code, an errno-style code as is, else "UNKNOWN". The raw message never
// leaves the server (it holds remote paths).
function statusDetail(status) {
  if (typeof status === "number") return SFTP_STATUS_NAMES.get(status) || "UNKNOWN";
  if (typeof status === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(status)) return status;
  return "UNKNOWN";
}

/**
 * Map anything an SFTP call threw to an FmError (spec §A12): "No such file"
 * is FM_NOT_FOUND, "Permission denied" is FM_OS_PERMISSION_DENIED, and the
 * rest is FM_SFTP_ERROR with the classifier's SFTP_* code in params.sftpCode.
 * @returns {FmError}
 */
export function toFmError(err) {
  if (err instanceof FmError) return err;
  const message = messageOf(err);
  const status = err?.code;
  let fmError;
  if (status === SFTP_STATUS.NO_SUCH_FILE || status === "ENOENT" || /no such file/i.test(message)) {
    fmError = new FmError(ErrorCode.FM_NOT_FOUND);
  } else if (status === SFTP_STATUS.PERMISSION_DENIED || status === "EACCES" || /permission denied/i.test(message)) {
    fmError = new FmError(ErrorCode.FM_OS_PERMISSION_DENIED, undefined, { detail: "EACCES" });
  } else {
    fmError = new FmError(ErrorCode.FM_SFTP_ERROR, undefined, {
      sftpCode: classifySftpErrorCode(err),
      detail: statusDetail(status),
    });
  }
  Object.defineProperty(fmError, SFTP_INFO, {
    value: { status, unsupported: isUnsupported(err), connectionLost: isConnectionLost(err) },
  });
  return fmError;
}

class SftpTimeoutError extends Error {}

// Race `promise` against a timer. The loser is silenced so a call that
// settles after its timeout can't surface as an unhandled rejection.
function withTimeout(promise, ms) {
  let timer;
  promise.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SftpTimeoutError("timed out")), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function endQuietly(client) {
  Promise.resolve()
    .then(() => client.end())
    .catch(() => {});
  // end() waits for the server to close the channel; a wedged connection
  // never does, so the socket is destroyed after a grace period.
  const timer = setTimeout(() => {
    try {
      client.client?.destroy?.();
    } catch {
      /* already gone */
    }
  }, END_GRACE_MS);
  timer.unref?.();
}

function createSemaphore(max) {
  let active = 0;
  const waiters = [];
  return {
    acquire() {
      if (active < max) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    release() {
      const next = waiters.shift();
      if (next) next();
      else active -= 1;
    },
  };
}

// ============================================
// Pool
// ============================================

class FileManagerSftpPool {
  #transport;
  #meta = null;
  #transfers = [];
  #metaSlots = createSemaphore(META_MAX_IN_FLIGHT);
  #closed = false;

  constructor(transport) {
    this.#transport = transport;
    /** Random per pool; safe to key caches on (unlike the credentials hash). */
    this.id = crypto.randomBytes(8).toString("hex");
    this.remote = Object.freeze({ host: transport.host, port: transport.port, username: transport.username });
    /** Learned per server: null until tried. */
    this.capabilities = { posixRename: null, statvfs: null, fsync: null };
  }

  /** Open connections, for tests and diagnostics. */
  get openClients() {
    return (this.#meta && !this.#meta.dead ? 1 : 0) + this.#transfers.filter((entry) => !entry.dead).length;
  }

  #refuseIfClosed() {
    if (this.#closed) {
      throw new FmError(ErrorCode.FM_ROOT_UNAVAILABLE, 503, { reason: "sftpUnreachable" });
    }
  }

  #open(kind) {
    const entry = {
      kind,
      client: null,
      ready: null,
      active: 0,
      dead: false,
      ended: false,
      idleTimer: null,
      // Called once, with an Error, when the connection or its SFTP channel
      // goes while transfers are on it.
      lostListeners: new Set(),
    };
    const markDead = (err) => {
      entry.dead = true;
      notifyLost(entry, err);
    };
    const client = clientFactory(`FileManager-${kind}`, {
      error: (err) => {
        markDead(err);
        log.debug(`SFTP ${kind} connection error: ${messageOf(err)}`);
      },
      end: () => markDead(),
      close: () => markDead(),
    });
    entry.client = client;
    const { host, port, username, password } = this.#transport;
    const connecting = Promise.resolve().then(() =>
      client.connect({ host, port, username, password, readyTimeout: timeouts.readyMs }),
    );
    entry.ready = withTimeout(connecting, timeouts.readyMs + CONNECT_GRACE_MS).then(
      () => {
        // The SFTP channel can close under a live SSH connection (the
        // server's sftp-server exited, or was killed), and ssh2 then never
        // answers another request on it: each would hang until its timeout.
        // A closed channel retires the connection, like a closed socket (an
        // idle one is closed now; a busy one once its calls have failed).
        const channel = client.sftp;
        const retire = () => {
          markDead(channelClosedError());
          if (entry.active === 0) this.#discard(entry);
        };
        if (channel && typeof channel.once === "function") {
          channel.once("close", retire);
          channel.once("end", retire);
        }
        return entry;
      },
      (err) => {
        this.#discard(entry);
        if (err instanceof SftpTimeoutError) throw new FmError(ErrorCode.FM_SFTP_TIMEOUT);
        const fmError = toFmError(err);
        log.debug(`SFTP ${kind} connect to ${host}:${port} failed: ${fmError.params.sftpCode || fmError.code}`);
        throw fmError;
      },
    );
    entry.ready.catch(() => {});
    return entry;
  }

  #take(entry) {
    entry.active += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  #release(entry) {
    entry.active -= 1;
    if (entry.active > 0) return;
    // Its connection or its SFTP channel went while it was busy: close it.
    if (entry.dead) {
      this.#discard(entry);
      return;
    }
    entry.idleTimer = setTimeout(() => {
      if (entry.active === 0) this.#discard(entry);
    }, timeouts.idleCloseMs);
    entry.idleTimer.unref?.();
  }

  #discard(entry) {
    entry.dead = true;
    // Ending it ourselves (a stalled transfer, a timeout, the pool closing)
    // fails whatever else is still on it now, not after its own time limit.
    notifyLost(entry);
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (this.#meta === entry) this.#meta = null;
    this.#transfers = this.#transfers.filter((other) => other !== entry);
    if (!entry.ended && entry.client) {
      entry.ended = true;
      endQuietly(entry.client);
    }
  }

  #selectMeta() {
    this.#refuseIfClosed();
    if (this.#meta && this.#meta.dead) this.#discard(this.#meta);
    if (!this.#meta) this.#meta = this.#open("meta");
    const entry = this.#meta;
    this.#take(entry);
    return entry;
  }

  #selectTransfer() {
    this.#refuseIfClosed();
    for (const entry of this.#transfers.filter((other) => other.dead)) this.#discard(entry);
    let best = null;
    for (const entry of this.#transfers) {
      if (!best || entry.active < best.active) best = entry;
    }
    if (!best || (best.active > 0 && this.#transfers.length < TRANSFER_CLIENTS)) {
      best = this.#open("transfer");
      this.#transfers.push(best);
    }
    this.#take(best);
    return best;
  }

  async #attempt(fn) {
    const entry = this.#selectMeta();
    try {
      await entry.ready;
      return await withTimeout(Promise.resolve().then(() => fn(entry.client)), timeouts.opMs);
    } catch (err) {
      if (err instanceof SftpTimeoutError) {
        // A call that hangs past the limit means a wedged connection: drop
        // it, so the next call gets a fresh one.
        this.#discard(entry);
        throw new FmError(ErrorCode.FM_SFTP_TIMEOUT);
      }
      const fmError = toFmError(err);
      if (sftpInfo(fmError)?.connectionLost) this.#discard(entry);
      throw fmError;
    } finally {
      this.#release(entry);
    }
  }

  /**
   * Run one metadata call, `fn(client)`, on the metadata connection under
   * the 20 s operation timeout. Only idempotent reads pass `retry: true`:
   * they get one reconnect-and-retry when the connection itself died
   * (a pooled connection the server dropped while idle). Timeouts and every
   * other failure are not retried.
   * @template T
   * @param {(client: object) => Promise<T>} fn
   * @param {{ retry?: boolean }} [opts]
   * @returns {Promise<T>}
   * @throws {FmError}
   */
  async run(fn, { retry = false } = {}) {
    await this.#metaSlots.acquire();
    try {
      try {
        return await this.#attempt(fn);
      } catch (err) {
        if (!retry || !sftpInfo(err)?.connectionLost) throw err;
        log.debug("SFTP metadata connection was lost; reconnecting once for a read");
        return await this.#attempt(fn);
      }
    } finally {
      this.#metaSlots.release();
    }
  }

  /**
   * Lease a transfer connection for a streamed read or write. The caller
   * enforces the transfer idle timeout itself and must call release() when
   * done, or discard() when the transfer stalled or the connection broke.
   * onLost(fn) calls fn(err) at once if the connection (or its SFTP channel)
   * goes while the lease is held: ssh2 tells a paused read stream, or a
   * write stream between two writes, nothing at all.
   * @returns {Promise<{ client: object, release: () => void, discard: () => void, onLost: (fn: (err: Error) => void) => void }>}
   * @throws {FmError}
   */
  async lease() {
    const entry = this.#selectTransfer();
    try {
      await entry.ready;
    } catch (err) {
      this.#release(entry);
      throw err;
    }
    let done = false;
    const watchers = [];
    const unwatch = () => {
      for (const stop of watchers.splice(0)) stop();
    };
    return {
      client: entry.client,
      release: () => {
        if (done) return;
        done = true;
        unwatch();
        this.#release(entry);
      },
      discard: () => {
        if (done) return;
        done = true;
        unwatch();
        entry.active -= 1;
        this.#discard(entry);
      },
      onLost: (fn) => {
        if (done) return;
        if (entry.dead) {
          fn(connectionLostError());
          return;
        }
        watchers.push(onLost(entry, fn));
      },
    };
  }

  /** Close every connection. Later calls on this pool are refused. */
  async close() {
    this.#closed = true;
    const entries = [this.#meta, ...this.#transfers].filter(Boolean);
    for (const entry of entries) this.#discard(entry);
  }
}

// ============================================
// Losing a connection
// ============================================

function connectionLostError(cause) {
  const err = new Error("SFTP connection lost");
  err.code = typeof cause?.code === "string" && CONNECTION_LOST_CODES.has(cause.code) ? cause.code : "ECONNRESET";
  return err;
}

function channelClosedError() {
  const err = new Error("SFTP channel closed: no response from server");
  err.code = "ECONNRESET";
  return err;
}

function onLost(entry, fn) {
  entry.lostListeners.add(fn);
  return () => entry.lostListeners.delete(fn);
}

// Tell everything still on the connection that it went (once each).
function notifyLost(entry, cause) {
  if (!entry.lostListeners.size) return;
  const err = cause instanceof Error && isConnectionLost(cause) ? cause : connectionLostError(cause);
  const listeners = [...entry.lostListeners];
  entry.lostListeners.clear();
  for (const fn of listeners) {
    try {
      fn(err);
    } catch (listenerErr) {
      log.debug(`SFTP connection-lost listener failed: ${messageOf(listenerErr)}`);
    }
  }
}

const pools = new Map();

function transportFromSettings(settings) {
  const notConfigured = () => new FmError(ErrorCode.FM_ROOT_UNAVAILABLE, 503, { reason: "remoteNotConfigured" });
  if (!settings?.panelBridgeSftpHost) throw notConfigured();
  try {
    // validateRemoteConfigTransport() also insists on a config folder, which
    // the file manager doesn't need: a placeholder satisfies it and is
    // dropped.
    const { host, port, username, password } = validateRemoteConfigTransport({
      host: settings.panelBridgeSftpHost,
      port: settings.panelBridgeSftpPort,
      username: settings.panelBridgeSftpUsername,
      password: settings.panelBridgeSftpPassword,
      configPath: "/",
    });
    return { host, port, username, password };
  } catch {
    throw notConfigured();
  }
}

/**
 * The pool for the SFTP login in `settings`. A different login (host, port,
 * user or password) gets a new pool, and the previous one is closed: the SFTP
 * settings are panel-wide, so only one login is ever current.
 * @param {Record<string, unknown>} settings
 * @throws {FmError} FM_ROOT_UNAVAILABLE {reason:"remoteNotConfigured"} without a usable login
 */
export function getFileManagerSftpPool(settings) {
  const transport = transportFromSettings(settings);
  const key = crypto
    .createHash("sha256")
    .update(`${transport.host}|${transport.port}|${transport.username}|${transport.password}`)
    .digest("hex");
  let pool = pools.get(key);
  if (!pool) {
    for (const [otherKey, other] of pools) {
      pools.delete(otherKey);
      void other.close();
    }
    pool = new FileManagerSftpPool(transport);
    pools.set(key, pool);
  }
  return pool;
}

/** Close every Server Files SFTP connection (graceful shutdown). */
export async function closeFileManagerSftpPools() {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((pool) => pool.close()));
}
