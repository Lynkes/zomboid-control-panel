// Where Project Zomboid's native libraries (libPZPopMan64.so,
// libPZPathFind64.so, RakNet, ZNet, ...) are loaded from, for every launch
// the panel performs or writes a script for.
//
// 2026-10-01 incident (Unraid all-in-one, Build 42.21): every session ended
// in `UnsatisfiedLinkError: ZombiePopulationManager.n_updateRealZombies`
// during a world save, which killed the game's main thread while the JVM
// stayed up (RCON dropping, "running (phase: unresponsive)"). The install
// had a leftover natives/ folder from an older build (libPZPopMan64.so from
// 2026-07-22, without that JNI symbol) next to the current linux64/ one, and
// the generated start-server_<name>.sh put natives/ FIRST on both
// -Djava.library.path and LD_LIBRARY_PATH -- so the JVM loaded the stale
// copy. The game's own files never did that: the 42.21 start-server.sh
// exports LD_LIBRARY_PATH="${INSTDIR}/linux64:${INSTDIR}:..." and
// ProjectZomboid64.json passes -Djava.library.path=linux64/. SteamCMD does
// not remove a folder a newer build stopped shipping, so any Linux install
// old enough to have one has the same trap.
//
// Rule, in order:
//   1. Windows: natives/;natives/win64/;. -- the order the generated .bat
//      has always used, and the one the game's own ProjectZomboidServer.bat
//      uses (./natives/;./natives/win64/;./). The Windows
//      ProjectZomboid64.json is the CLIENT's launch config (mainClass
//      zombie/gameStates/MainScreenState, -Djava.library.path=win64/;.), so
//      it never decides the server's path. Windows was not part of the
//      incident.
//   2. Linux: the install's own ProjectZomboid64.json (its top-level vmArgs'
//      -Djava.library.path), when it is the dedicated server's (mainClass
//      zombie/network/GameServer, or none) and sane: every entry a relative
//      folder inside the install (absolute or ".."-escaping entries reject
//      the whole value -- a hostile or corrupt file must not steer what the
//      JVM loads), at least one of them existing, and at least one holding a
//      PZ native library. That is what the build on disk says about itself,
//      so it wins even if it lists natives/ -- detectLeftoverNativeLibraries()
//      below warns when that loads older copies.
//   3. Otherwise (Linux) linux64/ first, then natives/ and natives/linux64/
//      behind it -- the order the vanilla start-server.sh used when it named
//      both (linux64:natives). The JVM and ld.so load a library from the
//      first folder that has it, so a leftover natives/ copy never shadows
//      linux64/'s, while a library only an older layout keeps in natives/ is
//      still found, as it was before.
// The install root "." always ends the list, as it always has.

import crypto from "crypto";
import fs from "fs";
import path from "path";

export const PZ_LAUNCH_CONFIG_FILE = "ProjectZomboid64.json";

// The dedicated server's main class. A ProjectZomboid64.json naming another
// one (the client's zombie/gameStates/MainScreenState) describes a different
// program, not the server the panel launches.
const SERVER_MAIN_CLASS = "zombie/network/GameServer";

// A launch config bigger than this is not the game's ~1 KB file.
const MAX_LAUNCH_CONFIG_BYTES = 256 * 1024;
// More entries than this is not a library path the game ships.
const MAX_LIBRARY_DIRS = 8;
// One folder entry, after normalization: plain segments only, so it can be
// written into a double-quoted shell string and a .bat line unescaped.
const SAFE_DIR_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

// The game's own native libraries -- not libsteam_api.so or the JRE's.
const PZ_LINUX_LIBRARY_RE = /^lib(?:PZ[A-Za-z0-9]+|RakNet|ZNet[A-Za-z0-9]+|Lighting)64\.so$/;
const PZ_WINDOWS_LIBRARY_RE = /^(?:PZ[A-Za-z0-9]+|RakNet|ZNet[A-Za-z0-9]+|Lighting)64\.dll$/i;

const LINUX_DEFAULT_DIRS = ["linux64", "natives", "natives/linux64", "."];
const WINDOWS_DEFAULT_DIRS = ["natives", "natives/win64", "."];

// Folders an older build kept its Linux libraries in.
const LEGACY_LINUX_DIRS = ["natives", "natives/linux64"];

function isWindowsPlatform(platform) {
  return platform === "win32";
}

export function isPzNativeLibraryName(name, platform = process.platform) {
  return isWindowsPlatform(platform)
    ? PZ_WINDOWS_LIBRARY_RE.test(name)
    : PZ_LINUX_LIBRARY_RE.test(name);
}

// One -Djava.library.path entry -> a relative folder ("linux64",
// "natives/win64", "." for the install root), or null when it isn't a plain
// folder inside the install.
export function normalizeLibraryDirEntry(entry) {
  if (typeof entry !== "string") return null;
  let value = entry.trim().replace(/\\/g, "/");
  if (!value || value === "." || value === "./") return ".";
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return null;
  while (value.startsWith("./")) value = value.slice(2);
  value = value.replace(/\/+$/, "");
  if (!value || value === ".") return ".";
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "." || segment === ".." || !SAFE_DIR_SEGMENT_RE.test(segment),
    )
  ) {
    return null;
  }
  return segments.join("/");
}

// ProjectZomboid64.json text -> { ok: true, dirs } or { ok: false, reason }
// (plus notServerConfig: true when the file is another program's -- the
// client's -- which is nothing to report). Only the top-level vmArgs count
// (the per-OS-version blocks the Windows file nests under "windows" only
// pick a GC); the last -Djava.library.path wins, as it does on a java
// command line. Entries are split on ":" and ";" alike -- an absolute entry
// like "C:\x" splits into pieces that are rejected anyway.
export function parseLibraryPathFromLaunchConfig(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!config || typeof config !== "object") {
    return { ok: false, reason: "no vmArgs list" };
  }
  if (config.mainClass !== undefined) {
    const mainClass =
      typeof config.mainClass === "string" ? config.mainClass.trim().replace(/\./g, "/") : "";
    if (mainClass !== SERVER_MAIN_CLASS) {
      return {
        ok: false,
        reason: "another program's launch settings (not the dedicated server's)",
        notServerConfig: true,
      };
    }
  }
  const vmArgs = config.vmArgs;
  if (!Array.isArray(vmArgs)) return { ok: false, reason: "no vmArgs list" };
  const prefix = "-Djava.library.path=";
  const arg = vmArgs
    .filter((value) => typeof value === "string" && value.startsWith(prefix))
    .pop();
  if (!arg) return { ok: false, reason: "no -Djava.library.path in vmArgs" };
  const rawEntries = arg
    .slice(prefix.length)
    .split(/[:;]/)
    .filter((entry) => entry.trim() !== "");
  if (rawEntries.length === 0) {
    return { ok: false, reason: "an empty -Djava.library.path" };
  }
  if (rawEntries.length > MAX_LIBRARY_DIRS) {
    return { ok: false, reason: "too many -Djava.library.path entries" };
  }
  const dirs = [];
  for (const raw of rawEntries) {
    const dir = normalizeLibraryDirEntry(raw);
    if (!dir) {
      return {
        ok: false,
        reason: `a -Djava.library.path entry outside the install (${JSON.stringify(raw.trim()).slice(0, 80)})`,
      };
    }
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return { ok: true, dirs };
}

// The game's native libraries in `dirPath`, or null when there is no folder
// there (missing, or a file). One readdir answers both "does it exist" and
// "what does it hold", so nothing is stat'ed first and listed later; a
// folder that exists but can't be listed counts as holding none.
function listPzLibrariesSync(dirPath, platform) {
  try {
    // codeql[js/path-injection] dirPath is the server profile's install folder (installPath from routes/server.js POST /install and POST /quick-setup, both requirePermission("server.install") and isValidPath(): absolute, no "..") or a folder inside it named by that install's own ProjectZomboid64.json after normalizeLibraryDirEntry() (plain [A-Za-z0-9._-] segments only: no "..", ".", absolute or drive-letter entries). It is only listed, and only names matching the game's library pattern are kept.
    const names = fs.readdirSync(dirPath);
    return names.filter((name) => isPzNativeLibraryName(name, platform)).sort();
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? null : [];
  }
}

function dirPathIn(installPath, dir) {
  return dir === "." ? installPath : path.join(installPath, ...dir.split("/"));
}

// O_NONBLOCK: a FIFO (or another special file) named ProjectZomboid64.json
// must not hang this synchronous open until something writes to it; fstat
// then refuses it. Windows has no such flag, and no such files.
const LAUNCH_CONFIG_OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);

// The install's ProjectZomboid64.json text -> { text } or { text: null,
// reason } (reason null when there is no file: nothing to report). Checked
// and read through one descriptor, so the file that passes the "small
// regular file" check is the one read, and never more than the cap of it.
function readLaunchConfigText(installPath) {
  const notSmallFile = `${PZ_LAUNCH_CONFIG_FILE} is not a small regular file`;
  const configPath = path.join(installPath, PZ_LAUNCH_CONFIG_FILE);
  let fd;
  try {
    // codeql[js/path-injection] configPath is the server profile's install folder (installPath from routes/server.js POST /install and POST /quick-setup, both requirePermission("server.install") and isValidPath(): absolute, no "..") joined with the constant name ProjectZomboid64.json -- the game's own launch settings, opened read-only and non-blocking, fstat'ed through this descriptor and read up to MAX_LAUNCH_CONFIG_BYTES only to parse its -Djava.library.path.
    fd = fs.openSync(configPath, LAUNCH_CONFIG_OPEN_FLAGS);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { text: null, reason: null };
    if (error.code === "EISDIR") return { text: null, reason: notSmallFile };
    return { text: null, reason: `${PZ_LAUNCH_CONFIG_FILE} is unreadable (${error.code || error.message})` };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_LAUNCH_CONFIG_BYTES) return { text: null, reason: notSmallFile };
    // One byte past the cap tells a file that grew since fstat from one
    // that fits.
    const buffer = Buffer.alloc(MAX_LAUNCH_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_LAUNCH_CONFIG_BYTES) return { text: null, reason: notSmallFile };
    return { text: buffer.toString("utf8", 0, length), reason: null };
  } catch (error) {
    return { text: null, reason: `${PZ_LAUNCH_CONFIG_FILE} is unreadable (${error.code || error.message})` };
  } finally {
    fs.closeSync(fd);
  }
}

function readLaunchConfigLibraryDirs(installPath, platform) {
  const { text, reason } = readLaunchConfigText(installPath);
  if (text === null) return { ok: false, reason };
  const parsed = parseLibraryPathFromLaunchConfig(text);
  if (!parsed.ok) {
    // Another program's file (a client install's) isn't the server's to
    // follow, nor a problem worth a warning on every start.
    if (parsed.notServerConfig) return { ok: false, reason: null };
    return { ok: false, reason: `${PZ_LAUNCH_CONFIG_FILE} has ${parsed.reason}` };
  }
  const listings = parsed.dirs
    .map((dir) => listPzLibrariesSync(dirPathIn(installPath, dir), platform))
    .filter((libraries) => libraries !== null);
  if (listings.length === 0) {
    return { ok: false, reason: `none of the folders ${PZ_LAUNCH_CONFIG_FILE} lists exist` };
  }
  if (!listings.some((libraries) => libraries.length > 0)) {
    return { ok: false, reason: `no game library is in the folders ${PZ_LAUNCH_CONFIG_FILE} lists` };
  }
  return { ok: true, dirs: parsed.dirs };
}

/**
 * The native library folders for a launch from `installPath`, relative to
 * it and in search order, always ending with "." (the install root).
 *
 * Returns { dirs, source, rejectedReason }:
 *   source "launchConfig" -- Linux, taken from the install's own
 *                            ProjectZomboid64.json (the server's)
 *   source "default"      -- Linux, linux64/ first, natives/ behind it
 *   source "windows"      -- the Windows .bat's long-standing order
 * rejectedReason is set when a server ProjectZomboid64.json was present but
 * not used, for the caller's log line.
 *
 * Synchronous on purpose: generateStartupScripts() is synchronous and runs
 * this once per script write (an open, a ~1 KB read and one or two readdirs).
 */
export function resolveNativeLibraryDirs(
  installPath,
  { platform = process.platform } = {},
) {
  if (isWindowsPlatform(platform)) {
    return { dirs: [...WINDOWS_DEFAULT_DIRS], source: "windows", rejectedReason: null };
  }
  let rejectedReason = null;
  if (installPath) {
    const fromConfig = readLaunchConfigLibraryDirs(installPath, platform);
    if (fromConfig.ok) {
      const dirs = fromConfig.dirs.includes(".")
        ? fromConfig.dirs
        : [...fromConfig.dirs, "."];
      return { dirs, source: "launchConfig", rejectedReason: null };
    }
    rejectedReason = fromConfig.reason;
  }
  return { dirs: [...LINUX_DEFAULT_DIRS], source: "default", rejectedReason };
}

// -Djava.library.path value for a generated script, relative to the folder
// the script cd's into: "linux64/:." on Linux, "natives/;natives/win64/;."
// on Windows.
export function formatJavaLibraryPath(dirs, platform = process.platform) {
  const separator = isWindowsPlatform(platform) ? ";" : ":";
  return dirs.map((dir) => (dir === "." ? "." : `${dir}/`)).join(separator);
}

// The library folders as ${INSTDIR}-relative entries for the generated
// script's LD_LIBRARY_PATH -- the install root itself is added separately,
// right after them, as it always was.
export function formatShellLibraryDirs(dirs) {
  return dirs
    .filter((dir) => dir !== ".")
    .map((dir) => `\${INSTDIR}/${dir}/`);
}

// Absolute LD_LIBRARY_PATH candidates, in order, for a spawn from
// `serverDir` (serverManager.buildLdLibraryPath filters out the missing
// ones): the same native folders as the generated script, then the install
// root and the bundled JRE's library folders.
export function buildLinuxLdLibraryCandidates(serverDir) {
  const { dirs } = resolveNativeLibraryDirs(serverDir, { platform: "linux" });
  return [
    ...dirs.filter((dir) => dir !== ".").map((dir) => dirPathIn(serverDir, dir)),
    serverDir,
    path.join(serverDir, "jre64", "lib", "amd64"),
    path.join(serverDir, "jre64", "lib", "x86_64"), // CentOS uses x86_64 instead of amd64
    "/usr/lib64", // CentOS system 64-bit libs
  ];
}

async function listPzLibraries(dirPath, platform) {
  try {
    const names = await fs.promises.readdir(dirPath);
    return names.filter((name) => isPzNativeLibraryName(name, platform)).sort();
  } catch {
    return [];
  }
}

async function statFile(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

async function hashFile(filePath) {
  return new Promise((resolve) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => resolve(null));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// The folders, in search order, that hold at least one of the game's native
// libraries -- what a launch with resolveNativeLibraryDirs()'s order
// actually loads from ("linux64/", "natives/", "./" for the install root).
export async function listLoadedNativeLibraryFolders(
  installPath,
  { platform = process.platform } = {},
) {
  if (!installPath) return [];
  const { dirs } = resolveNativeLibraryDirs(installPath, { platform });
  const folders = [];
  for (const dir of dirs) {
    if ((await listPzLibraries(dirPathIn(installPath, dir), platform)).length > 0) {
      folders.push(dir === "." ? "./" : `${dir}/`);
    }
  }
  return folders;
}

/**
 * A leftover natives/ folder whose game libraries differ from the current
 * linux64/ ones, or null when there's nothing to report: Windows, no game
 * libraries in linux64/ (natives/ is then the real one), every copy in it
 * matches linux64/'s byte for byte, or the search order puts natives/ first
 * and its copies are the NEWER ones (linux64/ is then the leftover, and it
 * never loads).
 *
 * Two findings, told apart by `loadsLeftoverFirst`:
 *   false -- the search order (the panel's own script) loads linux64/ first,
 *            so only a launcher that puts natives/ first loads the old
 *            copies. `libraries` are the copies that differ from
 *            linux64/'s; `onlyInLeftover` the libraries natives/ holds that
 *            linux64/ has no copy of at all -- not "copies that differ", and
 *            the reason removing natives/ isn't called safe when there are
 *            any (the server may still need them).
 *   true  -- the search order itself (a ProjectZomboid64.json listing
 *            natives/ before linux64/, or without it) loads natives/'s
 *            copies, and they are older than linux64/'s: the incident,
 *            reproduced by the game's own file. `libraries` are those.
 *
 * Differences are judged by size first and only hashed when the sizes
 * match, so a typical check reads no library content at all; "older" is the
 * file's modification time (SteamCMD writes each file when it downloads
 * it). Never touches the files beyond reading them.
 *
 * Returns { folder: "natives/", currentFolder: "linux64/",
 * loadsLeftoverFirst, libraries, onlyInLeftover, differing: [{ name,
 * folder, reason: "size" | "content", leftoverSize, currentSize,
 * leftoverMtimeMs, currentMtimeMs }] }.
 */
export async function detectLeftoverNativeLibraries(
  installPath,
  { platform = process.platform } = {},
) {
  if (!installPath || isWindowsPlatform(platform)) return null;
  const currentDir = path.join(installPath, "linux64");
  const currentLibraries = await listPzLibraries(currentDir, platform);
  if (currentLibraries.length === 0) return null;

  const { dirs } = resolveNativeLibraryDirs(installPath, { platform });
  const searchOrder = (dir) => {
    const index = dirs.indexOf(dir);
    return index < 0 ? Infinity : index;
  };
  const currentOrder = searchOrder("linux64");

  // Every leftover copy of a library linux64/ also has, identical or not.
  const copies = [];
  const onlyInLeftover = new Set();
  for (const legacyDir of LEGACY_LINUX_DIRS) {
    const leftoverDir = path.join(installPath, ...legacyDir.split("/"));
    for (const name of await listPzLibraries(leftoverDir, platform)) {
      if (!currentLibraries.includes(name)) {
        onlyInLeftover.add(name);
        continue;
      }
      const [leftoverStat, currentStat] = await Promise.all([
        statFile(path.join(leftoverDir, name)),
        statFile(path.join(currentDir, name)),
      ]);
      if (!leftoverStat || !currentStat) continue;
      let reason = null;
      if (currentStat.size !== leftoverStat.size) {
        reason = "size";
      } else {
        const [leftoverHash, currentHash] = await Promise.all([
          hashFile(path.join(leftoverDir, name)),
          hashFile(path.join(currentDir, name)),
        ]);
        if (leftoverHash && currentHash && leftoverHash !== currentHash) {
          reason = "content";
        }
      }
      copies.push({
        name,
        dir: legacyDir,
        reason,
        leftoverSize: leftoverStat.size,
        currentSize: currentStat.size,
        leftoverMtimeMs: leftoverStat.mtimeMs,
        currentMtimeMs: currentStat.mtimeMs,
      });
    }
  }
  const differing = copies.filter((copy) => copy.reason);
  if (differing.length === 0) return null;
  const uniqueNames = (list) => [...new Set(list.map((copy) => copy.name))].sort();
  const aheadOfCurrent = (dir) => searchOrder(dir) < currentOrder;

  // Which copy of each library a launch with this order loads: the first
  // leftover folder ahead of linux64/ that holds it, if any.
  const loadedOlder = [];
  for (const name of uniqueNames(differing)) {
    const loaded = copies
      .filter((copy) => copy.name === name && aheadOfCurrent(copy.dir))
      .sort((a, b) => searchOrder(a.dir) - searchOrder(b.dir))[0];
    if (loaded?.reason && loaded.leftoverMtimeMs < loaded.currentMtimeMs) {
      loadedOlder.push(name);
    }
  }
  // Otherwise only the differing copies this order never reaches first are
  // a trap (for a launcher that puts natives/ first). A newer copy ahead of
  // linux64/ is the current one, and nothing to warn about.
  const behind = differing.filter((copy) => !aheadOfCurrent(copy.dir));
  if (loadedOlder.length === 0 && behind.length === 0) return null;

  return {
    folder: "natives/",
    currentFolder: "linux64/",
    loadsLeftoverFirst: loadedOlder.length > 0,
    libraries: loadedOlder.length > 0 ? loadedOlder : uniqueNames(behind),
    onlyInLeftover: [...onlyInLeftover].sort(),
    differing: differing.map(({ dir, ...copy }) => ({ ...copy, folder: `${dir}/` })),
  };
}

// The game folder whose native libraries a launch of `server` loads: its
// serverPath/installPath folder, or the folder a custom launcher script
// (a serverPath or installPath naming the .sh/.bat itself) sits in.
export function resolveGameDirForNativeCheck(server) {
  const isLauncherFile = (value) => /\.(bat|cmd|sh|exe)$/i.test(value);
  const candidates = [server?.serverPath, server?.installPath].filter(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  const folder = candidates.find((value) => !isLauncherFile(value));
  if (folder) return folder;
  return candidates.length > 0 ? path.dirname(candidates[0]) : null;
}

// The panel-log line for a launch from an install with a leftover natives/
// folder (see detectLeftoverNativeLibraries()). `panelScript`: this launch
// runs the start script the panel just wrote (linux64/ first), rather than
// a launcher of the operator's or a Docker image's own, whose order the
// panel can't see.
export function describeLeftoverNativeLibraries(
  installPath,
  leftover,
  { panelScript = false } = {},
) {
  const nativesDir = path.join(installPath, "natives");
  const libraries = leftover.libraries.join(", ");
  if (leftover.loadsLeftoverFirst) {
    return (
      `Leftover native libraries from an older game build in ${nativesDir} load before the current ones: ` +
      `${PZ_LAUNCH_CONFIG_FILE} puts natives/ before linux64/, so the game loads older copies of ${libraries} ` +
      "and can crash during world saves (UnsatisfiedLinkError). Rename the natives/ folder (for example to natives.old) " +
      "while the server is stopped, or verify the game files with SteamCMD; the panel never deletes it."
    );
  }
  const onlyInLeftover = leftover.onlyInLeftover || [];
  return (
    `Leftover native libraries from an older game build in ${nativesDir}: ` +
    `${libraries} differ from the copies in linux64/.` +
    (onlyInLeftover.length > 0
      ? ` It also holds ${onlyInLeftover.join(", ")}, which linux64/ doesn't have.`
      : "") +
    (panelScript
      ? " The panel's start script loads linux64/ first, but a custom start script or command that puts natives/ first loads the old ones"
      : " This server starts with its own launcher, not the panel's start script; if that puts natives/ first, it loads the old ones") +
    ", and the game then crashes during world saves (UnsatisfiedLinkError). " +
    (onlyInLeftover.length > 0
      ? "Verify the game files with SteamCMD before you remove natives/: the server may still need the libraries only it holds. " +
        "Renaming it (for example to natives.old) while the server is stopped can be undone; the panel never deletes it."
      : "It is safe to remove or rename the natives/ folder (for example to natives.old) while the server is stopped; " +
        "the panel never deletes it.")
  );
}
