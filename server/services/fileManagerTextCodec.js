// Text handling for the Server Files editor (spec §A6.1): which files are
// never opened as text, UTF-8 decoding that refuses anything it could
// damage, line-ending bookkeeping so a save round-trips byte for byte, and
// the .ini secret masking the raw config editor already uses.
import crypto from "crypto";
import path from "path";
import { ErrorCode } from "../utils/errorCodes.js";
import { SENSITIVE_FIELD_RE, isMaskedSecret } from "../utils/sanitize.js";
import { maskSensitiveIniLines, reconcileMaskedIniLines } from "../routes/serverFiles.js";
import { FM_LIMITS, FmError } from "./fileManagerContract.js";

// Refused before a byte is read: these are never text.
export const BINARY_EXTENSIONS = new Set([
  ".jar", ".class", ".bin", ".db", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ogg", ".wav",
  ".bank", ".zip", ".7z", ".gz", ".rar", ".dll", ".so", ".exe", ".pack", ".lotheader", ".lotpack", ".tiles",
]);

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export function extensionOf(name) {
  return path.extname(String(name || "")).toLowerCase();
}

export function isBinaryName(name) {
  return BINARY_EXTENSIONS.has(extensionOf(name));
}

export function isIniName(name) {
  return extensionOf(name) === ".ini";
}

// A copy of an .ini under any suffix keeps its secrets: the panel's own
// backups (configBackup.js `<name>.ini.<timestamp>.bak`, templateFiles.js
// `.bak-<n>`) and the ones people make by hand (`servertest.ini.bak`,
// `.ini.old`, `.ini.2026-09-30`): ".ini" as a whole dot-separated part of
// the last path segment.
const INI_COPY_RE = /\.ini(?:\.[^/\\]*)?$/i;

/**
 * An .ini file or a copy of one: its secret-looking lines are masked on
 * every way out and put back on every way in.
 */
export function isSecretBearingName(name) {
  const text = String(name || "");
  return isIniName(text) || INI_COPY_RE.test(text);
}

export function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// The editor's etag: a hash of the exact bytes on disk.
export function hashEtag(buffer) {
  return `h:${sha256Hex(buffer)}`;
}

// A per-process key for the etag of a file whose secrets are masked. A plain
// sha256 of the unmasked bytes next to the masked text would let a short
// password be brute-forced offline (everything but the secret's prefix is
// on screen); an HMAC under a key that never leaves this process can't be.
// The price: an editor left open across a panel restart gets a conflict and
// reloads.
const SECRET_ETAG_KEY = crypto.randomBytes(32);

/** The etag the editor sees for a secret-bearing file: the same "h:" + 64 hex shape. */
export function secretEtag(buffer) {
  return `h:${crypto.createHmac("sha256", SECRET_ETAG_KEY).update(buffer).digest("hex")}`;
}

export const HASH_ETAG_RE = /^h:[0-9a-f]{64}$/;

/** @returns {"lf"|"crlf"|"mixed"|"none"} */
export function detectEol(text) {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  if (crlf === 0 && lf === 0) return "none";
  if (crlf > 0 && lf > 0) return "mixed";
  return crlf > 0 ? "crlf" : "lf";
}

/**
 * Decode a file for the editor. Throws FM_ENCODING_UNSUPPORTED for UTF-16
 * or invalid UTF-8, FM_BINARY_FILE for a NUL byte. The text goes out with
 * CRLF turned into LF; `eol` and `bom` let the save rebuild the same bytes.
 */
export function decodeForEdit(buffer) {
  let body = buffer;
  let bom = false;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    bom = true;
    body = body.subarray(3);
  }
  if (body.length >= 2 && ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff))) {
    throw new FmError(ErrorCode.FM_ENCODING_UNSUPPORTED);
  }
  if (body.includes(0)) throw new FmError(ErrorCode.FM_BINARY_FILE);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new FmError(ErrorCode.FM_ENCODING_UNSUPPORTED);
  }
  const eol = detectEol(text);
  return { text: text.replace(/\r\n/g, "\n"), bom, eol };
}

/**
 * Decode the end of a file for the read-only tail view: replacement
 * characters instead of refusing, and a cut first line dropped so the view
 * starts on a whole line. `wholeLinesOnly` (a file whose secrets are masked)
 * drops the cut line even when it is the only one: a window that starts in
 * the middle of `RCONPassword=...` shows a fragment the mask can't
 * recognise, so nothing short of a whole line is shown.
 */
export function decodeTail(buffer, truncated, { wholeLinesOnly = false } = {}) {
  let body = buffer;
  if (!truncated && body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    body = body.subarray(3);
  }
  let text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(body);
  if (truncated) {
    const firstBreak = text.indexOf("\n");
    if (wholeLinesOnly) text = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
    else if (firstBreak !== -1 && firstBreak < text.length - 1) text = text.slice(firstBreak + 1);
  }
  const eol = detectEol(text);
  return { text: text.replace(/\r\n/g, "\n"), eol };
}

/**
 * Rebuild the bytes of a save: LF text, then CRLF when asked, then the BOM.
 * Throws FM_FILE_TOO_LARGE_FOR_EDITOR over the editor limit.
 */
export function encodeForSave(text, { eol, bom }) {
  let body = String(text).replace(/\r\n/g, "\n");
  if (eol === "crlf") body = body.replace(/\n/g, "\r\n");
  const encoded = Buffer.from(body, "utf8");
  const bytes = bom ? Buffer.concat([UTF8_BOM, encoded]) : encoded;
  if (bytes.length > FM_LIMITS.TEXT_EDIT_MAX_BYTES) {
    throw new FmError(ErrorCode.FM_FILE_TOO_LARGE_FOR_EDITOR, undefined, { limit: FM_LIMITS.TEXT_EDIT_MAX_BYTES });
  }
  return bytes;
}

/**
 * Mask secret-looking `Key=Value` lines of .ini text, keeping every line
 * ending as it was (maskSensitiveIniLines() itself joins with LF).
 * @returns {{ text: string, masked: boolean }}
 */
export function maskIniText(text) {
  const lines = String(text).split("\n");
  let masked = false;
  const out = lines.map((line) => {
    const cr = line.endsWith("\r");
    const core = cr ? line.slice(0, -1) : line;
    const result = maskSensitiveIniLines(core);
    if (result !== core) masked = true;
    return cr ? `${result}\r` : result;
  });
  return { text: out.join("\n"), masked };
}

// Mask an .ini file's bytes for a download or a zip entry.
export function maskIniBuffer(buffer) {
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(buffer);
  const result = maskIniText(text);
  return { buffer: Buffer.from(result.text, "utf8"), masked: result.masked };
}

// True when some secret-looking key's value is the mask placeholder, i.e.
// the text came from a masked download or view.
export function hasMaskedSecretLines(text) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (SENSITIVE_FIELD_RE.test(key) && isMaskedSecret(line.slice(eq + 1))) return true;
  }
  return false;
}

/**
 * Put the live secret values back where the incoming .ini text still holds
 * the mask placeholder (LF text in, LF text out). A save that can't be
 * reconciled is refused with the raw config editor's own codes.
 */
export function reconcileIniText(incomingText, liveText) {
  const result = reconcileMaskedIniLines(
    String(incomingText).replace(/\r\n/g, "\n"),
    String(liveText).replace(/\r\n/g, "\n"),
  );
  if (!result.ok) {
    const failure = new FmError(
      result.reason === "removed" ? ErrorCode.RAW_INI_SECRET_LINE_REMOVED : ErrorCode.RAW_INI_SECRET_UNRESOLVABLE,
      400,
      { key: String(result.key).slice(0, 100) },
    );
    throw failure;
  }
  return result.content;
}
