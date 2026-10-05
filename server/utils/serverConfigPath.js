import fs from "fs";
import path from "path";

// SECURITY (2026-10-04, FILES-2): serverConfigPath is the folder Server
// Config reads and writes (<name>.ini, the .lua files, their .bak backups,
// templates). It was saved with no check at all, so servers.manage alone
// (technician) could point it at any folder on this computer, then list it,
// fetch images from it and write .ini/.lua files into it through
// /api/server-files. Every flow that sets it (detect, auto-scan, both
// install routes) sends <zomboidDataPath>/Server, so a value is accepted
// only when it resolves, links followed, to that folder or one inside it.
// The server's own data folder is the anchor, so one is required. The value
// is checked as typed (no %VAR% expansion, unlike zomboidDataPath), so
// nothing about the environment can be read back through this check.
//
// routes/servers.js applies it when the folder is saved; routes/
// serverFiles.js applies it again when the folder is used, so one saved
// before the check existed is refused there too.
const SERVER_CONFIG_PATH_MAX_LENGTH = 1024;

// realpath of the deepest part of `target` that exists, with the missing
// rest put back: a folder that isn't there yet still can't leave the anchor
// through a link in the part that is.
function resolveThroughLinks(target) {
  const resolved = path.resolve(target);
  let existing = resolved;
  const missing = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...missing);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return resolved;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function isSameOrInside(child, parent) {
  const rel = path.relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

export function serverConfigPathIsConfined(value, zomboidDataPath) {
  if (
    typeof value !== "string" ||
    value.length > SERVER_CONFIG_PATH_MAX_LENGTH ||
    /[\x00-\x1f]/.test(value) ||
    !path.isAbsolute(value)
  ) {
    return false;
  }
  if (typeof zomboidDataPath !== "string" || !zomboidDataPath.trim()) {
    return false;
  }
  const anchor = resolveThroughLinks(path.join(path.resolve(zomboidDataPath), "Server"));
  return isSameOrInside(resolveThroughLinks(value), anchor);
}
