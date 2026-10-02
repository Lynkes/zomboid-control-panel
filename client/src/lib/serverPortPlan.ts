import type { EnvironmentDataPath, PortRange, UsedServerPorts } from "@/lib/api";

// Client half of server/services/serverPortPlan.js: the setup wizard checks
// the ports and data folder being typed against every other local server as
// they change, without a request per keystroke. Same rules as the server's
// findPortConflicts(): same-protocol collisions only (game and UDP ports are
// UDP, RCON is TCP), and a profile with the same server name in the same
// install folder is this server, not another one.

export type PortConflictKind = "game" | "udp" | "rcon";

export interface PortConflict {
  kind: PortConflictKind;
  port: number;
  serverName: string;
}

// Loops rather than /x+$/ regexes, which backtrack quadratically on a long
// run of x that isn't at the end (CodeQL js/polynomial-redos).
function trimTrailing(value: string, isTrimmed: (char: string) => boolean, keep = 0): string {
  let end = value.length;
  while (end > keep && isTrimmed(value[end - 1])) end--;
  return value.slice(0, end);
}

const isSeparator = (char: string) => char === "/" || char === "\\";

function normalizePath(value: string): string {
  return trimTrailing(value.trim(), isSeparator).replace(/\\/g, "/").toLowerCase();
}

function isSameServer(entry: UsedServerPorts, serverName: string, installPath: string): boolean {
  return (
    serverName.length > 0 &&
    entry.serverName.toLowerCase() === serverName.toLowerCase() &&
    normalizePath(entry.installPath) === normalizePath(installPath)
  );
}

export function findPortConflicts(
  candidate: { serverPort: number; rconPort: number; serverName: string; installPath: string },
  used: UsedServerPorts[],
): PortConflict[] {
  const conflicts: PortConflict[] = [];
  const gameValid = Number.isInteger(candidate.serverPort);
  const rconValid = Number.isInteger(candidate.rconPort);
  for (const entry of used) {
    if (isSameServer(entry, candidate.serverName, candidate.installPath)) continue;
    const theirUdp = [entry.gamePort, entry.udpPort].filter((p): p is number => p !== null);
    const name = entry.name || entry.serverName;
    if (gameValid) {
      if (theirUdp.includes(candidate.serverPort)) {
        conflicts.push({ kind: "game", port: candidate.serverPort, serverName: name });
      }
      if (theirUdp.includes(candidate.serverPort + 1)) {
        conflicts.push({ kind: "udp", port: candidate.serverPort + 1, serverName: name });
      }
    }
    if (rconValid && entry.rconPort === candidate.rconPort) {
      conflicts.push({ kind: "rcon", port: candidate.rconPort, serverName: name });
    }
  }
  return conflicts;
}

// null when nothing is known about published ports (not the all-in-one
// image): only the all-in-one compose file says which ones Docker maps.
export function isGamePortPublished(gamePort: number, range: PortRange | null | undefined): boolean | null {
  if (!range) return null;
  if (!Number.isInteger(gamePort)) return false;
  return gamePort >= range.start && gamePort + 1 <= range.end;
}

// "myserver" -> "myserver2" (or 3, 4, ...) when another profile already
// uses that name; PZ keys its .ini, world and database by it.
export function uniqueServerName(name: string, used: UsedServerPorts[]): string {
  const taken = new Set(used.map((entry) => entry.serverName.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const base = trimTrailing(name, (char) => char >= "0" && char <= "9") || "server";
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}

// A folder inside a root the server named, with the host's separator
// ("\\" on Windows). A drive or filesystem root keeps one separator.
export function joinHostPath(root: string, name: string, separator: "/" | "\\" = "/"): string {
  return `${trimTrailing(root, isSeparator)}${separator}${name}`;
}

// The data folder POST /install and /quick-setup will use, decided like the
// server's resolveZomboidPaths(): the custom folder, else PZ_SAVE_PATH when
// it applies to this install, else <install>_Data beside it.
export function effectiveDataFolder(
  installPath: string,
  customDataPath: string | null,
  environmentDataPath: EnvironmentDataPath | null | undefined,
): string {
  const custom = customDataPath?.trim();
  if (custom) return custom;
  const install = installPath.trim();
  if (
    environmentDataPath &&
    (environmentDataPath.installPath === null ||
      normalizePath(environmentDataPath.installPath) === normalizePath(install))
  ) {
    return environmentDataPath.dataPath;
  }
  const base = trimTrailing(install, isSeparator);
  return base ? `${base}_Data` : "";
}

export interface DataFolderConflict {
  serverId: string;
  serverName: string;
  path: string;
}

// Other profiles whose data folder is the one this server would use. Two
// servers on one data folder write the same server-console.txt and Logs/,
// so the wizard warns; profiles that never run together may share one on
// purpose, so it doesn't refuse.
export function findDataFolderConflicts(
  candidate: { dataPath: string; serverName: string; installPath: string },
  used: UsedServerPorts[],
): DataFolderConflict[] {
  const wanted = normalizePath(candidate.dataPath);
  if (!wanted) return [];
  return used
    .filter(
      (entry) =>
        entry.dataPath !== null &&
        normalizePath(entry.dataPath) === wanted &&
        !isSameServer(entry, candidate.serverName, candidate.installPath),
    )
    .map((entry) => ({
      serverId: entry.id,
      serverName: entry.name || entry.serverName,
      path: entry.dataPath ?? "",
    }));
}
