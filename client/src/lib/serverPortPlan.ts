import type { EnvironmentDataPath, PortRange, ServerSetupPlan, UsedServerPorts } from "@/lib/api";

// Client half of server/services/serverPortPlan.js: the setup wizard checks
// the ports and data folder being typed against every other local server as
// they change, without a request per keystroke. Same rules as the server's
// findPortConflicts(): same-protocol collisions only (game and UDP ports are
// UDP, RCON is TCP), and a profile with the same server name in the same
// install folder is this server, not another one. Paths compare like the
// server's isSameDirectory(): without case on a Windows host only
// (`ignoreCase`, from hostIgnoresCase()).

export type PortConflictKind = "game" | "udp" | "rcon";

export interface PortConflict {
  kind: PortConflictKind;
  port: number;
  serverName: string;
}

// GET /server/setup-plan's answer, or false for anything else, such as the
// demo build's catch-all reply: the wizard then sets up a first server.
export function isServerSetupPlan(value: unknown): value is ServerSetupPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<ServerSetupPlan>;
  return Array.isArray(plan.usedPorts) && !!plan.suggestedPorts && typeof plan.suggestedPorts === "object";
}

// Windows compares paths without case; Linux, including the all-in-one
// image (no hostLayout), doesn't. Only a Windows host's separator is "\\".
export function hostIgnoresCase(plan: ServerSetupPlan | null | undefined): boolean {
  return plan?.hostLayout?.separator === "\\";
}

// Loops rather than /x+$/ regexes, which backtrack quadratically on a long
// run of x that isn't at the end (CodeQL js/polynomial-redos).
function trimTrailing(value: string, isTrimmed: (char: string) => boolean, keep = 0): string {
  let end = value.length;
  while (end > keep && isTrimmed(value[end - 1])) end--;
  return value.slice(0, end);
}

const isSeparator = (char: string) => char === "/" || char === "\\";

// Keeps a filesystem root's "/", like the server's stripTrailingSeparators().
function normalizePath(value: string, ignoreCase: boolean): string {
  const normalized = trimTrailing(value.trim(), isSeparator, 1).replace(/\\/g, "/");
  return ignoreCase ? normalized.toLowerCase() : normalized;
}

function isSameServer(entry: UsedServerPorts, serverName: string, installPath: string, ignoreCase: boolean): boolean {
  return (
    serverName.length > 0 &&
    entry.serverName.toLowerCase() === serverName.toLowerCase() &&
    normalizePath(entry.installPath, ignoreCase) === normalizePath(installPath, ignoreCase)
  );
}

export function findPortConflicts(
  candidate: { serverPort: number; rconPort: number; serverName: string; installPath: string },
  used: UsedServerPorts[],
  ignoreCase = false,
): PortConflict[] {
  const conflicts: PortConflict[] = [];
  const gameValid = Number.isInteger(candidate.serverPort);
  const rconValid = Number.isInteger(candidate.rconPort);
  for (const entry of used) {
    if (isSameServer(entry, candidate.serverName, candidate.installPath, ignoreCase)) continue;
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

// The folder another server's folders go in (the extra-servers volume in
// the all-in-one image, the active install's parent elsewhere), the names
// already in it, and how its host compares paths.
export interface ServersRoot {
  path: string;
  separator: "/" | "\\";
  entries: string[];
  ignoreCase: boolean;
}

export function serversRootOf(plan: ServerSetupPlan | null | undefined): ServersRoot | null {
  if (!plan) return null;
  const root = plan.allInOne ? plan.allInOne.serversRoot : (plan.hostLayout?.serversRoot ?? null);
  if (!root) return null;
  return {
    path: root,
    separator: plan.hostLayout?.separator ?? "/",
    entries: Array.isArray(plan.serversRootEntries) ? plan.serversRootEntries : [],
    ignoreCase: hostIgnoresCase(plan),
  };
}

// Whether a profile already names this folder as its install or data
// folder, which it may not have created yet.
function isProfileFolder(folder: string, used: UsedServerPorts[], ignoreCase: boolean): boolean {
  const wanted = normalizePath(folder, ignoreCase);
  return used.some(
    (entry) =>
      normalizePath(entry.installPath, ignoreCase) === wanted ||
      (entry.dataPath !== null && normalizePath(entry.dataPath, ignoreCase) === wanted),
  );
}

function isRootEntry(name: string, root: ServersRoot): boolean {
  const wanted = root.ignoreCase ? name.toLowerCase() : name;
  return root.entries.some((entry) => (root.ignoreCase ? entry.toLowerCase() : entry) === wanted);
}

// "myserver" -> "myserver2" (or 3, 4, ...) when another profile already
// uses that name; PZ keys its .ini, world and database by it. With a root,
// also when <root>/<name> or <root>/<name>_Data, the folders the wizard
// proposes for it, is already there or another profile's: a leftover one
// would hand the new server an old world, another profile's would be
// shared.
export function uniqueServerName(name: string, used: UsedServerPorts[], root: ServersRoot | null = null): string {
  const taken = new Set(used.map((entry) => entry.serverName.toLowerCase()));
  const folderFree = (folder: string) =>
    !root ||
    (!isRootEntry(folder, root) &&
      !isProfileFolder(joinHostPath(root.path, folder, root.separator), used, root.ignoreCase));
  const isFree = (candidate: string) =>
    !taken.has(candidate.toLowerCase()) && folderFree(candidate) && folderFree(`${candidate}_Data`);
  if (isFree(name)) return name;
  const base = trimTrailing(name, (char) => char >= "0" && char <= "9") || "server";
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}${n}`;
    if (isFree(candidate)) return candidate;
  }
  return name;
}

// A folder inside a root the server named, with the host's separator
// ("\\" on Windows). A drive or filesystem root keeps one separator.
export function joinHostPath(root: string, name: string, separator: "/" | "\\" = "/"): string {
  return `${trimTrailing(root, isSeparator)}${separator}${name}`;
}

// A folder directly in the root that is already there but no profile's:
// most likely left by a deleted server, whose settings and world a new
// server using it would take over.
export function isLeftoverFolder(folder: string, root: ServersRoot | null, used: UsedServerPorts[]): boolean {
  if (!root || !folder.trim()) return false;
  const wanted = normalizePath(folder, root.ignoreCase);
  const inRoot = root.entries.some(
    (entry) => normalizePath(joinHostPath(root.path, entry, root.separator), root.ignoreCase) === wanted,
  );
  return inRoot && !isProfileFolder(folder, used, root.ignoreCase);
}

// The data folder POST /install and /quick-setup will use, decided like the
// server's resolveZomboidPaths(): the custom folder, else PZ_SAVE_PATH when
// it applies to this install, else <install>_Data beside it (C:\_Data or
// /_Data for a drive or filesystem root, like the server's path.join()).
export function effectiveDataFolder(
  installPath: string,
  customDataPath: string | null,
  environmentDataPath: EnvironmentDataPath | null | undefined,
  ignoreCase = false,
): string {
  const custom = customDataPath?.trim();
  if (custom) return custom;
  const install = installPath.trim();
  if (
    environmentDataPath &&
    (environmentDataPath.installPath === null ||
      normalizePath(environmentDataPath.installPath, ignoreCase) === normalizePath(install, ignoreCase))
  ) {
    return environmentDataPath.dataPath;
  }
  if (!install) return "";
  const base = trimTrailing(install, isSeparator);
  if (!base || /^[A-Za-z]:$/.test(base)) return `${install.slice(0, base.length + 1)}_Data`;
  return `${base}_Data`;
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
  ignoreCase = false,
): DataFolderConflict[] {
  const wanted = normalizePath(candidate.dataPath, ignoreCase);
  if (!wanted) return [];
  return used
    .filter(
      (entry) =>
        entry.dataPath !== null &&
        normalizePath(entry.dataPath, ignoreCase) === wanted &&
        !isSameServer(entry, candidate.serverName, candidate.installPath, ignoreCase),
    )
    .map((entry) => ({
      serverId: entry.id,
      serverName: entry.name || entry.serverName,
      path: entry.dataPath ?? "",
    }));
}
