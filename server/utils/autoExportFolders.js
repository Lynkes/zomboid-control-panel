import fs from "fs";
import path from "path";
import { decodeExportFolderName } from "./exportFolderName.js";

// SECURITY (2026-10-20): with "auto-export on login" on, every player name
// that joins gets a folder under <dataDir>/exports/ (one per exact name,
// utils/exportFolderName.js). Each folder's auto-exports are rotated, but
// the folders themselves never went: a client joining under endless made-up
// names filled the data volume. Past this many player folders, the auto-
// exports of the players exported longest ago are deleted (their folder too
// when nothing else is in it). A pre-import snapshot (routes/panelBridge.js,
// "<name>_pre-import_<time>.json") is an admin's recovery copy and is never
// deleted here; old-style folders (no "@") are never written to and are
// left alone.
export const MAX_AUTO_EXPORT_PLAYER_FOLDERS = 2000;

export function isAutoExportFileName(fileName) {
  return fileName.endsWith(".json") && !fileName.includes("_pre-import_");
}

/**
 * Brings the number of player export folders back to `max`, the folders
 * changed longest ago first; `keepFolder` (the one just written) is never
 * touched. Returns the folders removed. Synchronous, like autoExportPlayer's
 * own writes; throws only for an unreadable exports folder.
 */
export function enforceAutoExportFolderCap(exportsRoot, keepFolder, max = MAX_AUTO_EXPORT_PLAYER_FOLDERS) {
  const others = fs
    .readdirSync(exportsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== keepFolder && decodeExportFolderName(entry.name) !== null)
    .map((entry) => entry.name);
  let count = others.length + 1;
  if (count <= max) return [];

  const aged = [];
  for (const name of others) {
    try {
      aged.push({ name, mtimeMs: fs.statSync(path.join(exportsRoot, name)).mtimeMs });
    } catch {
      /* vanished meanwhile */
    }
  }
  aged.sort((left, right) => left.mtimeMs - right.mtimeMs);

  const removed = [];
  for (const { name } of aged) {
    if (count <= max) break;
    const dir = path.join(exportsRoot, name);
    try {
      for (const fileName of fs.readdirSync(dir)) {
        if (isAutoExportFileName(fileName)) fs.unlinkSync(path.join(dir, fileName));
      }
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        removed.push(name);
        count -= 1;
      }
    } catch {
      /* left for the next new player */
    }
  }
  return removed;
}
