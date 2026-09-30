import express from "express";
import { requirePermission } from "../services/permissions.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { createLogger } from "../utils/logger.js";
import { BACKENDS, FmError, ROOT_IDS } from "../services/fileManagerContract.js";
import { DENIAL_CODES, actorFromRequest, writeAudit, writeDenied } from "../services/fileManagerAudit.js";
import { getJob } from "../services/fileManagerJobs.js";
import * as files from "../services/fileManagerService.js";

const log = createLogger("API:ServerFiles");

// How long an upload request may take from its first byte to its last:
// server/index.js puts this on the HTTP and HTTPS servers in place of Node's
// 5-minute requestTimeout default, which cut off any upload slower than
// that (a 1 GiB world save over a 25 Mbit/s line, any SFTP upload the remote
// host takes its time with). Uploads still stop after UPLOAD_IDLE_MS with no
// data, and headersTimeout still bounds the header phase.
export const FILE_UPLOAD_REQUEST_TIMEOUT_MS = 6 * 60 * 60 * 1000;

// A refused upload (too many transfers, not enough space, the name is
// taken...) answers before reading the body. Closing the socket with that
// body still arriving makes the OS answer with a reset, and the client's
// network stack then throws away the refusal it had already received: the
// browser sees a network error, never the code (and a 429 never pauses the
// queue). So the rest of the body is read and dropped for a moment after
// the answer, and the connection is cut only if it is still coming.
const REFUSED_UPLOAD_LINGER_MS = 2000;
const REFUSED_UPLOAD_LINGER_BYTES = 8 * 1024 * 1024;

function lingerThenCut(req) {
  const socket = req.socket;
  if (!socket || socket.destroyed) return;
  const started = Date.now();
  const bytesAtStart = socket.bytesRead;
  req.resume();
  const timer = setInterval(() => {
    if (req.complete || socket.destroyed) {
      clearInterval(timer);
      return;
    }
    if (Date.now() - started > REFUSED_UPLOAD_LINGER_MS || socket.bytesRead - bytesAtStart > REFUSED_UPLOAD_LINGER_BYTES) {
      clearInterval(timer);
      socket.destroy();
    }
  }, 50);
  timer.unref?.();
}

function isUploadRequest(req) {
  return req.method === "POST" && /\/upload$/.test(req.path);
}

// Server Files API (/api/files), spec §A10. The whole router needs
// files.manage: it can change anything the game server runs, so it is gated
// like the admin password (routeAuthorizationCoverage.test.js asserts the
// exact line below). The rest of the order is part of the contract too:
//   1. files.manage
//   2. refused while panel logins are off: every request is then an admin
//      with no identity, so the file manager would be an unauthenticated
//      way to run code, and audit rows would have no actor
//   3. refused when a token rides in the URL (tokens never belong in file
//      URLs, where logs and history keep them)
//   4. query strings must be plain strings; JSON bodies must be JSON
//   5. /profiles/:profileId/* reads the profile once into req.fm
// err.message never leaves the server: every response carries a code, the
// en text for it, and params that never hold an absolute path.
const router = express.Router();
router.use(requirePermission("files.manage"));

// The en text for each code (client/src/locales/en/errors.json has the same
// strings; the client shows its own translation by code).
const FM_MESSAGES = {
  [ErrorCode.FM_AUTH_DISABLED]:
    "The file manager only works while panel logins are on. Turn them on in Panel Settings, then sign in.",
  [ErrorCode.FM_TOKEN_IN_URL]:
    "This request carried a sign-in token in its address, which the file manager refuses. Reload the page and try again.",
  [ErrorCode.FM_INVALID_REQUEST]: "Part of this request was missing or invalid. Reload the page and try again.",
  [ErrorCode.FM_INVALID_PATH]: "That path can't be used here.",
  [ErrorCode.FM_INVALID_NAME]: "That name can't be used here.",
  [ErrorCode.FM_UNSUPPORTED_MEDIA_TYPE]:
    "The panel didn't recognise how this request was sent. Reload the page and try again.",
  [ErrorCode.FM_LENGTH_REQUIRED]: "The upload didn't say how large it is. Try again from the Server Files page.",
  [ErrorCode.FM_PROFILE_NOT_FOUND]: "That server no longer exists. Pick another server.",
  [ErrorCode.FM_ROOT_UNKNOWN]: "That folder isn't available for this server.",
  [ErrorCode.FM_ROOT_UNAVAILABLE]: "This folder can't be opened right now.",
  [ErrorCode.FM_ROOT_READ_ONLY]:
    "The panel can't write to this folder. It may be mounted read-only or owned by another account.",
  [ErrorCode.FM_ROOT_IMMUTABLE]: "The top folder itself can't be renamed, moved or deleted.",
  [ErrorCode.FM_NOT_FOUND]: "That file or folder is gone. Refresh the list.",
  [ErrorCode.FM_NOT_A_DIRECTORY]: "That's a file, not a folder.",
  [ErrorCode.FM_NOT_A_FILE]: "That's a folder or a special file, not a regular file.",
  [ErrorCode.FM_PATH_PROTECTED]: "This belongs to the panel or PanelBridge and can't be changed here.",
  [ErrorCode.FM_LINK_ESCAPES_ROOT]:
    "This is a link to somewhere outside this folder, so it can't be opened here.",
  [ErrorCode.FM_OS_PERMISSION_DENIED]:
    "The panel's account isn't allowed to do this on disk. Check the folder's permissions.",
  [ErrorCode.FM_EXISTS]: "Something with that name is already there. Pick another name.",
  [ErrorCode.FM_CONFLICT]: "This file changed since you opened it. Reload it, then make your change again.",
  [ErrorCode.FM_CONFIRMATION_REQUIRED]: "Confirm this change first.",
  [ErrorCode.FM_PREVIEW_EXPIRED]: "The delete check expired. Select the items and try again.",
  [ErrorCode.FM_PREVIEW_STALE]: "These items changed after the delete check. Select them again.",
  [ErrorCode.FM_SERVER_RUNNING_BLOCKED]: "Stop the server before changing its world save files.",
  [ErrorCode.FM_OPERATION_IN_PROGRESS]:
    "Something else is working on these files right now. Try again when it finishes.",
  [ErrorCode.FM_FILE_IN_USE]:
    "Another program has this file open, usually the running server. Stop the server or close that program, then try again.",
  [ErrorCode.FM_TARGET_READ_ONLY]: "This file is marked read-only on disk.",
  [ErrorCode.FM_CROSS_DEVICE]:
    "These folders are on different drives. Download the files and upload them instead.",
  [ErrorCode.FM_MOVE_INTO_SELF]: "A folder can't be moved inside itself.",
  [ErrorCode.FM_TYPED_CONFIRMATION_MISMATCH]: "The confirmation text didn't match. Nothing was deleted.",
  [ErrorCode.FM_BINARY_FILE]: "This file isn't text, so it can't be opened in the editor. Download it instead.",
  [ErrorCode.FM_ENCODING_UNSUPPORTED]:
    "This file isn't UTF-8 text, so editing it here could damage it. Download it instead.",
  [ErrorCode.FM_FILE_TOO_LARGE_FOR_EDITOR]:
    "This file is too large to edit here. You can view its end or download it.",
  [ErrorCode.FM_UPLOAD_TOO_LARGE]: "This file is larger than the upload limit.",
  [ErrorCode.FM_DOWNLOAD_TOO_LARGE]: "This file is larger than the download limit.",
  [ErrorCode.FM_ZIP_TOO_LARGE]:
    "This selection is too large to zip. Pick fewer items, or use World Backups for a whole world.",
  [ErrorCode.FM_UPLOAD_SIZE_MISMATCH]: "The upload stopped before it finished. Nothing was saved. Try again.",
  [ErrorCode.FM_INSUFFICIENT_SPACE]:
    "Not enough free disk space. The panel keeps a safety margin so the server can still save.",
  [ErrorCode.FM_TRASH_UNAVAILABLE]: "These items can't be moved to Trash. You can delete them permanently instead.",
  [ErrorCode.FM_TRASH_ITEM_NOT_FOUND]: "That Trash item is gone.",
  [ErrorCode.FM_JOB_NOT_FOUND]: "That task finished or expired. Refresh the page.",
  [ErrorCode.FM_RATE_LIMITED]: "Too many file actions in a short time. Wait a moment and try again.",
  [ErrorCode.FM_TOO_MANY_TRANSFERS]: "Too many uploads or downloads are running. Wait for one to finish.",
  [ErrorCode.FM_SFTP_ERROR]: "The remote server refused this over SFTP.",
  [ErrorCode.FM_SFTP_TIMEOUT]: "The remote server stopped answering over SFTP. Try again.",
  [ErrorCode.FM_INTERNAL]: "The file manager hit an unexpected error. Check the panel's log.",
  [ErrorCode.FM_TOO_MANY_ENTRIES]:
    "There are too many items to delete in one go. What was already deleted stays deleted; run it again to finish.",
  [ErrorCode.FM_SECRET_NAME_REQUIRED]:
    "This file holds passwords the file manager keeps masked. Keep .ini in the new name so they stay masked.",
  [ErrorCode.RAW_INI_SECRET_LINE_REMOVED]:
    "A line holding a live secret was removed. To clear it, keep the line and empty its value instead.",
  [ErrorCode.RAW_INI_SECRET_UNRESOLVABLE]:
    "A masked password line couldn't be matched to exactly one live value. Nothing was saved.",
};

// Params travel to the client for interpolation: primitives and short
// arrays of primitives only.
function cleanParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) out[key] = value;
    else if (typeof value === "bigint") out[key] = String(value);
    else if (Array.isArray(value)) out[key] = value.filter((v) => ["string", "number", "boolean"].includes(typeof v)).slice(0, 50);
  }
  return out;
}

function sendError(res, err) {
  if (res.headersSent) {
    res.destroy?.();
    return;
  }
  if (err instanceof FmError) {
    const body = { error: FM_MESSAGES[err.code] || FM_MESSAGES[ErrorCode.FM_INTERNAL], code: err.code };
    const params = cleanParams(err.params);
    if (Object.keys(params).length) body.params = params;
    if (err.details && typeof err.details === "object") body.details = err.details;
    res.status(err.status || 500).json(body);
    return;
  }
  log.error(`Server Files request failed: ${err?.code || err?.name || "error"}: ${err?.message || ""}`);
  res.status(500).json({ error: FM_MESSAGES[ErrorCode.FM_INTERNAL], code: ErrorCode.FM_INTERNAL });
}

function auditBase(req, scope) {
  const profile = req.fm?.profile;
  return {
    actor: actorFromRequest(req),
    profileId: profile ? String(profile.id) : null,
    profileName: profile ? profile.name || profile.serverName || null : null,
    backend: BACKENDS.includes(scope.backend) ? scope.backend : null,
    rootId: ROOT_IDS.includes(scope.rootId) ? scope.rootId : null,
    paths: scope.paths,
    dest: scope.dest,
    bytes: scope.bytes,
    sha256Before: scope.sha256Before,
    sha256After: scope.sha256After,
    trashIds: scope.trashIds,
    confirm: scope.confirm,
    durationMs: Date.now() - scope.started,
  };
}

async function finishAudit(req, scope, err) {
  const errCode = err ? (err instanceof FmError ? err.code : ErrorCode.FM_INTERNAL) : scope.code;
  if (err && DENIAL_CODES.has(errCode)) {
    await writeDenied({ ...auditBase(req, scope), attemptedOp: scope.op, code: errCode });
    return;
  }
  let result = scope.result || "ok";
  if (err) result = errCode === ErrorCode.FM_CONFIRMATION_REQUIRED ? "confirmationRequired" : "failed";
  await writeAudit({ ...auditBase(req, scope), op: scope.op, result, code: errCode ?? null });
}

// One audit row per mutation or download, written from `finally`. A job
// (permanent delete, purge) defers its row until it finishes.
function startAudit(req, op) {
  const scope = {
    op,
    rootId: null,
    backend: null,
    paths: [],
    dest: null,
    bytes: null,
    sha256Before: null,
    sha256After: null,
    trashIds: [],
    confirm: [],
    result: null,
    code: null,
    started: Date.now(),
    deferred: false,
    defer() {
      scope.deferred = true;
      return { finish: (err) => finishAudit(req, scope, err) };
    },
  };
  return scope;
}

// What a request not otherwise audited reached for: the query of a GET, the
// JSON body of a POST (a delete preview, an upload preflight).
function requestedTarget(req) {
  const source = req.method === "GET" ? req.query || {} : req.body && typeof req.body === "object" ? req.body : {};
  let paths = [""];
  if (Array.isArray(source.paths)) paths = source.paths.filter((p) => typeof p === "string");
  else if (typeof source.path === "string") paths = [source.path];
  else if (typeof source.dir === "string") paths = [source.dir];
  return { rootId: source.root, paths: paths.length ? paths : [""] };
}

// Denials on routes that aren't otherwise audited (listing, viewing, the
// delete preview and the upload preflight).
async function auditDenialIfAny(req, err, op) {
  if (!(err instanceof FmError) || !DENIAL_CODES.has(err.code)) return;
  const target = requestedTarget(req);
  await writeDenied({
    ...auditBase(req, {
      backend: null,
      rootId: target.rootId,
      paths: Array.isArray(err.auditPaths) ? err.auditPaths : target.paths,
      dest: null,
      bytes: null,
      sha256Before: null,
      sha256After: null,
      trashIds: [],
      confirm: [],
      started: Date.now(),
    }),
    attemptedOp: op,
    code: err.code,
  });
}

function handle(op, fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      await auditDenialIfAny(req, err, op);
      sendError(res, err);
    }
  };
}

function audited(op, fn, { onError } = {}) {
  return async (req, res) => {
    const scope = startAudit(req, op);
    let failure = null;
    try {
      await fn(req, res, scope);
    } catch (err) {
      failure = err;
      onError?.(req, res);
      sendError(res, err);
    } finally {
      if (!scope.deferred || failure) {
        try {
          await finishAudit(req, scope, failure);
        } catch {
          /* writeAudit never throws; belt and braces */
        }
      }
    }
  };
}

// ============================================
// Router-wide checks (after files.manage)
// ============================================

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (req.user?.authDisabled) return sendError(res, new FmError(ErrorCode.FM_AUTH_DISABLED));
  if (req.query?.token !== undefined) return sendError(res, new FmError(ErrorCode.FM_TOKEN_IN_URL));
  for (const [key, value] of Object.entries(req.query || {})) {
    if (typeof value !== "string") {
      return sendError(res, new FmError(ErrorCode.FM_INVALID_REQUEST, undefined, { field: key.slice(0, 40) }));
    }
  }
  if (req.method === "POST" || req.method === "PUT") {
    const isUpload = req.method === "POST" && /^\/profiles\/[^/]+\/upload$/.test(req.path);
    if (!isUpload) {
      if (!req.is("application/json")) return sendError(res, new FmError(ErrorCode.FM_UNSUPPORTED_MEDIA_TYPE));
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        return sendError(res, new FmError(ErrorCode.FM_INVALID_REQUEST, undefined, { field: "body" }));
      }
    }
  }
  return next();
});

router.use("/profiles/:profileId", async (req, res, next) => {
  try {
    req.fm = await files.loadProfileContext(req.params.profileId, req.app);
    return next();
  } catch (err) {
    if (isUploadRequest(req) && !req.complete) res.once("finish", () => lingerThenCut(req));
    return sendError(res, err);
  }
});

// ============================================
// Profiles
// ============================================

router.get(
  "/profiles",
  handle("files.profiles", async (req, res) => {
    res.json(await files.listProfiles());
  }),
);

router.get(
  "/profiles/:profileId",
  handle("files.profile", async (req, res) => {
    res.json(await files.getProfile(req.fm, { fresh: req.query.fresh === "1" }));
  }),
);

// ============================================
// Reading
// ============================================

router.get(
  "/profiles/:profileId/list",
  handle("files.list", async (req, res) => {
    res.json(await files.listDir(req.fm, req.query));
  }),
);

router.get(
  "/profiles/:profileId/stat",
  handle("files.stat", async (req, res) => {
    res.json(await files.statPath(req.fm, req.query));
  }),
);

router.get(
  "/profiles/:profileId/search",
  handle("files.search", async (req, res) => {
    res.json(await files.search(req.fm, req.query));
  }),
);

router.get(
  "/profiles/:profileId/text",
  handle("files.text", async (req, res) => {
    res.json(await files.readText(req.fm, req.query));
  }),
);

// ============================================
// Writing
// ============================================

router.put(
  "/profiles/:profileId/text",
  audited("files.write", async (req, res, audit) => {
    const { status, body } = await files.saveText(req.fm, req.body, req.user, audit);
    res.status(status).json(body);
  }),
);

router.post(
  "/profiles/:profileId/mkdir",
  audited("files.mkdir", async (req, res, audit) => {
    res.status(201).json(await files.makeDirectory(req.fm, req.body, req.user, audit));
  }),
);

router.post(
  "/profiles/:profileId/rename",
  audited("files.rename", async (req, res, audit) => {
    res.json(await files.renameEntry(req.fm, req.body, req.user, audit));
  }),
);

router.post(
  "/profiles/:profileId/move",
  audited("files.move", async (req, res, audit) => {
    res.json(await files.moveEntries(req.fm, req.body, req.user, audit));
  }),
);

router.post(
  "/profiles/:profileId/copy",
  audited("files.copy", async (req, res, audit) => {
    res.status(201).json(await files.copyEntry(req.fm, req.body, req.user, audit));
  }),
);

// ============================================
// Delete and Trash
// ============================================

router.post(
  "/profiles/:profileId/delete/preview",
  handle("files.delete.preview", async (req, res) => {
    res.json(await files.deletePreview(req.fm, req.body, req.user));
  }),
);

router.post(
  "/profiles/:profileId/delete",
  audited("files.delete.trash", async (req, res, audit) => {
    const { status, body } = await files.deleteItems(req.fm, req.body, req.user, audit);
    res.status(status).json(body);
  }),
);

router.get(
  "/profiles/:profileId/trash",
  handle("files.trash.list", async (req, res) => {
    res.json(await files.listTrashItems(req.fm, req.query));
  }),
);

// An earlier version as text, for the editor's "Previous versions". A read,
// so not audited.
router.get(
  "/profiles/:profileId/trash/text",
  handle("files.trash.text", async (req, res) => {
    res.json(await files.readTrashText(req.fm, req.query));
  }),
);

router.post(
  "/profiles/:profileId/trash/restore",
  audited("files.trash.restore", async (req, res, audit) => {
    res.json(await files.restoreTrashItem(req.fm, req.body, req.user, audit));
  }),
);

router.post(
  "/profiles/:profileId/trash/purge",
  audited("files.trash.purge", async (req, res, audit) => {
    res.status(202).json(await files.purgeTrash(req.fm, req.body, req.user, audit));
  }),
);

// ============================================
// Upload, download, zip
// ============================================

router.post(
  "/profiles/:profileId/upload/preflight",
  handle("files.upload.preflight", async (req, res) => {
    // A client that gave up waiting (a big batch over a slow SFTP link)
    // stops the checks instead of leaving them running for nobody.
    const gone = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) gone.abort();
    });
    res.json(await files.uploadPreflight(req.fm, req.body, req.user, { signal: gone.signal }));
  }),
);

// Raw body. Every check runs before a byte is read; on a refusal the rest
// of the body is dropped for a moment (so the client gets to see the
// answer), then the connection is cut if it is still coming.
router.post(
  "/profiles/:profileId/upload",
  audited(
    "files.upload",
    async (req, res, audit) => {
      res.status(201).json(await files.receiveUpload(req.fm, req, req.user, audit));
    },
    {
      onError: (req, res) => {
        if (req.complete) return;
        res.once("finish", () => lingerThenCut(req));
      },
    },
  ),
);

function asciiFileName(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, "_").replace(/["\\\r\n]/g, "_");
  return ascii || "download";
}

function contentDisposition(name) {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFileName(name)}"; filename*=UTF-8''${encoded}`;
}

const DOWNLOAD_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
};

router.get(
  "/profiles/:profileId/download",
  audited("files.download", async (req, res, audit) => {
    const dl = await files.openDownload(req.fm, req.query, req.user, audit);
    res.status(200).set({
      ...DOWNLOAD_HEADERS,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(dl.size),
      "Content-Disposition": contentDisposition(dl.name),
      ...(dl.etag ? { "X-File-Etag": dl.etag } : {}),
      ...(dl.masked ? { "X-File-Masked": "1" } : {}),
    });
    if (dl.buffer) {
      dl.release();
      res.end(dl.buffer);
      return;
    }
    await new Promise((resolve) => {
      let settled = false;
      let idle = null;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        dl.release();
        if (!ok) audit.result = "aborted";
        resolve();
      };
      // A client that stops reading would keep its transfer slot (shared
      // with uploads, 2 per user and 4 across the panel) until its socket
      // goes away: cut it off after the idle time an upload gets. Any chunk
      // read from the file means the client took the one before it.
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          dl.stream.destroy();
          res.destroy();
          done(false);
        }, dl.idleMs);
        idle.unref?.();
      };
      dl.stream.on("error", () => {
        res.destroy();
        done(false);
      });
      res.on("finish", () => done(true));
      res.on("close", () => {
        if (!res.writableFinished) {
          dl.stream.destroy();
          done(false);
        }
      });
      dl.stream.pipe(res);
      dl.stream.on("data", arm);
      arm();
    });
  }),
);

router.post(
  "/profiles/:profileId/zip",
  audited("files.zip", async (req, res, audit) => {
    const zip = await files.prepareZip(req.fm, req.body, req.user, audit);
    try {
      res.status(200).set({
        ...DOWNLOAD_HEADERS,
        "Content-Type": "application/zip",
        "Content-Disposition": contentDisposition(zip.fileName),
      });
      const result = await zip.stream(res);
      audit.bytes = result.bytes;
      if (result.aborted) audit.result = "aborted";
    } finally {
      zip.release();
    }
  }),
);

// ============================================
// Remote folders (needs bridge.setup as well)
// ============================================

router.put(
  "/profiles/:profileId/remote-roots",
  requirePermission("bridge.setup"),
  audited("files.remoteRoots.set", async (req, res, audit) => {
    res.json(await files.setRemoteRoots(req.fm, req.body, req.user, audit));
  }),
);

// ============================================
// Jobs and audit
// ============================================

router.get(
  "/jobs/:jobId",
  handle("files.job", async (req, res) => {
    res.json(getJob(req.params.jobId, req.user?.userId ?? null));
  }),
);

router.get(
  "/audit",
  handle("files.audit", async (req, res) => {
    res.json(await files.listAudit(req.query));
  }),
);

export default router;
