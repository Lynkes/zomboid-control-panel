// Shared scaffolding for the Server Files (file manager) tests: a real temp
// folder tree shaped like a Project Zomboid server (game install, Zomboid
// data folder with Server/, Saves/, db/, backups/ and the bridge folder),
// the matching server profile, and small helpers for links that work on
// every OS this suite runs on (Windows only allows junctions without
// Developer Mode, so folder links use junctions there and file links are
// skipped when the OS refuses them).
import fs from "fs";
import os from "os";
import path from "path";

export const IS_WIN = process.platform === "win32";

/** A fresh temp folder, realpath'd (macOS /var -> /private/var, Windows 8.3). */
export function makeTempDir(prefix = "zcp-fm-") {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function removeDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* best effort */
  }
}

export function write(file, content = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

export function read(file) {
  return fs.readFileSync(file, "utf8");
}

let fileSymlinkSupport = null;
/** Whether this OS account may create file symlinks (Windows needs Developer Mode). */
export function canSymlinkFiles() {
  if (fileSymlinkSupport !== null) return fileSymlinkSupport;
  const dir = makeTempDir("zcp-fm-probe-");
  try {
    fs.writeFileSync(path.join(dir, "t"), "x");
    fs.symlinkSync(path.join(dir, "t"), path.join(dir, "l"), "file");
    fileSymlinkSupport = true;
  } catch {
    fileSymlinkSupport = false;
  } finally {
    removeDir(dir);
  }
  return fileSymlinkSupport;
}

/** A folder link: a junction on Windows (no privilege needed), a symlink elsewhere. */
export function linkDir(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, IS_WIN ? "junction" : "dir");
}

export function linkFile(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, "file");
}

/**
 * A server-shaped tree under `base` and its profile.
 * @returns {{ base: string, install: string, data: string, config: string, outside: string, profile: object }}
 */
export function makeServerTree(base, { serverName = "servertest", id = "p1", active = true } = {}) {
  const install = path.join(base, "install");
  const data = path.join(base, "Zomboid");
  const config = path.join(data, "Server");
  const outside = path.join(base, "outside");
  write(path.join(install, "ProjectZomboid64.json"), "{}\n");
  write(path.join(install, "start-server.sh"), "#!/bin/sh\necho start\n");
  write(path.join(install, "media", "lua", "shared", "game.lua"), "-- game\n");
  write(path.join(config, `${serverName}.ini`), "PVP=true\r\nRCONPassword=hunter2secret\r\nPassword=\r\n");
  write(path.join(config, `${serverName}_SandboxVars.lua`), "SandboxVars = {}\n");
  write(path.join(data, "Saves", "Multiplayer", serverName, "map_0_0.bin"), "world");
  write(path.join(data, "db", `${serverName}.db`), "players");
  write(path.join(data, "backups", "world-1.zip"), "zip");
  write(path.join(data, "Lua", "panelbridge", serverName, "status.json"), "{}");
  write(path.join(data, "Logs", "server.txt"), "log line\n");
  write(path.join(outside, "canary.txt"), "CANARY-OUTSIDE-ROOT");
  const profile = {
    id,
    name: "Main",
    serverName,
    installPath: install,
    serverPath: "",
    zomboidDataPath: data,
    serverConfigPath: config,
    isActive: active,
    isRemote: false,
    lifecycleProvider: "direct",
  };
  return { base, install, data, config, outside, profile };
}

/** A minimal Express app stand-in for services that call app.get(). */
export function fakeApp({ running = false, scanFailed = false } = {}) {
  const services = {
    serverManager: {
      getServerProcessDetails: async () => ({ running, scanFailed, matched: [], owned: [] }),
    },
    dockerClient: null,
  };
  return { get: (key) => services[key], services };
}
