/**
 * Shared cookie policy for the panel's refresh-token cookie.
 *
 * Was duplicated between routes/auth.js and routes/oidc.js — oidc.js kept
 * its own copy deliberately (see the comment it left behind) rather than
 * import from a file that was mid-edit by another agent at the time. Now
 * that both routes are stable, this is the one definition both import —
 * two copies of a security-relevant cookie policy WILL drift, and the
 * drift stays invisible until a cookie stops surviving a redirect.
 */

// Force all refresh cookies to be Secure when the operator has explicitly
// declared this deployment is HTTPS-only (VPS behind TLS termination).
const forceSecureCookies =
  process.env.HTTPS === "true" || process.env.FORCE_HSTS === "true";

export function getRefreshCookieOptions(req, includeMaxAge = true) {
  // Decide `secure` from THIS request's own protocol, not a shared global
  // latch. The latch previously flipped on permanently the first time ANY
  // client was seen over HTTPS, after which every plain-HTTP LAN client
  // silently stopped receiving the refresh cookie (browsers drop `Secure`
  // cookies set over HTTP) — with no error to explain why. In a mixed
  // LAN(HTTP)+remote(HTTPS) deployment each request now gets the right flag
  // for its own connection.
  const requestIsSecure =
    req.secure || req.headers["x-forwarded-proto"] === "https";
  return {
    httpOnly: true,
    secure: forceSecureCookies || requestIsSecure,
    sameSite: "strict",
    path: "/api/auth",
    ...(includeMaxAge ? { maxAge: 30 * 24 * 60 * 60 * 1000 } : {}),
  };
}
