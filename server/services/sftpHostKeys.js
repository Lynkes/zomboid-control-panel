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
// connection must present the same key or is refused. To re-trust a host
// after a legitimate key change (a rebuilt/reinstalled server), use
// Settings › PanelBridge › SFTP › "Trust new host key" (forgetHostKey()
// below, POST /api/panel-bridge/sftp/forget-host-key): the next connection
// pins whatever key the server presents then.
import { createHash } from "node:crypto";
import { getSetting, setSetting } from "../database/init.js";

export const KNOWN_HOSTS_SETTING = "sftpKnownHosts";

const hostId = (host, port) =>
  `${String(host || "").trim().toLowerCase()}:${Number(port) || 22}`;

export const fingerprintOf = (rawKey) =>
  createHash("sha256").update(rawKey).digest("hex");

// OpenSSH-style display (SHA256:<base64, no padding>) for logs and errors.
export const shortFingerprint = (hex) =>
  `SHA256:${Buffer.from(hex, "hex").toString("base64").replace(/=+$/, "")}`;

async function readPins() {
  const raw = await getSetting(KNOWN_HOSTS_SETTING);
  if (!raw) return {};
  // A corrupted pin store is not "no pins yet": fail closed by throwing, so
  // verifyHostKey() refuses instead of silently re-trusting every host.
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

/**
 * Decide whether a presented server key may be used. `hashedKey` is the hex
 * SHA-256 ssh2 computed (we always pass hostHash: "sha256"). Returns true to
 * accept, false to refuse the connection. Never throws.
 */
export async function verifyHostKey(host, port, hashedKey, { log } = {}) {
  try {
    const id = hostId(host, port);
    const pins = await readPins();
    const known = pins[id];
    if (!known) {
      pins[id] = hashedKey;
      await setSetting(KNOWN_HOSTS_SETTING, JSON.stringify(pins));
      log?.warn?.(
        `SFTP: first connection to ${id}; trusting and pinning its host key ${shortFingerprint(hashedKey)}`,
      );
      return true;
    }
    if (known === hashedKey) return true;
    log?.error?.(
      `SFTP: HOST KEY MISMATCH for ${id} — pinned ${shortFingerprint(known)}, presented ${shortFingerprint(hashedKey)}. ` +
        `Refusing to connect (possible man-in-the-middle). If the server's key really changed, remove the "${id}" entry from the "${KNOWN_HOSTS_SETTING}" setting to re-trust it.`,
    );
    return false;
  } catch (error) {
    // Fail closed: a pin store we cannot read is not a reason to trust a key.
    log?.error?.(`SFTP: host key verification failed: ${error.message}`);
    return false;
  }
}

/**
 * Drop the pin for one host so the next connection trusts and pins whatever
 * key it presents. Only ever called from an explicit operator action. A pin
 * store that cannot be parsed protects nothing (every connection is already
 * refused), so it is reset rather than leaving the operator stuck.
 * Returns { forgotten, fingerprint } -- fingerprint of the removed pin, if any.
 */
export async function forgetHostKey(host, port) {
  const id = hostId(host, port);
  let pins;
  try {
    pins = await readPins();
  } catch {
    await setSetting(KNOWN_HOSTS_SETTING, JSON.stringify({}));
    return { forgotten: true, fingerprint: null, storeReset: true };
  }
  const known = pins[id];
  if (!known) return { forgotten: false, fingerprint: null };
  delete pins[id];
  await setSetting(KNOWN_HOSTS_SETTING, JSON.stringify(pins));
  return { forgotten: true, fingerprint: shortFingerprint(known) };
}

// ssh2's own message when hostVerifier refuses a key (lib/protocol/kex.js).
export const HOST_KEY_REFUSED_RE = /host denied \(verification failed\)/i;

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
