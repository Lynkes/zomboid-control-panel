/**
 * Sanitize error messages before sending to clients.
 * Strips filesystem paths and other sensitive info that could aid attackers.
 */

import os from "os";
import { escapeRegExp } from "./regex.js";

// Matches any settings/config key that holds a credential-shaped value.
// Pattern-based (rather than an explicit key allowlist) so a newly added
// secret (e.g. jwtSecret, discordBotToken) is masked automatically instead
// of leaking until someone remembers to add it to a list.
export const SENSITIVE_FIELD_RE =
  /password|secret|token|apikey|api_key|jwt|sessionid|loginsecure|cookie|webhook|recovery/i;

/**
 * Detect a value that is just the bullet-mask sentinel we send to clients
 * (see maskSecretValue/maskSensitiveObject below). Still accepts the older
 * "••••••••" + last-4 shape too, which a page loaded before an upgrade may
 * send back. Used to avoid writing the
 * masked placeholder back over a real stored secret when a client echoes an
 * unmodified masked field back on save.
 */
export function isMaskedSecret(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("••••••••")) return true;
  if (/^[•*●○]+$/.test(value)) return true;
  return false;
}

/**
 * Mask a secret string. Says only that a value is set: no part of it.
 *
 * SECURITY (2026-10-04, AUTHZ-4): this used to keep the secret's last 4
 * characters "for reference". GET /api/servers has no capability gate (every
 * role's pages read the server list), so every signed-in role, moderator
 * included, read the last 4 characters of each server's RCON and admin
 * password -- the same went for every other masked setting and .ini line.
 * The fixed sentinel still satisfies isMaskedSecret(), so a client that
 * echoes it back on save keeps the stored value, as before.
 */
export function maskSecretValue(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  return "••••••••";
}

/**
 * Shallow-mask every string field whose key looks secret-like
 * (SENSITIVE_FIELD_RE). Used for API responses that echo back settings or
 * DB records containing credentials (RCON/admin passwords, tokens, cookies).
 */
export function maskSensitiveObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const masked = { ...obj };
  for (const [key, value] of Object.entries(masked)) {
    if (SENSITIVE_FIELD_RE.test(key) && typeof value === "string" && value) {
      masked[key] = maskSecretValue(value);
    }
  }
  return masked;
}

/**
 * Drop every field whose key looks secret-like (SENSITIVE_FIELD_RE) instead
 * of masking its value. Use this where the result can be WRITTEN BACK
 * somewhere a masked placeholder string would corrupt (e.g. persisted into a
 * config snapshot that a later "apply" writes verbatim into a live file) --
 * maskSensitiveObject()'s placeholder is only safe for values that are
 * strictly DISPLAYED, never replayed.
 */
export function omitSensitiveFields(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_FIELD_RE.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Mask a single server record's credentials (rconPassword, adminPassword,
 * ...) before it goes out over the API. Every /api/servers response —
 * list, single, create, update, activate, detect, auto-scan — must go
 * through this so a non-admin authenticated user (or a compromised
 * frontend origin) can't read a running server's RCON/admin password.
 */
export function sanitizeServerResponse(server) {
  return maskSensitiveObject(server);
}

/** Map sanitizeServerResponse over an array of server records. */
export function sanitizeServerResponseList(servers) {
  return Array.isArray(servers) ? servers.map(sanitizeServerResponse) : servers;
}

// SECURITY (2026-10-05, H1): sanitizeError() is what keeps host folders out
// of the error text other roles see: backup:progress and restore:progress
// (the "backups" room admits backups.download and backups.restore, which
// hold no host-path capability), restore results, and every route's error
// body. Its patterns used to cut a Windows path at its first space
// ("C:\Program Files (x86)\Steam\...\Project Zomboid Dedicated Server\..."
// kept everything after "C:\Program"), and they only knew ten POSIX
// top-level folders, so /data, /app, /zomboid, /pz-server and macOS's
// /Users went out whole. Two layers now:
//   1. The folders this panel actually uses -- its data, backups, logs and
//      program folders, every server's install/data/config path, the temp
//      and home folders -- matched as exact text, whatever characters they
//      hold, Windows ones ignoring case and in either slash style, together
//      with whatever path continues below them.
//   2. Patterns for any other absolute path. A Windows folder name may hold
//      spaces, as long as a separator follows it (the last name stops at a
//      space, where the sentence usually carries on); a quoted path is
//      taken whole, which is how Node's fs errors quote theirs; and any
//      POSIX path of two or more names is a path, but only where one can
//      start, so URLs ("https://host/a/b"), times and ratios ("3/4")
//      stay as written.
const PATH_PLACEHOLDER = "[path]";

// One folder or file name: no whitespace, separator, quote, or character
// Windows forbids in a name.
const NAME = String.raw`[^\s\\/'"<>|*?:]+`;
// A Windows folder name that may hold single spaces ("Program Files (x86)",
// "Project Zomboid Dedicated Server"). Only ever used in front of a
// separator, so the words after a path are never taken for a folder.
const SPACED_NAME = `${NAME}(?: ${NAME})*`;
// The same, for forward-slash paths, where "and 3/4" after the path could
// otherwise read as a folder "and 3" holding "4": a word after a space
// can't start with a digit.
const FWD_SPACED_NAME = String.raw`${NAME}(?: (?!\d)${NAME})*`;
// The last name of a path. It also stops at a closing bracket, since a
// path is often written "(C:\...\file.txt)".
const LAST_NAME = String.raw`[^\s\\/'"<>|*?:)\]}]*`;
// The last name of a backslash path, which may hold forward slashes.
const WIN_LAST_NAME = String.raw`[^\s\\'"<>|*?:)\]}]*`;
// Characters that can't come right before the start of a POSIX path: the
// rest of a word, URL, version, time, ratio or relative path.
const POSIX_START_GUARD = String.raw`(?<![\w.:~/\\\])%-])`;

// 'C:\...', "\\server\...", '/data/pz' -- a quoted string that starts like
// an absolute path is redacted whole, spaces included. A POSIX one needs a
// second name ('/help' is a chat command, '/data/pz' a folder).
const QUOTED_PATH_START = String.raw`(?:[A-Za-z]:[\\/]|\\\\|\/[^\s'"\/\\]+\/)`;
const SINGLE_QUOTED_PATH_RE = new RegExp(String.raw`'${QUOTED_PATH_START}[^'\r\n]*'`, "g");
const DOUBLE_QUOTED_PATH_RE = new RegExp(String.raw`"${QUOTED_PATH_START}[^"\r\n]*"`, "g");
// C:\Users\foo\bar or D:\Program Files (x86)\Steam\x.txt; one or more
// backslashes per separator, so a JSON-escaped C:\\Users\\foo is one path.
const WIN_PATH_RE = new RegExp(
  String.raw`(?<!\w)[A-Za-z]:\\+(?:${SPACED_NAME}\\+)*${WIN_LAST_NAME}`,
  "g",
);
// C:/Users/foo/bar (Node.js sometimes normalizes to this).
const WIN_FWD_PATH_RE = new RegExp(
  String.raw`(?<!\w)[A-Za-z]:\/+(?:${FWD_SPACED_NAME}\/+)*${LAST_NAME}`,
  "g",
);
// \\server\share\path
const UNC_PATH_RE = new RegExp(
  String.raw`\\\\[\w.$-]+(?:\\+(?:${SPACED_NAME}\\+)*${WIN_LAST_NAME})?`,
  "g",
);
// /data/pz/server, /Users/me/Zomboid, /app/data/db.json: two names or more.
const UNIX_PATH_RE = new RegExp(
  String.raw`${POSIX_START_GUARD}\/(?:${NAME}\/+)+${LAST_NAME}`,
  "g",
);

// What a configured folder may be followed by and still end there: not
// more of the same name ("/data" is not the start of "/database").
const FOLDER_END = String.raw`(?![\w-]|\.\w)`;
// The rest of a path below a configured folder, in either slash style
// (path.join() on Windows turns a POSIX-style setting's slashes around).
// Folder names below it may hold spaces: the configured folder already
// says this is a path.
const FOLDER_TAIL = String.raw`(?:[\\/]+(?:${FWD_SPACED_NAME}[\\/]+)*${LAST_NAME})?`;
const WINDOWS_ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const MAX_HOST_FOLDER_LENGTH = 1024;

const hostFolderSources = new Set();

/**
 * Add a source of host folders sanitizeError() redacts by exact text
 * (database/init.js adds the panel's own folders and every server's).
 * `source` returns an array of absolute paths; it runs on every
 * sanitizeError() call, so it must be synchronous and cheap. One that
 * throws adds nothing. Returns a function that removes it again.
 */
export function registerHostFolderSource(source) {
  if (typeof source !== "function") return () => {};
  hostFolderSources.add(source);
  return () => hostFolderSources.delete(source);
}

function collectHostFolders() {
  const folders = [];
  for (const read of [() => os.tmpdir(), () => os.homedir()]) {
    try {
      folders.push(read());
    } catch {
      /* no temp or home folder to report */
    }
  }
  for (const source of hostFolderSources) {
    try {
      const listed = source();
      if (Array.isArray(listed)) folders.push(...listed);
    } catch {
      /* a source that can't answer right now adds nothing */
    }
  }
  return folders;
}

// The regex source for one configured folder, or null when it isn't an
// absolute path, or is only a root ("/", "C:\"), which would redact the
// first character of every path.
function hostFolderEntry(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_HOST_FOLDER_LENGTH) return null;
  const windows = WINDOWS_ABSOLUTE_RE.test(trimmed);
  if (!windows && !trimmed.startsWith("/")) return null;
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const drive = windows && /^[A-Za-z]:$/.test(parts[0] || "");
  if (parts.length < (drive ? 2 : 1)) return null;
  const body = parts.map(escapeRegExp).join(String.raw`[\\/]+`);
  return {
    windows,
    length: trimmed.length,
    source: drive ? body : String.raw`[\\/]+${body}`,
  };
}

function buildHostFolderRe(entries, { windows }) {
  if (entries.length === 0) return null;
  const alternatives = [...new Set(
    entries.sort((a, b) => b.length - a.length).map((entry) => entry.source),
  )].join("|");
  return windows
    ? new RegExp(String.raw`(?<!\w)(?:${alternatives})${FOLDER_END}${FOLDER_TAIL}`, "gi")
    : new RegExp(`${POSIX_START_GUARD}(?:${alternatives})${FOLDER_END}${FOLDER_TAIL}`, "g");
}

let hostFolderCache = { key: null, patterns: [] };

// The configured-folder patterns, rebuilt only when the folder list changes.
function hostFolderPatterns() {
  const folders = collectHostFolders();
  const key = folders.map(String).join("\u0000");
  if (key === hostFolderCache.key) return hostFolderCache.patterns;
  const entries = folders.map(hostFolderEntry).filter(Boolean);
  const patterns = [
    buildHostFolderRe(entries.filter((entry) => entry.windows), { windows: true }),
    buildHostFolderRe(entries.filter((entry) => !entry.windows), { windows: false }),
  ].filter(Boolean);
  hostFolderCache = { key, patterns };
  return patterns;
}

/**
 * Remove filesystem paths from an error message.
 * @param {string} message - Raw error message
 * @returns {string} Sanitized message safe for client consumption
 */
export function sanitizeError(message) {
  if (!message || typeof message !== 'string') return 'An unexpected error occurred';
  let text = message;
  for (const pattern of hostFolderPatterns()) {
    text = text.replace(pattern, PATH_PLACEHOLDER);
  }
  return text
    .replace(SINGLE_QUOTED_PATH_RE, `'${PATH_PLACEHOLDER}'`)
    .replace(DOUBLE_QUOTED_PATH_RE, `"${PATH_PLACEHOLDER}"`)
    .replace(WIN_PATH_RE, PATH_PLACEHOLDER)
    .replace(WIN_FWD_PATH_RE, PATH_PLACEHOLDER)
    .replace(UNC_PATH_RE, PATH_PLACEHOLDER)
    .replace(UNIX_PATH_RE, PATH_PLACEHOLDER);
}

/**
 * Apply the same filesystem-path redaction as sanitizeError() to every
 * string value in a structured-error `params` object, so the params
 * channel can't leak a path the plain `error` message text would have
 * redacted (e.g. a `reason` param sourced from raw RCON output). Numbers
 * pass through unchanged; params is only ever string|number by the time
 * it reaches a response (see errorMessage.ts on the client for the
 * matching contract).
 * @param {Record<string, string|number>|undefined} params
 * @returns {Record<string, string|number>|undefined}
 */
export function sanitizeErrorParams(params) {
  if (!params || typeof params !== 'object') return params;
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = typeof value === 'string' ? sanitizeError(value) : value;
  }
  return out;
}

/**
 * Strip INI-sensitive characters from values to prevent injection.
 * Removes \r, \n (line injection), ; (comment / list delimiter), = (key separator).
 */
export function sanitizeIniValue(value) {
  if (value == null) return '';
  return String(value).replace(/[\r\n;=]/g, '');
}

/**
 * Sanitize an array of values for INI semicolon-delimited fields.
 */
export function sanitizeIniList(values) {
  return values.map(v => sanitizeIniValue(v)).filter(Boolean).join(';');
}

/**
 * Workshop IDs are 5-15 digit numeric strings (Steam fileId). PZ mod IDs
 * (the `id=` field inside mod.info) are letter-based identifiers and must
 * never be all-numeric. We use this to gate Mods= writes so workshop IDs
 * never get accidentally written into the Mods= line.
 */
export function looksLikeWorkshopId(value) {
  return typeof value === 'string' && /^\d{5,15}$/.test(value);
}

/**
 * Sanitize an array of mod IDs for the Mods= INI field. Drops any entry
 * that looks like a Steam Workshop file ID — those belong in
 * WorkshopItems=, never in Mods=, and writing them into Mods= results in
 * a polluted INI that PZ silently ignores.
 *
 * Returns the joined semicolon string. The dropped count is appended on
 * the returned function as a side channel via a wrapper if callers need
 * to log it; for simplicity we just filter here.
 */
export function sanitizeModIdList(values) {
  const out = [];
  for (const raw of values || []) {
    const v = sanitizeIniValue(raw);
    if (!v) continue;
    if (looksLikeWorkshopId(v)) continue; // workshop ID misplaced in Mods=
    out.push(v);
  }
  return out.join(';');
}
