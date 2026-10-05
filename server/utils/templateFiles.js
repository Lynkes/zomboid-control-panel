// Low-level, sparse-key read/write for a server's .ini and _SandboxVars.lua
// files, used by templateService when applying a template. Deliberately
// narrow: it only ever touches the specific keys a template mentions, never
// attempts a full rewrite of either file. The INI side mirrors the small
// regex editors in server/services/serverManager.js; the Lua side goes
// through utils/sandboxLua.js, the one SandboxVars.lua reader/editor every
// route shares (#197).
import fs from "fs";
import path from "path";
import { escapeRegExp } from "./regex.js";
import { writeFileAtomic } from "./fileWriteQueue.js";
import { editSandboxValues, readSandboxPath } from "./sandboxLua.js";

// ---- server.ini ----------------------------------------------------------

// [ \t]* tolerance around both the key and "=" matches the convention
// routes/mods.js settled on 2026-08-27 for its own Mods=/WorkshopItems=/
// Map= writers: a bare `^key=` regex does not match a hand-edited or
// raw-editor-saved "Key = value" line (serverFiles.js's toIni() no longer
// auto-normalizes spacing away on save, see that file's own history), so a
// perfectly real, existing line was invisible to this reader. That matters
// beyond a missed read here -- server/utils/discordMessageRedaction.js's
// readServerJoinPassword() calls this to collect the values
// redactKnownSecrets() scrubs from every Discord-bound message; a spaced
// `Password = ...` line meant the join password silently never entered
// that set, so an RCON response echoing it would have posted to Discord in
// plaintext, defeating the one thing that module exists to prevent. The
// two Lua/SandboxVars siblings below (readSandboxValue/applySandboxValue)
// already tolerated this; only the ini side hadn't been brought in line.
export function readIniValues(content, keys) {
  const values = {};
  for (const key of keys) {
    const match = content.match(new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=(.*)$`, "m"));
    if (match) values[key] = match[1].trim();
  }
  return values;
}

/**
 * Replace or append each key=value pair. Creates the file content if empty.
 *
 * Same [ \t]* tolerance as readIniValues above, and for the same reason on
 * the write side: the old bare `^key=` regex didn't match a spaced
 * "Key = value" line either, so `regex.test(result)` came back false and
 * the else-branch APPENDED a second, unspaced copy of the key instead of
 * replacing the first -- the exact duplicate-key defect routes/mods.js's
 * 2026-08-27 comment describes, reproduced here independently. The
 * replacement line is written back unspaced (`key=value`, no surrounding
 * whitespace), the same normalize-on-write behavior mods.js's own fix uses,
 * not a preserve-the-original-formatting rewrite.
 */
export function mergeIniValues(content, updates) {
  let result = content || "";
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
    const regex = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=.*$`, "m");
    const safeValue = String(value).replace(/[\r\n]/g, "");
    if (regex.test(result)) {
      result = result.replace(regex, `${key}=${safeValue}`);
    } else {
      result += `${result && !result.endsWith("\n") ? "\n" : ""}${key}=${safeValue}\n`;
    }
  }
  return result;
}

// ---- SandboxVars.lua -------------------------------------------------------

// "settings" is the top level; any other section is the block of that name.
// Keys are looked up in their own table only, so a top-level "Farming" and
// MultiplierConfig.Farming never read or write each other.
function sandboxPath(section, key) {
  return section === "settings" ? [key] : [section, key];
}

/** Read the current value of `key` within `section` ("settings" = top level). */
export function readSandboxValue(content, section, key) {
  return readSandboxPath(content, sandboxPath(section, key));
}

/**
 * Replace `key`'s value within `section` if that key already exists there.
 * Returns { content, applied }. Keys the file doesn't already define are
 * reported as not applied rather than appended — SandboxVars.lua is always
 * server-generated with every known key present, so a missing key means the
 * file predates this setting and blindly appending risks a malformed table.
 * A key that is a table in the file is never overwritten with a value.
 */
export function applySandboxValue(content, section, key, value) {
  const { content: next, applied } = mergeSandboxSections(content, {
    [section]: { [key]: value },
  });
  return { content: next, applied: applied.length > 0 };
}

/**
 * Apply every key in `sectionUpdates` (shape: { settings: {...}, ZombieLore: {...} }).
 * `error` is set, and nothing is applied, when the file does not parse.
 */
export function mergeSandboxSections(content, sectionUpdates) {
  const entries = [];
  for (const [section, values] of Object.entries(sectionUpdates || {})) {
    for (const [key, value] of Object.entries(values || {})) {
      entries.push({ section, key, path: sandboxPath(section, key), value });
    }
  }
  const result = editSandboxValues(content, entries);
  if (!result.ok) {
    return {
      content,
      applied: [],
      skipped: entries.map(({ section, key }) => ({ section, key })),
      error: result.error,
    };
  }
  const applied = [];
  const skipped = [];
  result.results.forEach((r, i) => {
    const { section, key } = entries[i];
    if (r.status === "changed" || r.status === "unchanged") applied.push({ section, key });
    else skipped.push({ section, key });
  });
  return { content: result.content, applied, skipped };
}

// ---- Backups ---------------------------------------------------------------

/** Copy `filePath` into a timestamped `.bak` next to it. No-op if missing. */
export function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const dir = path.join(path.dirname(filePath), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // toISOString() is millisecond-resolution; two backups of the same file
  // close together (e.g. two template applies queued back to back through
  // the same withFileLock) can land in the same millisecond, which would
  // make the second silently overwrite the first with no error. Disambiguate
  // with a counter suffix, same pattern as configBackup.js/database/init.js.
  let backupPath = path.join(dir, `${path.basename(filePath)}.${stamp}.bak`);
  if (fs.existsSync(backupPath)) {
    let suffix = 2;
    while (fs.existsSync(`${backupPath}-${suffix}`)) suffix++;
    backupPath = `${backupPath}-${suffix}`;
  }
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

export function writeFile(filePath, content) {
  writeFileAtomic(filePath, content, "utf-8");
}

export function writeFilesTransaction(changes) {
  const written = [];
  try {
    for (const change of changes) {
      writeFile(change.filePath, change.content);
      written.push(change);
    }
  } catch (error) {
    for (const change of written.reverse()) {
      try {
        if (change.existed) {
          writeFile(change.filePath, change.original);
        } else if (fs.existsSync(change.filePath)) {
          fs.unlinkSync(change.filePath);
        }
      } catch {
        // The pre-write backup remains available if rollback itself fails.
      }
    }
    throw error;
  }
}
