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
//   1. The install's own ProjectZomboid64.json (its top-level vmArgs'
//      -Djava.library.path), when it is present and sane: every entry a
//      relative folder inside the install (absolute or ".."-escaping entries
//      reject the whole value -- a hostile or corrupt file must not steer
//      what the JVM loads), at least one of them existing, and at least one
//      holding a PZ native library. That is what the build on disk says
//      about itself, so it wins even if it lists natives/.
//   2. Otherwise (Linux) linux64/ first; natives/ and natives/linux64/ only
//      when linux64/ holds no PZ library at all, as a fallback for an older
//      layout.
//   3. Otherwise (Windows) the order the generated .bat has always used,
//      natives/;natives/win64/;. -- the Windows layout keeps its DLLs in the
//      install root, which "." covers.
// The install root "." always ends the list, as it always has.

import crypto from "crypto";
import fs from "fs";
import path from "path";

export const PZ_LAUNCH_CONFIG_FILE = "ProjectZomboid64.json";

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

const LINUX_DEFAULT_DIRS = ["linux64", "."];
const LINUX_FALLBACK_DIRS = ["linux64", "natives", "natives/linux64", "."];
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

// ProjectZomboid64.json text -> { ok: true, dirs } or { ok: false, reason }.
// Only the top-level vmArgs count (the per-OS-version blocks the Windows
// file nests under "windows" only pick a GC); the last
// -Djava.library.path wins, as it does on a java command line. Entries are
// split on ":" and ";" alike -- an absolute entry like "C:\x" splits into
// pieces that are rejected anyway.
export function parseLibraryPathFromLaunchConfig(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  const vmArgs = config && typeof config === "object" ? config.vmArgs : null;
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

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function listPzLibrariesSync(dirPath, platform) {
  try {
    return fs
      .readdirSync(dirPath)
      .filter((name) => isPzNativeLibraryName(name, platform))
      .sort();
  } catch {
    return [];
  }
}

function dirPathIn(installPath, dir) {
  return dir === "." ? installPath : path.join(installPath, ...dir.split("/"));
}

function readLaunchConfigLibraryDirs(installPath, platform) {
  const configPath = path.join(installPath, PZ_LAUNCH_CONFIG_FILE);
  let stat;
  try {
    stat = fs.statSync(configPath);
  } catch {
    return { ok: false, reason: null }; // absent: nothing to report
  }
  if (!stat.isFile() || stat.size > MAX_LAUNCH_CONFIG_BYTES) {
    return { ok: false, reason: `${PZ_LAUNCH_CONFIG_FILE} is not a small regular file` };
  }
  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    return { ok: false, reason: `${PZ_LAUNCH_CONFIG_FILE} is unreadable (${error.code || error.message})` };
  }
  const parsed = parseLibraryPathFromLaunchConfig(text);
  if (!parsed.ok) {
    return { ok: false, reason: `${PZ_LAUNCH_CONFIG_FILE} has ${parsed.reason}` };
  }
  const existing = parsed.dirs.filter((dir) => isDirectory(dirPathIn(installPath, dir)));
  if (existing.length === 0) {
    return { ok: false, reason: `none of the folders ${PZ_LAUNCH_CONFIG_FILE} lists exist` };
  }
  if (!existing.some((dir) => listPzLibrariesSync(dirPathIn(installPath, dir), platform).length > 0)) {
    return { ok: false, reason: `no game library is in the folders ${PZ_LAUNCH_CONFIG_FILE} lists` };
  }
  return { ok: true, dirs: parsed.dirs };
}

/**
 * The native library folders for a launch from `installPath`, relative to
 * it and in search order, always ending with "." (the install root).
 *
 * Returns { dirs, source, rejectedReason }:
 *   source "launchConfig" -- taken from the install's ProjectZomboid64.json
 *   source "linux64"      -- Linux default, linux64/ holds the game's libs
 *   source "fallback"     -- Linux, linux64/ holds none, natives/ allowed
 *   source "windows"      -- the Windows .bat's long-standing order
 * rejectedReason is set when a ProjectZomboid64.json was present but not
 * used, for the caller's log line.
 *
 * Synchronous on purpose: generateStartupScripts() is synchronous and runs
 * this once per script write (a stat, a ~1 KB read and one or two readdirs).
 */
export function resolveNativeLibraryDirs(
  installPath,
  { platform = process.platform } = {},
) {
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

  if (isWindowsPlatform(platform)) {
    return { dirs: [...WINDOWS_DEFAULT_DIRS], source: "windows", rejectedReason };
  }
  const linux64HasLibraries =
    Boolean(installPath) &&
    listPzLibrariesSync(path.join(installPath, "linux64"), platform).length > 0;
  return linux64HasLibraries
    ? { dirs: [...LINUX_DEFAULT_DIRS], source: "linux64", rejectedReason }
    : { dirs: [...LINUX_FALLBACK_DIRS], source: "fallback", rejectedReason };
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

/**
 * A leftover natives/ folder whose game libraries differ from the current
 * linux64/ ones, or null when there's nothing to report: Windows, no game
 * libraries in linux64/ (natives/ is then the legitimate fallback), the
 * game's own ProjectZomboid64.json lists natives/, or every library in it
 * matches linux64/'s copy byte for byte.
 *
 * Differences are judged by size first and only hashed when the sizes
 * match, so a typical check reads no library content at all. Never touches
 * the files beyond reading them.
 *
 * Returns { folder: "natives/", currentFolder: "linux64/", libraries,
 * differing: [{ name, folder, reason: "missingFromCurrent" | "size" |
 * "content", leftoverSize, currentSize, leftoverMtimeMs, currentMtimeMs }] }.
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
  if (LEGACY_LINUX_DIRS.some((dir) => dirs.includes(dir))) return null;

  const differing = [];
  for (const legacyDir of LEGACY_LINUX_DIRS) {
    const leftoverDir = path.join(installPath, ...legacyDir.split("/"));
    for (const name of await listPzLibraries(leftoverDir, platform)) {
      const leftoverStat = await statFile(path.join(leftoverDir, name));
      if (!leftoverStat) continue;
      const currentStat = currentLibraries.includes(name)
        ? await statFile(path.join(currentDir, name))
        : null;
      let reason = null;
      if (!currentStat) {
        reason = "missingFromCurrent";
      } else if (currentStat.size !== leftoverStat.size) {
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
      if (reason) {
        differing.push({
          name,
          folder: `${legacyDir}/`,
          reason,
          leftoverSize: leftoverStat.size,
          currentSize: currentStat ? currentStat.size : null,
          leftoverMtimeMs: leftoverStat.mtimeMs,
          currentMtimeMs: currentStat ? currentStat.mtimeMs : null,
        });
      }
    }
  }
  if (differing.length === 0) return null;
  return {
    folder: "natives/",
    currentFolder: "linux64/",
    libraries: [...new Set(differing.map((entry) => entry.name))].sort(),
    differing,
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
// folder (see detectLeftoverNativeLibraries()).
export function describeLeftoverNativeLibraries(installPath, leftover) {
  return (
    `Leftover native libraries from an older game build in ${path.join(installPath, "natives")}: ` +
    `${leftover.libraries.join(", ")} differ from the copies in linux64/. ` +
    "The panel's start script loads linux64/, but a custom start script or command that puts natives/ " +
    "first loads the old ones, and the game then crashes during world saves (UnsatisfiedLinkError). " +
    "It is safe to remove or rename the natives/ folder (for example to natives.old) while the server is stopped; " +
    "the panel never deletes it."
  );
}
