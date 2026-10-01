// Contract for the Server Files file manager (v1.4.1): the shared types, the
// error class every backend throws, the enumerations, the limits, and the
// name/path rules. server/routes/files.js, the fileManager*.js services and
// both backends (local and SFTP) build on it.
//
// Mirrored by client/src/types/files.ts (same names, values and order for
// every exported array and for FM_LIMITS; fileManagerContractParity.test.js
// fails when they drift). validateSegments()/validateName() are mirrored
// exactly by client/src/components/files/nameRules.ts, and both are tested
// against server/tests/fixtures/fileManagerNameCases.json.
//
// Append-only after the v1.4.1 contract commit: a change here goes through
// the integrator, together with its client mirror.
import { ErrorCode } from "../utils/errorCodes.js";

// ============================================
// Shared types (JSDoc mirror of client/src/types/files.ts)
// ============================================

/** @typedef {"install"|"launch"|"data"|"config"} RootId */
/** @typedef {"local"|"docker"|"sftp"} Backend */
/** @typedef {"running"|"stopped"|"unknown"} ServerState */
/** @typedef {"sealed"|"listOnly"|"readOnly"} ProtectionLevel */
/** @typedef {"panelData"|"panelLogs"|"panelProgram"|"panelSecret"|"credentials"|"panelBackups"|"bridgeIo"|"bridgeManaged"|"launchScripts"} ProtectedArea */
/** @typedef {"serverRunning"|"overwrite"|"executable"|"permanent"} ConfirmToken */
/** @typedef {"restartToApply"|"panelRewritesKeys"|"luaChecksum"|"steamUpdateOverwrites"|"bridgeWorkshopEntries"|"secretsMasked"} Hint */
/** @typedef {"missing"|"notConfigured"|"notMounted"|"remoteNotActive"|"remoteNotConfigured"|"remoteInstallNotSet"|"tooBroad"|"overlapsPanel"|"unreadable"|"sftpUnreachable"} RootUnavailableReason */
/** @typedef {"noInstallMarker"|"containerOnly"|"remoteFilesystemRoot"} RootWarning */
/** @typedef {"serverSettings"|"worldSave"|"playerDb"|"logs"|"localMods"|"java"|"gameLua"|"workshop"} BookmarkKind */
/** @typedef {"deleted"|"edited"|"replaced"} TrashReason */
/** @typedef {"list"|"read"|"write"|"create"|"delete"|"rename"|"move"} ResolveIntent */
/** @typedef {"empty"|"tooLong"|"dotSegment"|"control"|"backslash"|"colon"|"windowsReserved"|"reservedDeviceName"|"trailingDotOrSpace"|"bidiControl"|"leadingSpace"|"reservedPanelName"|"slash"} NameRuleReason */

/**
 * One listed entry, as the client receives it.
 * @typedef {Object} FileEntry
 * @property {string} name
 * @property {string} path  root-relative POSIX path, as navigated
 * @property {"file"|"dir"|"link"|"other"} type
 * @property {{ inside: boolean, targetType: "file"|"dir"|"missing"|"unknown" }} [link]  never the target path
 * @property {number|null} size
 * @property {string|null} modifiedAt  ISO timestamp
 * @property {string|null} mode  "0644"; null on win32 or when unknown
 * @property {string|null} etag  opaque: "s:<size>-<mtimeMs>[-<ino>]" or "h:<sha256>"
 * @property {{ level: ProtectionLevel, area: ProtectedArea }|null} protection
 * @property {{ editable: boolean, binaryHint: boolean, secretBearing: boolean, executable: boolean, worldState: boolean, unsupportedName: boolean }} flags
 */

/**
 * @typedef {Object} RootDescriptor
 * @property {RootId} id
 * @property {Backend} backend
 * @property {string|null} displayPath  display only, never sent back
 * @property {boolean} available
 * @property {RootUnavailableReason} [unavailableReason]
 * @property {string} [unavailableDetail]
 * @property {boolean|null} writable
 * @property {"mount"|"permissions"} [readOnlyReason]
 * @property {number|null} freeBytes
 * @property {number|null} totalBytes
 * @property {RootWarning[]} warnings
 * @property {number|null} trashItemCount
 */

/**
 * @typedef {Object} ProfileFiles
 * @property {string} id
 * @property {string} name
 * @property {string} serverName
 * @property {boolean} isActive
 * @property {string} provider
 * @property {{ host: string, port: number, username: string }|null} remote  never the password
 * @property {RootDescriptor[]} roots
 * @property {Array<{ rootId: RootId, path: string, kind: BookmarkKind }>} bookmarks
 * @property {{ installPath: string|null, dataPath: string|null, derivedDataPath: string|null }} [remoteRoots]  sftp only
 * @property {ServerState} [serverState]
 * @property {string} [serverStateCheckedAt]
 */

/**
 * @typedef {Object} TrashItem
 * @property {string} trashId  matches TRASH_ID_RE
 * @property {string} originalPath
 * @property {"file"|"dir"} type
 * @property {number} bytes
 * @property {number} files
 * @property {string} deletedAt
 * @property {{ username: string|null }} deletedBy
 * @property {TrashReason} reason
 * @property {string} expiresAt
 */

/**
 * The meta.json stored beside each Trash payload. Untrusted on read: a
 * restore target always goes back through resolution.
 * @typedef {Object} TrashMeta
 * @property {1} v
 * @property {string} originalPath
 * @property {"file"|"dir"} type
 * @property {number} bytes
 * @property {number} files
 * @property {string} deletedAt
 * @property {{ userId: string|null, username: string|null }} deletedBy
 * @property {TrashReason} reason
 */

/**
 * What the service hands a backend when a write moves something to Trash;
 * the backend fills in the rest of TrashMeta.
 * @typedef {{ deletedBy: { userId: string|null, username: string|null }, reason: TrashReason }} TrashMetaInput
 */

// ============================================
// Backend interface (both backends implement it; WS-A's conformance suite
// checks both)
// ============================================

/**
 * A root as the service asks a backend to open it.
 * @typedef {Object} RootSpec
 * @property {RootId} id
 * @property {string} path  absolute, server-derived from the profile (never client input)
 * @property {RootWarning[]} [warnings]  e.g. remoteFilesystemRoot for an explicit remote "/"
 */

/**
 * A resolved target. `abs` is only ever built by the backend's resolve().
 * @typedef {Object} Resolved
 * @property {RootId} rootId
 * @property {string} rel  root-relative POSIX path as requested
 * @property {string} realRel  root-relative POSIX path after links (protection is classified on this)
 * @property {string} abs  backend path (local: realpath-based absolute path; sftp: remote absolute path)
 * @property {boolean} isNew  true only for a missing last segment under intent "create"
 * @property {{ type: "file"|"dir"|"link"|"other", size: number, mtimeMs: number, mode: number|null, dev: bigint|null, ino: bigint|null }|null} stat
 * @property {{ level: ProtectionLevel, area: ProtectedArea, containsProtected?: boolean }|null} protection
 * @property {boolean} worldState
 */

/**
 * An entry as a backend reports it, before the service adds protection and
 * flags to make a FileEntry.
 * @typedef {Object} RawEntry
 * @property {string} name
 * @property {string} rel  root-relative POSIX path as navigated
 * @property {string|null} realRel  root-relative POSIX path after links; null when it escapes or is unknown
 * @property {"file"|"dir"|"link"|"other"} type
 * @property {{ inside: boolean, targetType: "file"|"dir"|"missing"|"unknown" }} [link]
 * @property {number|null} size
 * @property {number|null} mtimeMs
 * @property {number|null} mode  permission bits; null on win32 or when unknown
 * @property {bigint|null} dev
 * @property {bigint|null} ino
 * @property {string|null} etag
 */

/**
 * @typedef {Object} FileBackend
 * @property {"local"|"sftp"} kind
 * @property {(spec: RootSpec) => Promise<RootDescriptor & { real: string }>} describeRoot
 * @property {(root: RootDescriptor & { real: string }, segments: string[], intent: ResolveIntent) => Promise<Resolved>} resolve
 * @property {(dir: Resolved, opts: { offset: number, limit: number, sort: "name"|"size"|"modified", order: "asc"|"desc" }) => Promise<{ entries: RawEntry[], total: number, sortLimited: boolean, truncated: boolean, dirEtag: string }>} list
 * @property {(r: Resolved) => Promise<RawEntry>} stat
 * @property {(r: Resolved, opts: { maxBytes: number, tail?: boolean }) => Promise<{ buffer: Buffer, size: number, truncated: boolean }>} readBytes
 * @property {(r: Resolved) => Promise<{ stream: import("stream").Readable, size: number, close(): Promise<void> }>} openReadStream
 * @property {(r: Resolved, bytes: Buffer, opts: { expectedHash: string|null, trashMeta: TrashMetaInput }) => Promise<{ entry: RawEntry, previousTrashId: string|null }>} writeBytesCas
 * @property {(dir: Resolved, name: string, source: import("stream").Readable, opts: { declaredSize: number, maxBytes: number, overwriteEtag: string|null, trashMeta: TrashMetaInput }) => Promise<{ entry: RawEntry, sha256: string, replacedTrashId: string|null }>} receiveUpload
 * @property {(parent: Resolved, name: string) => Promise<RawEntry>} mkdir
 * @property {(r: Resolved, newName: string) => Promise<RawEntry>} rename
 * @property {(r: Resolved, destDir: Resolved) => Promise<RawEntry>} move
 * @property {(r: Resolved, destDir: Resolved, newName: string) => Promise<RawEntry>} copyFile
 * @property {(r: Resolved, opts: { maxEntries: number, maxDepth: number, maxMs: number, signal?: AbortSignal }) => AsyncIterable<{ rel: string, type: "file"|"dir"|"link"|"other", size: number }>} walk
 * @property {(r: Resolved, meta: TrashMetaInput) => Promise<{ trashId: string }>} trashMove
 * @property {(root: RootDescriptor & { real: string }) => Promise<TrashItem[]>} trashList
 * @property {(root: RootDescriptor & { real: string }, trashId: string, restoreAs?: string) => Promise<RawEntry>} trashRestore
 * @property {(target: Resolved | { root: RootDescriptor & { real: string }, trashId: string }, onProgress: (done: number, total: number|null) => void) => Promise<void>} deletePermanent
 * @property {(root: RootDescriptor & { real: string }) => Promise<{ free: number|null, total: number|null }>} freeSpace
 * @property {(root: RootDescriptor & { real: string }, trashId: string, opts: { maxBytes: number }) => Promise<{ buffer: Buffer, size: number, truncated: boolean }>} trashReadBytes
 *   The first maxBytes of a Trash item that is a file (GET /trash/text).
 *
 * As both backends implement it (the conformance suite pins these):
 * - every Resolved also carries `name` (the last segment as navigated, "" for
 *   the root) and `linkSelf` (the last segment is a link acted on as itself);
 * - walk() yields only what is below `r`, never `r` itself (nothing for a
 *   file), each item { name, rel, realRel, type, size, mtimeMs, dev, ino,
 *   depth } with depth 1 for r's children, and honours opts.prune(entry);
 * - copyFile() takes a 4th { overwriteEtag, trashMeta }: an existing target
 *   is replaced only when overwriteEtag names its current version.
 */

// ============================================
// Enumerations (mirrored in client/src/types/files.ts)
// ============================================

export const ROOT_IDS = Object.freeze(["install", "launch", "data", "config"]);
export const BACKENDS = Object.freeze(["local", "docker", "sftp"]);
export const SERVER_STATES = Object.freeze(["running", "stopped", "unknown"]);
export const PROTECTION_LEVELS = Object.freeze(["sealed", "listOnly", "readOnly"]);
export const PROTECTED_AREAS = Object.freeze([
  "panelData", "panelLogs", "panelProgram", "panelSecret", "credentials",
  "panelBackups", "bridgeIo", "bridgeManaged", "launchScripts",
]);
export const CONFIRM_TOKENS = Object.freeze(["serverRunning", "overwrite", "executable", "permanent"]);
export const HINTS = Object.freeze([
  "restartToApply", "panelRewritesKeys", "luaChecksum", "steamUpdateOverwrites", "bridgeWorkshopEntries", "secretsMasked",
]);
export const ROOT_UNAVAILABLE_REASONS = Object.freeze([
  "missing", "notConfigured", "notMounted", "remoteNotActive", "remoteNotConfigured", "remoteInstallNotSet",
  "tooBroad", "overlapsPanel", "unreadable", "sftpUnreachable",
]);
export const ROOT_WARNINGS = Object.freeze(["noInstallMarker", "containerOnly", "remoteFilesystemRoot"]);
export const BOOKMARK_KINDS = Object.freeze([
  "serverSettings", "worldSave", "playerDb", "logs", "localMods", "java", "gameLua", "workshop",
]);
export const TRASH_REASONS = Object.freeze(["deleted", "edited", "replaced"]);
export const NAME_RULE_REASONS = Object.freeze([
  "empty", "tooLong", "dotSegment", "control", "backslash", "colon", "windowsReserved", "reservedDeviceName",
  "trailingDotOrSpace", "bidiControl", "leadingSpace", "reservedPanelName", "slash",
]);
export const AUDIT_OPS = Object.freeze([
  "files.create", "files.write", "files.mkdir", "files.rename", "files.move", "files.copy", "files.upload",
  "files.delete.trash", "files.delete.permanent", "files.trash.restore", "files.trash.purge", "files.trash.expire",
  "files.download", "files.zip", "files.remoteRoots.set", "files.denied",
]);

// Server-only: the resolve() intents and each protected area's level
// (spec §A4.3, §A5.2).
export const RESOLVE_INTENTS = Object.freeze(["list", "read", "write", "create", "delete", "rename", "move"]);
export const PROTECTED_AREA_LEVEL = Object.freeze({
  panelData: "sealed",
  panelLogs: "sealed",
  panelProgram: "sealed",
  panelSecret: "sealed",
  credentials: "sealed",
  panelBackups: "listOnly",
  bridgeIo: "readOnly",
  bridgeManaged: "readOnly",
  launchScripts: "listOnly",
});

// Panel-owned names inside a root: the per-root Trash folder, and the temp
// suffixes of an upload in flight and of a two-step rename or text save.
export const TRASH_DIR_NAME = ".zcp-trash";
export const UPLOAD_TEMP_SUFFIX = ".zcpupload";
export const RENAME_TEMP_SUFFIX = ".zcptmp";
export const TRASH_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

// ============================================
// Limits (spec §A7)
// ============================================

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

export const FM_LIMITS = Object.freeze({
  REL_PATH_MAX_CHARS: 1024,
  SEGMENT_MAX_BYTES: 255,
  PATH_DEPTH_MAX: 64,
  PATHS_PER_REQUEST: 200,
  LIST_FULL_STAT_MAX: 2000,
  LIST_PAGE_DEFAULT: 500,
  LIST_PAGE_MAX: 1000,
  LIST_DIR_MAX_ENTRIES: 200000,
  TEXT_EDIT_MAX_BYTES: 2 * MiB,
  TEXT_TAIL_DEFAULT: 256 * KiB,
  TEXT_TAIL_MAX: 1 * MiB,
  UPLOAD_MAX_BYTES: Object.freeze({ local: 2 * GiB, sftp: 1 * GiB }),
  UPLOAD_FILES_PER_BATCH: 1000,
  UPLOAD_SLOTS_PER_USER: 2,
  UPLOAD_SLOTS_GLOBAL: 4,
  UPLOAD_IDLE_MS: 30000,
  DISK_FREE_FLOOR_BYTES: 1 * GiB,
  DOWNLOAD_MAX_BYTES: 4 * GiB,
  ZIP_MAX_ENTRIES: Object.freeze({ local: 10000, sftp: 2000 }),
  ZIP_MAX_BYTES: Object.freeze({ local: 4 * GiB, sftp: 1 * GiB }),
  ZIP_MAX_DEPTH: 32,
  ZIP_SLOTS_GLOBAL: 2,
  ZIP_SLOTS_PER_USER: 1,
  ZIP_TIME_LIMIT_MS: 900000,
  PREVIEW_WALK_MAX_ENTRIES: 50000,
  PREVIEW_WALK_MAX_MS: 5000,
  PREVIEW_TTL_MS: 300000,
  SEARCH_MAX_RESULTS: 500,
  SEARCH_MAX_VISITED: 50000,
  SEARCH_MAX_DEPTH: 12,
  SEARCH_MAX_MS: 5000,
  TRASH_RETENTION_DAYS: 7,
  TRASH_VERSIONS_PER_FILE: 20,
  PERMANENT_DELETE_MAX_ENTRIES: 500000,
  JOB_TTL_AFTER_DONE_MS: 600000,
  SFTP_READY_TIMEOUT_MS: 10000,
  SFTP_OP_TIMEOUT_MS: 20000,
  SFTP_TRANSFER_IDLE_MS: 30000,
  SFTP_IDLE_CLOSE_MS: 60000,
  SFTP_MAX_CLIENTS: 3,
  AUDIT_RETENTION: 1000,
  DENIED_AUDIT_COALESCE_MS: 60000,
  RUNSTATE_CACHE_MS: 5000,
  ROOT_PROBE_CACHE_MS: 30000,
});

// ============================================
// Errors (spec §A11)
// ============================================

// HTTP status of every Server Files error code. FmError uses it when no
// status is passed.
export const FM_ERROR_STATUS = Object.freeze({
  [ErrorCode.FM_AUTH_DISABLED]: 403,
  [ErrorCode.FM_TOKEN_IN_URL]: 400,
  [ErrorCode.FM_INVALID_REQUEST]: 400,
  [ErrorCode.FM_INVALID_PATH]: 400,
  [ErrorCode.FM_INVALID_NAME]: 400,
  [ErrorCode.FM_UNSUPPORTED_MEDIA_TYPE]: 415,
  [ErrorCode.FM_LENGTH_REQUIRED]: 411,
  [ErrorCode.FM_PROFILE_NOT_FOUND]: 404,
  [ErrorCode.FM_ROOT_UNKNOWN]: 404,
  [ErrorCode.FM_ROOT_UNAVAILABLE]: 503,
  [ErrorCode.FM_ROOT_READ_ONLY]: 409,
  [ErrorCode.FM_ROOT_IMMUTABLE]: 400,
  [ErrorCode.FM_NOT_FOUND]: 404,
  [ErrorCode.FM_NOT_A_DIRECTORY]: 400,
  [ErrorCode.FM_NOT_A_FILE]: 400,
  [ErrorCode.FM_PATH_PROTECTED]: 403,
  [ErrorCode.FM_LINK_ESCAPES_ROOT]: 403,
  [ErrorCode.FM_OS_PERMISSION_DENIED]: 403,
  [ErrorCode.FM_EXISTS]: 409,
  [ErrorCode.FM_CONFLICT]: 409,
  [ErrorCode.FM_CONFIRMATION_REQUIRED]: 409,
  [ErrorCode.FM_PREVIEW_EXPIRED]: 409,
  [ErrorCode.FM_PREVIEW_STALE]: 409,
  [ErrorCode.FM_SERVER_RUNNING_BLOCKED]: 409,
  [ErrorCode.FM_OPERATION_IN_PROGRESS]: 409,
  [ErrorCode.FM_FILE_IN_USE]: 409,
  [ErrorCode.FM_TARGET_READ_ONLY]: 409,
  [ErrorCode.FM_CROSS_DEVICE]: 409,
  [ErrorCode.FM_MOVE_INTO_SELF]: 400,
  [ErrorCode.FM_TYPED_CONFIRMATION_MISMATCH]: 400,
  [ErrorCode.FM_BINARY_FILE]: 415,
  [ErrorCode.FM_ENCODING_UNSUPPORTED]: 415,
  [ErrorCode.FM_FILE_TOO_LARGE_FOR_EDITOR]: 413,
  [ErrorCode.FM_UPLOAD_TOO_LARGE]: 413,
  [ErrorCode.FM_DOWNLOAD_TOO_LARGE]: 413,
  [ErrorCode.FM_ZIP_TOO_LARGE]: 413,
  [ErrorCode.FM_UPLOAD_SIZE_MISMATCH]: 400,
  [ErrorCode.FM_INSUFFICIENT_SPACE]: 507,
  [ErrorCode.FM_TRASH_UNAVAILABLE]: 503,
  [ErrorCode.FM_TRASH_ITEM_NOT_FOUND]: 404,
  [ErrorCode.FM_JOB_NOT_FOUND]: 404,
  [ErrorCode.FM_RATE_LIMITED]: 429,
  [ErrorCode.FM_TOO_MANY_TRANSFERS]: 429,
  [ErrorCode.FM_SFTP_ERROR]: 502,
  [ErrorCode.FM_SFTP_TIMEOUT]: 504,
  [ErrorCode.FM_INTERNAL]: 500,
  [ErrorCode.FM_TOO_MANY_ENTRIES]: 413,
  [ErrorCode.FM_SECRET_NAME_REQUIRED]: 400,
});

/**
 * The only error a file-manager backend or service throws. `message` is the
 * code itself: it never carries a path or an OS message, so nothing sensitive
 * can leak through a generic error handler. `params` travels to the client
 * (interpolated into the errors.json text); `details` is optional extra JSON
 * the route may add to the response (e.g. what FM_CONFIRMATION_REQUIRED is
 * asking about).
 */
export class FmError extends Error {
  /**
   * @param {string} code  an ErrorCode.FM_* value
   * @param {number} [status]  defaults to FM_ERROR_STATUS[code], else 500
   * @param {Record<string, unknown>} [params]
   */
  constructor(code, status, params) {
    super(code);
    this.name = "FmError";
    this.code = code;
    this.status = Number.isInteger(status) ? status : (FM_ERROR_STATUS[code] ?? 500);
    this.params = params && typeof params === "object" ? { ...params } : {};
    /** @type {Record<string, unknown>|undefined} */
    this.details = undefined;
  }
}

// ============================================
// Name and path rules (spec §A4.2)
// ============================================
//
// Pure, and identical on every OS so the model is uniform. Mirrored exactly
// by client/src/components/files/nameRules.ts. The checks run in the table's
// order, so a name that breaks several rules always reports the same reason.

// Windows device names, matched on the part before the first dot with
// trailing spaces removed ("con.txt", "NUL .log" and "Com1.tar.gz" all count).
const RESERVED_DEVICE_NAME_RE = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9]|CONIN\$|CONOUT\$)$/i;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;
const WINDOWS_RESERVED_RE = /[<>"|?*]/;
const BIDI_CONTROL_RE = /[‎‏‪-‮⁦-⁩]/;

// UTF-8 length, the way TextEncoder counts it (a lone surrogate becomes
// U+FFFD, three bytes), without allocating.
function utf8ByteLength(str) {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/** @returns {NameRuleReason|null} */
function segmentReason(seg) {
  if (utf8ByteLength(seg) > FM_LIMITS.SEGMENT_MAX_BYTES) return "tooLong";
  if (seg === "." || seg === "..") return "dotSegment";
  if (CONTROL_RE.test(seg)) return "control";
  if (seg.includes("\\")) return "backslash";
  if (seg.includes(":")) return "colon";
  if (WINDOWS_RESERVED_RE.test(seg)) return "windowsReserved";
  if (RESERVED_DEVICE_NAME_RE.test(seg.split(".")[0].replace(/ +$/, ""))) return "reservedDeviceName";
  if (seg.endsWith(".") || seg.endsWith(" ")) return "trailingDotOrSpace";
  if (BIDI_CONTROL_RE.test(seg)) return "bidiControl";
  return null;
}

/**
 * Validate a request `path`: POSIX segments joined by "/", "" meaning the
 * root. No decoding happens here or anywhere after Express, so a literal
 * "%2e%2e" is an ordinary name.
 * @param {unknown} raw
 * @returns {{ ok: true, segments: string[] } | { ok: false, reason: NameRuleReason }}
 */
export function validateSegments(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  if (raw === "") return { ok: true, segments: [] };
  // Before any regex runs.
  if (raw.length > FM_LIMITS.REL_PATH_MAX_CHARS) return { ok: false, reason: "tooLong" };
  const segments = raw.split("/");
  // "a//b", a leading "/" and a trailing "/" all leave an empty segment.
  if (segments.some((seg) => seg === "")) return { ok: false, reason: "empty" };
  if (segments.length > FM_LIMITS.PATH_DEPTH_MAX) return { ok: false, reason: "tooLong" };
  for (const seg of segments) {
    const reason = segmentReason(seg);
    if (reason) return { ok: false, reason };
  }
  return { ok: true, segments };
}

/**
 * Validate a single `name` field (mkdir, rename's newName, copy's newName,
 * restoreAs, an upload's file name). `isNew` adds the rules that only apply
 * to a name the panel is about to create.
 * @param {unknown} name
 * @param {{ isNew?: boolean }} [opts]
 * @returns {{ ok: true, name: string } | { ok: false, reason: NameRuleReason }}
 */
export function validateName(name, { isNew = false } = {}) {
  if (typeof name !== "string" || name === "") return { ok: false, reason: "empty" };
  // Before any regex runs.
  if (name.length > FM_LIMITS.REL_PATH_MAX_CHARS) return { ok: false, reason: "tooLong" };
  const reason = segmentReason(name);
  if (reason) return { ok: false, reason };
  if (isNew) {
    if (name.startsWith(" ")) return { ok: false, reason: "leadingSpace" };
    const lower = name.toLowerCase();
    if (
      lower === TRASH_DIR_NAME ||
      lower.endsWith(UPLOAD_TEMP_SUFFIX) ||
      lower.endsWith(RENAME_TEMP_SUFFIX)
    ) {
      return { ok: false, reason: "reservedPanelName" };
    }
  }
  if (name.includes("/")) return { ok: false, reason: "slash" };
  return { ok: true, name };
}
