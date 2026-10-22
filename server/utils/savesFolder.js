import fs from "fs";
import path from "path";

// A world folder under <data folder>/Saves/Multiplayer is named after the
// server, but not always to the letter ("AU-NZ Auckland PvE" and
// "AU-NZ_Auckland_PvE"), so a folder is attributed to a server name by its
// lower-cased letters and digits alone when the exact name is not there.

export function saveFolderKey(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

// Never empty-equals-empty: a name with no letters or digits matches nothing
// by key.
export function saveFolderBelongsToName(folder, serverName) {
  const name = String(serverName ?? "");
  if (!name) return false;
  if (folder === name) return true;
  if (folder.toLowerCase() === name.toLowerCase()) return true;
  const key = saveFolderKey(name);
  return key !== "" && key === saveFolderKey(folder);
}

export function listWorldFolders(baseSavesPath) {
  try {
    return fs
      .readdirSync(baseSavesPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// Whether a server has a world folder, however its name is spelled there.
// Used to tell a server that has never started from one whose folder merely
// differs from the configured name.
export function serverHasWorldFolder(zomboidDataPath, serverName) {
  const base = path.join(zomboidDataPath, "Saves", "Multiplayer");
  if (fs.existsSync(path.join(base, serverName))) return true;
  return listWorldFolders(base).some((folder) => saveFolderBelongsToName(folder, serverName));
}
