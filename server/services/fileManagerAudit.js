// Server Files audit trail (spec §A9). Every mutation, download and denial
// writes exactly one row, from a `finally` block: to the lowdb file_audit
// collection (newest first, capped) and as one winston line in the panel's
// logs folder, which the file manager itself seals, so flooding the
// database can't erase the history. File content and the SFTP password are
// never part of a row.
import crypto from "crypto";
import { appendFileAudit } from "../database/init.js";
import { createLogger } from "../utils/logger.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { FM_LIMITS } from "./fileManagerContract.js";

const log = createLogger("FileManager:Audit");

const MAX_PATHS = 20;
const MAX_PATH_CHARS = 1024;
const USER_AGENT_MAX = 120;
const COALESCE_MAX_KEYS = 5000;

// Denials worth a row: someone reached for something the file manager
// refuses on purpose.
export const DENIAL_CODES = new Set([
  ErrorCode.FM_PATH_PROTECTED,
  ErrorCode.FM_LINK_ESCAPES_ROOT,
  ErrorCode.FM_INVALID_PATH,
  ErrorCode.FM_INVALID_NAME,
]);

const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g;

export function cleanAuditPath(p) {
  return String(p ?? "").replace(CONTROL_CHARS_RE, "").slice(0, MAX_PATH_CHARS);
}

export function actorFromRequest(req) {
  const ua = req?.get?.("user-agent");
  return {
    userId: req?.user?.userId ?? null,
    username: req?.user?.username ?? null,
    role: req?.user?.role ?? null,
    ip: typeof req?.ip === "string" ? req.ip : null,
    userAgent: typeof ua === "string" ? ua.replace(CONTROL_CHARS_RE, "").slice(0, USER_AGENT_MAX) : null,
  };
}

export const SYSTEM_ACTOR = Object.freeze({ userId: null, username: "system", role: null, ip: null, userAgent: null });

function buildRow(fields) {
  const paths = Array.isArray(fields.paths) ? fields.paths.filter((p) => typeof p === "string") : [];
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    actor: fields.actor || SYSTEM_ACTOR,
    profileId: fields.profileId ?? null,
    profileName: fields.profileName ?? null,
    backend: fields.backend ?? null,
    rootId: fields.rootId ?? null,
    op: fields.op,
    ...(fields.attemptedOp ? { attemptedOp: fields.attemptedOp } : {}),
    paths: paths.slice(0, MAX_PATHS).map(cleanAuditPath),
    pathsTruncated: paths.length > MAX_PATHS,
    dest: fields.dest === null || fields.dest === undefined ? null : cleanAuditPath(fields.dest),
    bytes: Number.isFinite(fields.bytes) ? fields.bytes : null,
    sha256Before: typeof fields.sha256Before === "string" ? fields.sha256Before : null,
    sha256After: typeof fields.sha256After === "string" ? fields.sha256After : null,
    trashIds: Array.isArray(fields.trashIds) ? fields.trashIds.slice(0, MAX_PATHS) : [],
    confirm: Array.isArray(fields.confirm) ? [...fields.confirm] : [],
    result: fields.result || "ok",
    code: fields.code ?? null,
    durationMs: Number.isFinite(fields.durationMs) ? Math.round(fields.durationMs) : null,
  };
}

function logLine(row) {
  const who = row.actor?.username || "unknown";
  const where = `${row.profileId ?? "-"}:${row.rootId ?? "-"}:${row.paths[0] ?? ""}`;
  const more = row.paths.length > 1 ? ` (+${row.paths.length - 1})` : "";
  const outcome = row.result === "ok" ? "ok" : `${row.result}${row.code ? ` ${row.code}` : ""}`;
  log.info(`${row.op} by ${who} from ${row.actor?.ip ?? "-"}: ${where}${more} -> ${outcome}`);
}

/**
 * Write one audit row. Never throws: a failed audit must not turn a finished
 * file operation into an error response.
 */
export async function writeAudit(fields) {
  try {
    const row = buildRow(fields);
    try {
      logLine(row);
    } catch {
      /* logging must not block the row */
    }
    await appendFileAudit(row);
    return row;
  } catch {
    return null;
  }
}

/** @type {Map<string, number>} */
const recentDenials = new Map();

export function _resetDenialCoalescingForTests() {
  recentDenials.clear();
}

/**
 * A denial row, coalesced per (user, path, code) for 60 s so a client
 * retrying in a loop can't flood the trail. Returns whether a row was
 * written.
 */
export async function writeDenied(fields) {
  const now = Date.now();
  const key = `${fields.actor?.userId ?? "-"}|${fields.profileId ?? "-"}|${fields.rootId ?? "-"}|${fields.paths?.[0] ?? ""}|${fields.code}`;
  const last = recentDenials.get(key);
  if (last !== undefined && now - last < FM_LIMITS.DENIED_AUDIT_COALESCE_MS) return false;
  if (recentDenials.size >= COALESCE_MAX_KEYS) {
    for (const [k, at] of recentDenials) {
      if (now - at >= FM_LIMITS.DENIED_AUDIT_COALESCE_MS) recentDenials.delete(k);
    }
    if (recentDenials.size >= COALESCE_MAX_KEYS) recentDenials.clear();
  }
  recentDenials.set(key, now);
  await writeAudit({ ...fields, op: "files.denied", result: "denied" });
  return true;
}
