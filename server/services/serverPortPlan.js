// Ports and folders for a NEW server profile on a host that already runs
// others, so the setup wizard doesn't start a second server on the first
// one's ports.
//
// A Project Zomboid server binds three ports: DefaultPort (UDP), UDPPort
// (UDP, always DefaultPort + 1 in the scripts and .ini the panel writes) and
// RCONPort (TCP). Two servers that run at the same time can share none of
// them. Profiles that never run together may share ports on purpose (one
// port forward for alternating worlds), so a conflict here is something to
// show, not something to refuse at setup time; serverManager.startServer()
// is what refuses a start while the other server is up.
//
// The all-in-one image (docker/all-in-one) adds two facts only it knows:
// where extra servers can live on a volume (PZ_EXTRA_SERVERS_PATH) and which
// UDP ports Docker publishes (PZ_PUBLISHED_GAME_PORTS, the same range its
// compose file maps). A game port outside that range runs, but players
// can't reach it. Elsewhere, extra servers go beside the active server's
// install folder (suggestHostServersRoot()).
//
// Folders, like ports, must differ between servers that run together: two
// servers on one data folder write the same server-console.txt and Logs/,
// and the panel shows one's console as the other's. Each profile's data
// folder is listed so the wizard can warn when a new server would share one.
import path from "path";

export const DEFAULT_GAME_PORT = 16261;
export const DEFAULT_RCON_PORT = 27015;
const PORT_MIN = 1024;
const PORT_MAX = 65535;

function toPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= PORT_MAX ? port : null;
}

// "16261-16270" or "16261" -> { start, end }; anything else -> null.
export function parsePortRange(text) {
  const match = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$/.exec(String(text ?? ""));
  if (!match) return null;
  const start = toPort(match[1]);
  const end = toPort(match[2] ?? match[1]);
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

export function getAllInOneLayout(env = process.env) {
  if (String(env.PANEL_ALL_IN_ONE || "").toLowerCase() !== "true") return null;
  const serversRoot = String(env.PZ_EXTRA_SERVERS_PATH || "").trim();
  return {
    serversRoot: serversRoot && path.posix.isAbsolute(serversRoot) ? serversRoot : null,
    publishedGamePorts: parsePortRange(env.PZ_PUBLISHED_GAME_PORTS),
  };
}

// PZ_SAVE_PATH is the data folder of an install that names none of its
// own: only the PZ_SERVER_PATH install when that is set too (the all-in-one
// image sets both), otherwise every install (installPath null).
// resolveZomboidPaths() applies it, and the setup plan hands it to the
// wizard so the folder it shows and checks is the one the server will use.
export function getEnvironmentDataPath(env = process.env) {
  const dataPath = String(env.PZ_SAVE_PATH || "");
  if (!dataPath) return null;
  return { installPath: env.PZ_SERVER_PATH || null, dataPath };
}

// The ports and folders each local profile is configured for. Remote
// profiles run on another machine and can't collide with this one. A
// profile with no data folder launches without -cachedir, so the game uses
// its own default, `defaultDataPath` (Zomboid in the home folder).
export function collectUsedPorts(servers, { defaultDataPath = null } = {}) {
  return (Array.isArray(servers) ? servers : [])
    .filter((server) => server && !server.isRemote)
    .map((server) => {
      const gamePort = toPort(server.serverPort ?? DEFAULT_GAME_PORT);
      return {
        id: server.id,
        name: server.name || server.serverName || "",
        serverName: server.serverName || "",
        installPath: server.installPath || server.serverPath || "",
        dataPath: server.zomboidDataPath || defaultDataPath || null,
        gamePort,
        udpPort: gamePort === null ? null : gamePort + 1,
        rconPort: toPort(server.rconPort ?? DEFAULT_RCON_PORT),
      };
    });
}

// Outside the all-in-one image, another server's folders go beside the
// active server's install folder: <parent>/<name> for its game files and
// <parent>/<name>_Data for its data, the pair the wizard made for the first
// server (<install> and <install>_Data). The operator already chose that
// parent once, the first server's default data folder was created in it,
// and the bundled systemd unit allows it when the first install used the
// service path. null when no local profile has an absolute install folder.
// `pathApi` is for tests.
export function suggestHostServersRoot(servers, pathApi = path) {
  const local = (Array.isArray(servers) ? servers : []).filter(
    (server) => server && !server.isRemote,
  );
  const reference = local.find((server) => server.isActive) || local[0];
  const installPath = String(reference?.installPath || reference?.serverPath || "").trim();
  if (!installPath || !pathApi.isAbsolute(installPath)) return null;
  return pathApi.dirname(pathApi.normalize(installPath));
}

// A loop, not /[\\/]+$/: that regex backtracks quadratically on a long run
// of separators that isn't at the end (CodeQL js/polynomial-redos).
function stripTrailingSeparators(value) {
  let end = value.length;
  while (end > 1 && (value[end - 1] === "/" || value[end - 1] === "\\")) end--;
  return value.slice(0, end);
}

function normalizeForCompare(value) {
  const normalized = stripTrailingSeparators(path.normalize(String(value || "")));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// Re-running setup for a server that already has a profile (same name in
// the same install folder) isn't a second server.
function isSameServer(entry, { serverName, installPath }) {
  return (
    Boolean(serverName) &&
    entry.serverName.toLowerCase() === String(serverName).toLowerCase() &&
    normalizeForCompare(entry.installPath) === normalizeForCompare(installPath)
  );
}

// Same-protocol collisions only: the game and UDP ports are UDP, RCON is
// TCP, and a UDP and a TCP socket on the same number don't conflict.
export function findPortConflicts(candidate, used) {
  const gamePort = toPort(candidate?.serverPort);
  const rconPort = toPort(candidate?.rconPort);
  const conflicts = [];
  for (const entry of Array.isArray(used) ? used : []) {
    if (isSameServer(entry, candidate || {})) continue;
    const theirUdp = [entry.gamePort, entry.udpPort].filter((p) => p !== null);
    if (gamePort !== null) {
      if (theirUdp.includes(gamePort)) {
        conflicts.push({ kind: "game", port: gamePort, serverId: entry.id, serverName: entry.name });
      }
      if (theirUdp.includes(gamePort + 1)) {
        conflicts.push({ kind: "udp", port: gamePort + 1, serverId: entry.id, serverName: entry.name });
      }
    }
    if (rconPort !== null && rconPort === entry.rconPort) {
      conflicts.push({ kind: "rcon", port: rconPort, serverId: entry.id, serverName: entry.name });
    }
  }
  return conflicts;
}

export function isGamePortPublished(gamePort, range) {
  if (!range) return null;
  const port = toPort(gamePort);
  if (port === null) return false;
  return port >= range.start && port + 1 <= range.end;
}

// The first free game port pair (port and port + 1) and the first free RCON
// port. Inside the published range when there is one; past it only when
// the range is full, flagged so the wizard can say so.
export function suggestFreePorts(used, { publishedGamePorts = null } = {}) {
  const entries = Array.isArray(used) ? used : [];
  const takenUdp = new Set(entries.flatMap((e) => [e.gamePort, e.udpPort]).filter((p) => p !== null));
  const takenTcp = new Set(entries.map((e) => e.rconPort).filter((p) => p !== null));
  const pairFree = (port) => !takenUdp.has(port) && !takenUdp.has(port + 1);

  let gamePort = null;
  let withinPublishedRange = null;
  if (publishedGamePorts) {
    for (let port = Math.max(publishedGamePorts.start, PORT_MIN); port + 1 <= publishedGamePorts.end; port++) {
      if (pairFree(port)) {
        gamePort = port;
        withinPublishedRange = true;
        break;
      }
    }
  }
  if (gamePort === null) {
    const start = publishedGamePorts ? Math.max(publishedGamePorts.end + 1, PORT_MIN) : DEFAULT_GAME_PORT;
    for (let port = start; port + 1 <= PORT_MAX; port++) {
      if (pairFree(port)) {
        gamePort = port;
        break;
      }
    }
    if (publishedGamePorts) withinPublishedRange = false;
  }

  let rconPort = null;
  for (let port = DEFAULT_RCON_PORT; port <= PORT_MAX; port++) {
    if (!takenTcp.has(port)) {
      rconPort = port;
      break;
    }
  }

  return { gamePort, rconPort, withinPublishedRange };
}
