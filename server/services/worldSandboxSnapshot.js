import fs from "fs";
import os from "os";
import path from "path";

// The world save's own copy of the sandbox settings (#197). Build 42 loads
// SandboxVars.lua, then SandboxOptions.load() (IsoWorld.init) reads
// <data folder>/Saves/Multiplayer/<server>/map_sand.bin and applies every
// option in it on top, on every start; without the file it keeps
// SandboxVars.lua (javap, 42.21). Only the Lua global saveGame()
// (GameWindow.save, the single-player save path) writes it: a vanilla
// dedicated server never does, PanelBridge did on every live edit until
// #197, and a world begun as a hosted game brings one along.
export const WORLD_SANDBOX_SNAPSHOT_FILE = "map_sand.bin";

// A server name the game uses as a folder name (Saves/Multiplayer/<name>):
// one path segment, and not "." or "..", which path.basename() leaves as
// they are.
export function isServerFolderName(name) {
  return (
    typeof name === "string" &&
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    path.basename(name) === name
  );
}

// The game's own data folder, used when it starts without -cachedir:
// Zomboid in the home folder (ZomboidFileSystem's default cache dir).
export function defaultGameDataDir() {
  return path.join(os.homedir(), "Zomboid");
}

// resolveLaunchMode()'s rule (serverManager.js): an install path naming a
// launcher file is a launcher the operator wrote.
const LAUNCHER_FILE = /\.(bat|sh|exe)$/i;

// Whether the server starts from a script the panel writes
// (StartServer_<name>.bat / start-server_<name>.sh), which passes -cachedir
// only for a configured data folder. A custom start command, a launcher
// file or a profile with no install folder may pass its own. A legacy setup
// with no profile row starts the script the panel wrote at install.
function startsFromPanelScript(server) {
  if (!server) return true;
  const launchPath = String(server.serverPath || server.installPath || "");
  return !server.startCommand && Boolean(launchPath) && !LAUNCHER_FILE.test(launchPath);
}

// The folder a local server keeps Server/ and Saves/ in, the way its start
// decides it: the configured data folder (the profile's, or the legacy
// setting's when there is no profile row), which the start passes as
// -cachedir. Without one, a start script the panel writes passes no
// -cachedir, so the game uses its default folder. A start the panel doesn't
// write may pass its own; the game keeps Server/ and Saves/ side by side,
// so a config folder named Server names it. null when nothing tells.
export function localGameDataDir({ activeServer, legacyDataPath, serverConfigPath }) {
  const dataPath = activeServer ? activeServer.zomboidDataPath : legacyDataPath;
  if (dataPath) return dataPath;
  if (startsFromPanelScript(activeServer)) return defaultGameDataDir();
  if (serverConfigPath && path.basename(serverConfigPath).toLowerCase() === "server") {
    return path.dirname(serverConfigPath);
  }
  return null;
}

// <data folder>/Saves/Multiplayer/<server>/map_sand.bin for a local server,
// null for a remote one (checked over SFTP) or when the place can't be told.
export function localWorldSandboxSnapshotPath(context) {
  if (context?.activeServer?.isRemote || !isServerFolderName(context?.serverName)) return null;
  const dataDir = localGameDataDir(context);
  if (!dataDir) return null;
  return path.join(dataDir, "Saves", "Multiplayer", context.serverName, WORLD_SANDBOX_SNAPSHOT_FILE);
}

// { path, mtime } when the file is there, else null.
export async function statLocalWorldSandboxSnapshot(snapshotPath) {
  if (!snapshotPath) return null;
  try {
    const stats = await fs.promises.stat(snapshotPath);
    return stats.isFile() ? { path: snapshotPath, mtime: stats.mtime.toISOString() } : null;
  } catch {
    return null;
  }
}
