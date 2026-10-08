const DISABLED_VALUES = new Set(["", "0", "false", "off", "none"]);

export function parseTrustProxySetting(value) {
  const rawValue = String(value ?? "").trim();
  const normalizedValue = rawValue.toLowerCase();

  if (DISABLED_VALUES.has(normalizedValue)) return false;
  if (normalizedValue === "true") return 1;

  if (/^[+-]?\d+$/.test(rawValue)) {
    const hops = Number(rawValue);
    return Number.isSafeInteger(hops) && hops > 0 ? hops : false;
  }

  const proxyRanges = rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return proxyRanges.length === 1 ? proxyRanges[0] : proxyRanges;
}

// SECURITY (2026-10-08, auth audit #7): a hop count trusts X-Forwarded-For
// from whatever connects directly. Anyone who reaches the port without
// going through the proxy names their own address, and with it gets a fresh
// sign-in lockout budget and rate-limit bucket on every attempt. Docker
// publishes the port on every address and bypasses UFW, so the port being
// reachable only through the proxy is not something to assume.
export function trustProxyHopCountWarning(value) {
  const setting = parseTrustProxySetting(value);
  if (typeof setting !== "number") return null;
  const shown = String(value ?? "").trim();
  return (
    `TRUST_PROXY=${shown} trusts X-Forwarded-For from anyone who reaches the panel's port directly. ` +
    "Make sure only the proxy can reach it (in Docker, set PANEL_BIND_ADDRESS=127.0.0.1), " +
    "or name the proxy's address instead, for example TRUST_PROXY=loopback for a proxy on this machine outside Docker."
  );
}
