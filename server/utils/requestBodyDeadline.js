// How long a request may take to arrive, headers and body, per request.
//
// Node's own requestTimeout does this with one number for the whole server,
// and a Server Files upload (a 1 GiB world save over a slow line, an SFTP
// upload the remote host takes its time with) needs hours where every
// other request, the unauthenticated ones included, should keep Node's
// 5 minutes: raising it for everyone lets a client trickle a body into
// /api/auth/login for hours. So index.js turns Node's off
// (PANEL_SERVER_TIMEOUTS), and every request gets this deadline instead,
// which a route extends for its own request only once it has checked who
// is asking (routes/files.js for an upload). headersTimeout still bounds
// the header phase, and it has to be named: with requestTimeout 0 Node's
// default for it becomes 0 (off) too.

/** Node's own requestTimeout default. */
export const REQUEST_BODY_DEADLINE_MS = 5 * 60 * 1000;
/**
 * An authorised upload (a Server Files upload, a world backup): 5 minutes
 * cut off anything slower than that, a 1 GiB world save over a 25 Mbit/s
 * line or an SFTP upload the remote host takes its time with.
 */
export const UPLOAD_REQUEST_DEADLINE_MS = 6 * 60 * 60 * 1000;
/** Node's own headersTimeout default. */
export const HEADERS_TIMEOUT_MS = 60 * 1000;

/** Options for http(s).createServer; installRequestBodyDeadline() does the rest. */
export const PANEL_SERVER_TIMEOUTS = Object.freeze({ requestTimeout: 0, headersTimeout: HEADERS_TIMEOUT_MS });

const kDeadline = Symbol("requestBodyDeadline");

function expire(req, res) {
  if (req.complete || !req.socket || req.socket.destroyed) return;
  // What Node's requestTimeout does: 408, then the connection goes.
  if (!res.headersSent) {
    try {
      res.writeHead(408, { Connection: "close" });
      res.end();
    } catch {
      /* the socket is going anyway */
    }
  }
  req.socket.destroy();
}

function schedule(req, state, ms) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    expire(req, state.res);
  }, ms);
  state.timer.unref?.();
}

function clear(state) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

/**
 * Give every request on `server` `deadlineMs` from its first byte to its
 * last (runs before the app, so before any body parser).
 */
export function installRequestBodyDeadline(server, { deadlineMs = REQUEST_BODY_DEADLINE_MS } = {}) {
  server.prependListener("request", (req, res) => {
    const state = { timer: null, res };
    req[kDeadline] = state;
    schedule(req, state, deadlineMs);
    req.once("end", () => clear(state));
    res.once("close", () => {
      if (req.complete) clear(state);
    });
  });
  return server;
}

/**
 * Let this request's body take up to `ms` from now. A no-op for a request
 * that has all arrived, or on a server without the deadline.
 */
export function extendRequestBodyDeadline(req, ms) {
  const state = req?.[kDeadline];
  if (!state || req.complete) return;
  schedule(req, state, ms);
}

/**
 * Route middleware giving this request's body `ms` to arrive. Mount it
 * after the route's permission check, so only an authorised request gets
 * the longer window.
 */
export function allowSlowBody(ms = UPLOAD_REQUEST_DEADLINE_MS) {
  return function slowBodyAllowed(req, _res, next) {
    extendRequestBodyDeadline(req, ms);
    next();
  };
}
