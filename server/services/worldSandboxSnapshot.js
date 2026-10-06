import fs from "fs";
import os from "os";
import path from "path";
import { getActiveServer, getAllSettings } from "../database/init.js";
import { createLogger } from "../utils/logger.js";
import { activeServerConfigDir, serverConfigDirRefusal } from "../utils/serverConfigPath.js";
import { describeRefusal, logRefusalOnce, zomboidDataFolderHolds } from "./zomboidDataPath.js";
import {
  SFTP_CONFIG_PATH_KEY,
  findRemoteWorldSandboxSnapshot,
  isRemoteConfigConfigured,
  validateRemoteConfigTransport,
} from "./remoteConfigFiles.js";

const log = createLogger("WorldSandboxSnapshot");

// The world save's own copy of the sandbox settings (#197). Build 42 loads
// SandboxVars.lua, then SandboxOptions.load() (IsoWorld.init) reads
// <data folder>/Saves/Multiplayer/<server>/map_sand.bin and applies every
// option in it on top, on every start; without the file it keeps
// SandboxVars.lua (javap, 42.21). Only the Lua global saveGame()
// (GameWindow.save, the single-player save path) writes it: a vanilla
// dedicated server never does, PanelBridge did on every live edit until
// #197, and a world begun as a hosted game brings one along.
export const WORLD_SANDBOX_SNAPSHOT_FILE = "map_sand.bin";

// What the panel adds to a live sandbox change it sends PanelBridge when the
// world already has a map_sand.bin. Only then does the bridge rewrite the
// file (saveGame()), so the change also lands in the copy the next start
// loads. A world without one never gets one, and a bridge that receives no
// flag (an older panel) never touches the file.
export const WORLD_SANDBOX_SNAPSHOT_ARG = "worldHasSandboxSnapshot";

// The bridge actions that change sandbox options in the running game:
// setSandboxOption (Mod Settings), restoreUtilities/shutOffUtilities
// (Events > Power and water, and scheduled tasks; they set ElecShut,
// WaterShut and their modifiers) and runEventSequence, whose "utilities"
// steps run those two.
export const LIVE_SANDBOX_BRIDGE_ACTIONS = new Set([
  "setSandboxOption",
  "restoreUtilities",
  "shutOffUtilities",
  "runEventSequence",
]);

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
//
// The data folder is held to the data-folder rule (services/zomboidDataPath.js,
// PATHS-1) here, where every caller gets the path it stats or moves the file
// from: a folder the rule refuses gives null, so nothing under it is
// touched. That covers each folder localGameDataDir() can pick (the
// record's, the legacy setting's, the game's default folder, the config
// folder's parent), not only the data folder in effect that Server Files'
// gate judges.
export function localWorldSandboxSnapshotPath(context) {
  if (context?.activeServer?.isRemote || !isServerFolderName(context?.serverName)) return null;
  const dataDir = localGameDataDir(context);
  if (!dataDir || !zomboidDataFolderHolds(dataDir)) return null;
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

// How long a live change waits for the remote world save check.
const REMOTE_CHECK_TIMEOUT_MS = 10000;

// The SFTP transport to the remote Server folder, from Settings >
// PanelBridge. The same mapping as serverFiles.js's own
// resolveRemoteConfigTransport().
function remoteConfigTransport(settings) {
  if (!isRemoteConfigConfigured(settings)) return null;
  return validateRemoteConfigTransport({
    host: settings.panelBridgeSftpHost,
    port: settings.panelBridgeSftpPort,
    username: settings.panelBridgeSftpUsername,
    password: settings.panelBridgeSftpPassword,
    configPath: settings[SFTP_CONFIG_PATH_KEY],
  });
}

/**
 * { path, mtime } when the active server's world has a map_sand.bin, else
 * null. For the callers outside Server Config's request pipeline (the
 * PanelBridge routes, the scheduler), which resolve the active server the
 * way Server Config does: a local world by its data folder
 * (localGameDataDir), under the folder rules Server Config's gate applies,
 * a remote one over SFTP (the same check as the config pull). A check that
 * fails or is refused reads as "none", as the Server Config warning does, so
 * the bridge is never told to write a file the panel didn't see.
 */
export async function findActiveWorldSandboxSnapshot() {
  try {
    const activeServer = await getActiveServer();
    const settings = (await getAllSettings()) || {};
    const serverName = activeServer?.serverName || settings.serverName;
    if (!isServerFolderName(serverName)) return null;

    if (activeServer?.isRemote) {
      const transport = remoteConfigTransport(settings);
      if (!transport) return null;
      // A live edit waits on this: a host that stops answering reads as
      // "none" after a while instead of holding the edit for the SFTP
      // session's own two-minute limit.
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer from ${transport.host} in ${REMOTE_CHECK_TIMEOUT_MS / 1000}s`)),
          REMOTE_CHECK_TIMEOUT_MS,
        );
        timer.unref?.();
      });
      try {
        return await Promise.race([findRemoteWorldSandboxSnapshot(transport, serverName), timeout]);
      } finally {
        clearTimeout(timer);
      }
    }

    // Server Config's config folder, judged as Server Files' gate judges it
    // (utils/serverConfigPath.js, FILES-2/PATHS-1/PATHS-2): a config folder
    // outside the data folder in effect, or a data folder that fails the
    // data-folder rule, is refused there, so its world save isn't looked at
    // here either and the bridge is told nothing about one.
    const configDir = activeServerConfigDir(activeServer, settings);
    if (configDir.refused) {
      logRefusalOnce(
        log,
        `Not checking the world save for map_sand.bin: ${describeRefusal(serverConfigDirRefusal(configDir))}`,
      );
      return null;
    }
    return await statLocalWorldSandboxSnapshot(
      localWorldSandboxSnapshotPath({
        activeServer,
        legacyDataPath: settings.zomboidDataPath,
        serverConfigPath: configDir.dir,
        serverName,
      }),
    );
  } catch (error) {
    log.warn(`Could not check the world save for map_sand.bin: ${error.message}`);
    return null;
  }
}

// `args` for the bridge, carrying the flag only when the world has a
// map_sand.bin. A caller's own value never passes through: whether the
// bridge writes the file is the panel's call, made from what it found.
export function withWorldSandboxSnapshotFlag(args, snapshot) {
  const { [WORLD_SANDBOX_SNAPSHOT_ARG]: _callerValue, ...rest } = args || {};
  return snapshot ? { ...rest, [WORLD_SANDBOX_SNAPSHOT_ARG]: true } : rest;
}

// Whether the bridge's answer says it rewrote map_sand.bin with the change.
// A current bridge says so in `worldSandboxSaved` when it was told the world
// has the file. PanelBridge 1.7.72 and older ran saveGame() after every
// setSandboxOption and reported it as `persisted`, and never saved after
// restoreUtilities/shutOffUtilities. saveGame() logs a failed save instead
// of raising it, so "saved" means the save ran.
function bridgeRewroteWorldSandbox(action, data) {
  if (typeof data?.worldSandboxSaved === "boolean") return data.worldSandboxSaved;
  return action === "setSandboxOption" && data?.persisted === true;
}

/**
 * What a live sandbox change left in the world's map_sand.bin, for the
 * response: null when the world has none (SandboxVars.lua is what the next
 * start uses), else { path, refreshed }, refreshed being whether the bridge
 * rewrote the file with the change. When it didn't, the next start undoes
 * the change whatever SandboxVars.lua says. A runEventSequence answer
 * counts only its utilities steps, and is null when none of them ran.
 */
export function worldSandboxAfterLiveChange(action, data, snapshot) {
  if (!snapshot) return null;
  if (action === "runEventSequence") {
    const steps = (Array.isArray(data?.results) ? data.results : []).filter(
      (step) => step?.kind === "utilities" && step.success === true,
    );
    if (steps.length === 0) return null;
    return {
      path: snapshot.path,
      refreshed: steps.every((step) => step.data?.worldSandboxSaved === true),
    };
  }
  return { path: snapshot.path, refreshed: bridgeRewroteWorldSandbox(action, data) };
}

/**
 * After the server's own save (RCON `save`, which never writes
 * map_sand.bin): rewrite the world's map_sand.bin through the bridge when
 * the world already has one, which is what the bridge's saveWorld, the
 * panel's Save World before #197, did. Only for a save that used to be the
 * bridge's (a stored bridge:saveWorld task, POST /panel-bridge/world/save).
 * Returns { worldSandboxSnapshot: null } for a world without one, else
 * { worldSandboxSnapshot: { path, refreshed }, error? }.
 *
 * saveWorld is the bridge's handler on purpose: PanelBridge 1.7.72 and
 * older run saveGame() for it unconditionally, and this only sends it for a
 * world that already has the file, so an older bridge refreshes it too. A
 * current bridge refuses saveWorld without the flag. It stays out of
 * POST /command's VALID_ACTIONS.
 */
export async function refreshWorldSandboxSnapshotAfterSave(bridge) {
  const snapshot = await findActiveWorldSandboxSnapshot();
  if (!snapshot) return { worldSandboxSnapshot: null };
  if (!bridge?.isRunning) {
    return {
      worldSandboxSnapshot: { path: snapshot.path, refreshed: false },
      error: "PanelBridge is not running",
    };
  }
  try {
    const result = await bridge.sendCommand("saveWorld", { [WORLD_SANDBOX_SNAPSHOT_ARG]: true });
    // An older bridge answers { message } only, having run saveGame().
    const refreshed = result?.data?.worldSandboxSaved !== false;
    return { worldSandboxSnapshot: { path: snapshot.path, refreshed } };
  } catch (error) {
    return {
      worldSandboxSnapshot: { path: snapshot.path, refreshed: false },
      error: error.message,
    };
  }
}
