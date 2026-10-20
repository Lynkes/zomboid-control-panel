import fs from "fs";
import path from "path";

// POST /api/panel-bridge/character/import writes a full export of the
// player's current data before every import:
// exports/<player folder>/<legacy name>_pre-import_<toISOString with ":" and
// "." as "-">[-<n>].json. Nothing removed them (the login auto-export's own
// rotation only runs on that player's next login), so repeated imports grew
// the folder without bound.
const SNAPSHOT_TAIL_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-(\d+))?\.json$/;

export const DEFAULT_PRE_IMPORT_SNAPSHOTS_KEPT = 5;

/**
 * Keeps the newest `keep` pre-import snapshots in `exportDir` and deletes
 * the older ones. Only names this exact shape for this player are touched,
 * never an auto-export or any other file. Newest by timestamp, then by
 * collision suffix (a "-2" copy was written after the plain one).
 *
 * @returns {string[]} the names removed
 */
export function prunePreImportSnapshots(exportDir, safeUsername, keep) {
  const kept = Number.isInteger(keep) && keep >= 1 ? keep : DEFAULT_PRE_IMPORT_SNAPSHOTS_KEPT;
  const prefix = `${safeUsername}_pre-import_`;
  const snapshots = [];
  for (const name of fs.readdirSync(exportDir)) {
    if (!name.startsWith(prefix)) continue;
    const match = SNAPSHOT_TAIL_RE.exec(name.slice(prefix.length));
    if (!match) continue;
    snapshots.push({ name, key: match[1], suffix: match[2] ? Number(match[2]) : 1 });
  }
  snapshots.sort((a, b) => (a.key !== b.key ? (a.key < b.key ? 1 : -1) : b.suffix - a.suffix));
  const removed = [];
  for (const old of snapshots.slice(kept)) {
    try {
      fs.unlinkSync(path.join(exportDir, old.name));
      removed.push(old.name);
    } catch {
      /* a folder or a file already gone: nothing to rotate */
    }
  }
  return removed;
}
