import fs from "fs";

// Readers for a Workshop mod's mod.info that only the panel's own lookups use
// (the display name, the diagnostics' id list). A real mod.info is a few
// hundred bytes of key=value lines; the file comes from whoever published the
// Workshop item, so it is read up to a cap and parsed one line at a time.
//
// SECURITY (2026-10-20): modChecker matched /^\s*name\s*=\s*(.+)$/m against
// the whole uncapped file, and the support diagnostics matched
// /^id\s*=\s*(.+?)\s*$/i per line. Both backtrack: a mod.info of 160 KB of
// blank lines held the event loop for 16 s, at every panel start and update
// check, and one long id= line with inner spaces did the same to diagnostics.

export const MOD_INFO_MAX_BYTES = 64 * 1024;

function decode(buffer) {
  const text = buffer.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function notAFile(filePath) {
  return Object.assign(new Error(`Not a regular file: ${filePath}`), { code: "EINVAL" });
}

/**
 * The first MOD_INFO_MAX_BYTES of a mod.info, without a BOM. Throws like
 * fs.readFileSync, and for anything but a regular file: opening a FIFO named
 * mod.info would wait for a writer forever.
 */
export function readModInfoTextSync(filePath, maxBytes = MOD_INFO_MAX_BYTES) {
  if (!fs.statSync(filePath).isFile()) throw notAFile(filePath);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return decode(buffer.subarray(0, bytesRead));
  } finally {
    fs.closeSync(fd);
  }
}

/** Async readModInfoTextSync. */
export async function readModInfoText(filePath, maxBytes = MOD_INFO_MAX_BYTES) {
  if (!(await fs.promises.stat(filePath)).isFile()) throw notAFile(filePath);
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close().catch(() => {});
  }
}

// CRLF, LF or a lone CR ends a line, as it did for the old regexes.
const LINE_BREAK = /\r\n|[\n\r]/;

/**
 * Every `key=value` line, in order: the key trimmed, the value trimmed, the
 * key's case kept. Lines without "=" or with an empty key are skipped.
 */
export function modInfoEntries(content) {
  const entries = [];
  for (const rawLine of String(content || "").split(LINE_BREAK)) {
    const separator = rawLine.indexOf("=");
    if (separator === -1) continue;
    const key = rawLine.slice(0, separator).trim();
    if (!key) continue;
    entries.push({ key, value: rawLine.slice(separator + 1).trim() });
  }
  return entries;
}

/** The first non-empty name= value (key matched exactly, like the old regex), or null. */
export function modInfoName(content) {
  for (const { key, value } of modInfoEntries(content)) {
    if (key === "name" && value) return value;
  }
  return null;
}
