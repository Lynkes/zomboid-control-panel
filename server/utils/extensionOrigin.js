// Browser extension popups (the Steam Sync extension in browser-extension/)
// call the panel from chrome-extension://<id> and the like, with a Bearer
// token rather than the refresh cookie. Checked on the raw string: Node's
// URL.origin is the literal "null" for these schemes.
//
// Used by server/index.js (CORS: the extension is a credentialed origin) and
// routes/auth.js (POST /login: no refresh session or cookie for it, since a
// cookie the extension's sign-in sets lands in the browser's shared jar and
// replaces the panel tab's own).
export function isExtensionOrigin(origin) {
  if (typeof origin !== "string") return false;
  const lower = origin.toLowerCase();
  return (
    lower.startsWith("chrome-extension://") ||
    lower.startsWith("moz-extension://") ||
    lower.startsWith("safari-web-extension://")
  );
}
