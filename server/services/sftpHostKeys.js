// Host-key pinning (trust on first use) for every outbound SFTP connection.
//
// security audit M3: ssh2 accepts any server host key unless a hostVerifier
// is supplied, so an on-path attacker could impersonate a remote server and
// harvest the stored SFTP password (and, through the PanelBridge, write
// command files the remote mod executes). Pins are kept in panel settings:
//
//   sftpKnownHosts = { "host:port": "<sha256 hex of the server key>" }
//
// First connection to a host trusts and pins its key (logged); every later
// connection must present the same key or is refused. A refusal is kept in
// memory with the key the server presented, and Settings › PanelBridge ›
// SFTP shows both fingerprints. After a legitimate key change (a rebuilt or
// reinstalled server) the operator compares the presented fingerprint with
// the one their host reports and chooses "Trust new host key", which pins
// exactly that fingerprint (trustHostKey() below, POST
// /api/panel-bridge/sftp/trust-host-key). Nothing ever goes back to "trust
// whatever key comes next".
import { createHash } from "node:crypto";
import { getSetting, setSetting } from "../database/init.js";
import { ErrorCode } from "../utils/errorCodes.js";

export const KNOWN_HOSTS_SETTING = "sftpKnownHosts";

// The bridge reconnects on every poll (2-10 s) and the Files pool on every
// request, so a mismatched host is refused hundreds of times an hour. Each
// host and presented key is logged at error level once a minute, matching
// the SFTP transport's own deduplication of identical errors.
export const REFUSAL_LOG_INTERVAL_MS = 60_000;
// Refusals are only remembered for the hosts this panel connects to; the
// cap keeps a test form pointed at many hosts from growing the map forever.
const MAX_REFUSALS = 32;

const normalizeHost = (host) => String(host || "").trim().toLowerCase();
const normalizePort = (port) => Number(port) || 22;
const hostId = (host, port) => `${normalizeHost(host)}:${normalizePort(port)}`;

export const fingerprintOf = (rawKey) =>
  createHash("sha256").update(rawKey).digest("hex");

// OpenSSH-style display (SHA256:<base64, no padding>) for logs, errors and
// the UI: the same text `ssh-keygen -lf` prints, so an operator can compare
// it with what their host reports.
export const shortFingerprint = (hex) =>
  `SHA256:${Buffer.from(hex, "hex").toString("base64").replace(/=+$/, "")}`;

/**
 * Accept the display form ("SHA256:<base64>") or 64 hex digits; return the
 * hex digest, or null for anything else.
 */
export function parseFingerprint(value) {
  const text = String(value ?? "").trim();
  if (/^[0-9a-f]{64}$/i.test(text)) return text.toLowerCase();
  const match = /^SHA256:([A-Za-z0-9+/]{43})=?$/.exec(text);
  if (!match) return null;
  const hex = Buffer.from(match[1], "base64").toString("hex");
  return hex.length === 64 ? hex : null;
}

class PinStoreCorruptError extends Error {}

async function readPins() {
  const raw = await getSetting(KNOWN_HOSTS_SETTING);
  if (!raw) return {};
  // A corrupted pin store is not "no pins yet": fail closed by throwing, so
  // verifyHostKey() refuses instead of silently re-trusting every host.
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (error) {
    throw new PinStoreCorruptError(`saved host keys are not valid JSON (${error.message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PinStoreCorruptError("saved host keys are not a host-to-key map");
  }
  return parsed;
}

// One pin-store read-modify-write at a time: two first connections to
// different hosts must not each write a copy that drops the other's pin,
// and a trust must not race a verification of the same host.
let pinLock = Promise.resolve();
function withPinLock(fn) {
  const run = pinLock.then(fn, fn);
  pinLock = run.catch(() => {});
  return run;
}

const refusals = new Map();

function recordRefusal(host, port, pinned, presented, reason, now) {
  const id = hostId(host, port);
  const previous = refusals.get(id);
  const sameKey = previous && previous.presented === presented && previous.pinned === pinned;
  const shouldLog = !sameKey || now - previous.loggedAt >= REFUSAL_LOG_INTERVAL_MS;
  refusals.delete(id); // re-insert so the map stays ordered oldest-first
  refusals.set(id, {
    host: normalizeHost(host),
    port: normalizePort(port),
    pinned,
    presented,
    reason,
    firstSeenAt: sameKey ? previous.firstSeenAt : now,
    lastSeenAt: now,
    attempts: sameKey ? previous.attempts + 1 : 1,
    loggedAt: shouldLog ? now : previous.loggedAt,
  });
  while (refusals.size > MAX_REFUSALS) refusals.delete(refusals.keys().next().value);
  return shouldLog;
}

function refusalView(record) {
  return {
    host: record.host,
    port: record.port,
    pinned: record.pinned ? shortFingerprint(record.pinned) : null,
    presented: shortFingerprint(record.presented),
    reason: record.reason,
    firstSeenAt: new Date(record.firstSeenAt).toISOString(),
    lastSeenAt: new Date(record.lastSeenAt).toISOString(),
    attempts: record.attempts,
  };
}

/** The last refused key for one host, or null. */
export function getHostKeyRefusal(host, port) {
  const record = refusals.get(hostId(host, port));
  return record ? refusalView(record) : null;
}

/** Every host whose key is currently refused, most recent last. */
export function listHostKeyRefusals() {
  return [...refusals.values()].map(refusalView);
}

/** Test seam: forget in-memory refusals between cases. */
export function resetHostKeyRefusals() {
  refusals.clear();
}

/**
 * Decide whether a presented server key may be used. `hashedKey` is the hex
 * SHA-256 ssh2 computed (we always pass hostHash: "sha256"). Returns true to
 * accept, false to refuse the connection. Never throws.
 */
export function verifyHostKey(host, port, hashedKey, { log, now = Date.now } = {}) {
  const id = hostId(host, port);
  return withPinLock(async () => {
    try {
      const pins = await readPins();
      const known = pins[id];
      if (!known) {
        pins[id] = hashedKey;
        await setSetting(KNOWN_HOSTS_SETTING, JSON.stringify(pins));
        refusals.delete(id);
        log?.warn?.(
          `SFTP: first connection to ${id}; trusting and pinning its host key ${shortFingerprint(hashedKey)}`,
        );
        return true;
      }
      if (known === hashedKey) {
        refusals.delete(id);
        return true;
      }
      if (recordRefusal(host, port, known, hashedKey, "mismatch", now())) {
        log?.error?.(
          `SFTP: HOST KEY MISMATCH for ${id} — pinned ${shortFingerprint(known)}, presented ${shortFingerprint(hashedKey)}. ` +
            `Refusing to connect (possible man-in-the-middle). If the server's key really changed, check the presented fingerprint with your host, ` +
            `then choose "Trust new host key" in Settings › PanelBridge › SFTP. Repeats are logged at most once a minute.`,
        );
      }
      return false;
    } catch (error) {
      // Fail closed: a pin store we cannot read is not a reason to trust a key.
      const reason = error instanceof PinStoreCorruptError ? "store-unreadable" : "store-unavailable";
      if (recordRefusal(host, port, null, hashedKey, reason, now())) {
        log?.error?.(`SFTP: host key verification for ${id} failed, refusing to connect: ${error.message}`);
      }
      return false;
    }
  });
}

export class HostKeyTrustError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Pin exactly `fingerprint` for one host, but only when it is the key that
 * host was last refused for: the operator approves the key they compared,
 * never "whatever the next connection presents". A pin store that cannot be
 * parsed protects nothing (every connection is already refused), so it is
 * reset to this one pin rather than leaving the operator stuck.
 * Returns { host, port, fingerprint, previous, storeReset? }.
 */
export function trustHostKey(host, port, fingerprint) {
  const wanted = parseFingerprint(fingerprint);
  if (!wanted) {
    return Promise.reject(
      new HostKeyTrustError(null, "A SHA256 host key fingerprint is required.", 400),
    );
  }
  const id = hostId(host, port);
  return withPinLock(async () => {
    const refusal = refusals.get(id);
    if (!refusal || refusal.presented !== wanted) {
      throw new HostKeyTrustError(
        ErrorCode.SFTP_HOST_KEY_NOT_PRESENTED,
        "This server is not presenting that host key now, so it was not trusted. Run Verify and prepare SFTP again, then compare the key the panel shows before trusting it.",
        409,
      );
    }
    let pins;
    let storeReset = false;
    try {
      pins = await readPins();
    } catch (error) {
      if (!(error instanceof PinStoreCorruptError)) throw error;
      pins = {};
      storeReset = true;
    }
    const previous = pins[id] || null;
    pins[id] = wanted;
    await setSetting(KNOWN_HOSTS_SETTING, JSON.stringify(pins));
    refusals.delete(id);
    return {
      host: normalizeHost(host),
      port: normalizePort(port),
      fingerprint: shortFingerprint(wanted),
      previous: previous ? shortFingerprint(previous) : null,
      ...(storeReset ? { storeReset: true } : {}),
    };
  });
}

// ssh2's own message when hostVerifier refuses a key (lib/protocol/kex.js).
export const HOST_KEY_REFUSED_RE = /host denied \(verification failed\)/i;

export function isHostKeyRefusal(error) {
  return HOST_KEY_REFUSED_RE.test(error?.message || String(error ?? ""));
}

/**
 * ssh2 `hostVerifier` in callback form (we must not return the promise:
 * ssh2 would treat it as a truthy value instead of awaiting it).
 */
export function hostKeyVerifier(host, port, { log } = {}) {
  return (hashedKey, verify) => {
    verifyHostKey(host, port, hashedKey, { log })
      .then((ok) => verify(ok))
      .catch(() => verify(false));
  };
}
