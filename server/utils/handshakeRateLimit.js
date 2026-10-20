import net from "net";
import { ipKeyGenerator } from "express-rate-limit";

// SECURITY (2026-10-20): /socket.io/ sits outside the /api/ rate limiter,
// and each Socket.IO handshake runs the connection middleware (a token
// check, database reads) before the client has proven anything. Handshakes
// are now counted per client address (an IPv6 address by its /56, as
// express-rate-limit does), in fixed windows. Only a NEW connection is a
// handshake: polls and the WebSocket upgrade of an open connection carry its
// sid and are not counted, so the limit is far above what reconnects need
// (Socket.IO backs off to one attempt every few seconds per tab).
export const SOCKET_HANDSHAKE_LIMITS = Object.freeze({
  windowMs: 60 * 1000,
  max: 240,
  maxKeys: 10_000,
});

export const SOCKET_HANDSHAKE_RATE_MESSAGE =
  "Too many connection attempts from this address. Wait a minute, then reload the page.";

/** The rate-limit key for a client address (an IPv6 address by its /56). */
export function handshakeClientKey(address) {
  const text = String(address || "");
  return net.isIP(text) ? ipKeyGenerator(text) : text || "unknown";
}

/**
 * A fixed-window counter: allow(key) is true for the first `max` calls per
 * key in each `windowMs`. At most `maxKeys` keys are tracked; past that the
 * expired ones go, then the oldest.
 */
export function createHandshakeRateLimiter(limits = SOCKET_HANDSHAKE_LIMITS) {
  const { windowMs, max, maxKeys } = { ...SOCKET_HANDSHAKE_LIMITS, ...limits };
  const buckets = new Map(); // key -> { count, resetAt }, oldest first

  function makeRoom(now) {
    if (buckets.size < maxKeys) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    while (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
  }

  return {
    allow(key, now = Date.now()) {
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        buckets.delete(key);
        makeRoom(now);
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return bucket.count <= max;
    },
    reset() {
      buckets.clear();
    },
  };
}
