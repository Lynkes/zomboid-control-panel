// What the panel reports about the leaderboard outside the page: the
// support bundle's leaderboard-diagnostics.json, and the throttled warning
// when a leaderboard read fails. The page's "Copy diagnostics" button builds
// the same JSON in the browser (client/src/lib/leaderboardDiagnostics.ts).
//
// Never the row id: it is steam:<SteamID64> for any Steam player. Usernames
// stay, so an admin can tell who is missing; other names a row was seen
// under (aliases) are only counted.

// A failing read repeats (the page polls every 30 s, the sampler every
// 2 minutes): one warning per this window, the rest at debug.
export const LEADERBOARD_WARN_INTERVAL_MS = 10 * 60 * 1000;

let lastWarnAt = null;

export function warnLeaderboardReadFailed(log, where, error, now = Date.now()) {
  const message = `Leaderboard read for ${where} failed: ${String(error?.message ?? error ?? "").slice(0, 200)}`;
  if (lastWarnAt === null || now < lastWarnAt || now - lastWarnAt >= LEADERBOARD_WARN_INTERVAL_MS) {
    lastWarnAt = now;
    log.warn(message);
  } else {
    log.debug(message);
  }
}

// Exposed for tests only.
export function resetLeaderboardWarnThrottle() {
  lastWarnAt = null;
}

const finiteOrNull = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const shortText = (value, max = 64) => (typeof value === "string" ? value.slice(0, max) : null);

function redactResets(resets) {
  if (!Array.isArray(resets)) return [];
  return resets
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({ at: finiteOrNull(entry.at), reason: shortText(entry.reason) }));
}

/**
 * The redacted summary of a getLeaderboard answer (`data`). `bridge` is null
 * when the bridge sends no diagnostics (1.7.73 and older, which read kills
 * only when the panel asks); `read` is then null too, since those rows say
 * nothing about reads.
 */
export function redactLeaderboardDiagnostics(data) {
  const players = Array.isArray(data?.players) ? data.players.filter((p) => p && typeof p === "object") : [];
  const raw = data?.diagnostics && typeof data.diagnostics === "object" ? data.diagnostics : null;
  const bridge = raw
    ? {
        version: shortText(raw.bridgeVersion),
        sweepIntervalMs: finiteOrNull(raw.sweepIntervalMs),
        lastSweepAt: finiteOrNull(raw.lastSweepAt),
        sweepCount: finiteOrNull(raw.sweepCount),
        lastSweepPlayers: finiteOrNull(raw.lastSweepPlayers),
        loadedFrom: shortText(raw.loadedFrom),
        flushSeq: finiteOrNull(raw.flushSeq),
        resets: redactResets(raw.resets),
      }
    : null;
  const rows = players.map((player) => ({
    username: shortText(player.username, 128),
    aliasCount: Array.isArray(player.aliases) ? player.aliases.length : 0,
    // everRead: a row read before the update, by a bridge that kept no read time.
    read: bridge ? player.everRead === true || finiteOrNull(player.lastSampledAt) !== null : null,
    lastSampledAt: finiteOrNull(player.lastSampledAt),
    lastSampleSource: shortText(player.lastSampleSource),
    online: player.online === true,
    awaitingNewLife: player.awaitingNewLife === true,
    currentKills: finiteOrNull(player.currentKills),
    allTimeKills: finiteOrNull(player.allTimeKills),
    currentDays: finiteOrNull(player.currentDays),
    bestDays: finiteOrNull(player.bestDays),
    deaths: finiteOrNull(player.deaths),
  }));
  return {
    generatedAt: finiteOrNull(data?.generatedAt),
    trackingStartedAt: finiteOrNull(data?.trackingStartedAt),
    bridge,
    playerCount: rows.length,
    onlineCount: rows.filter((row) => row.online).length,
    notReadCount: bridge ? rows.filter((row) => !row.read).length : null,
    players: rows,
  };
}
