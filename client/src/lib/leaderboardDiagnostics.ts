// The Leaderboard page's "Copy diagnostics" JSON: the same redacted summary
// as the support bundle's leaderboard-diagnostics.json
// (server/services/leaderboardDiagnostics.js), so an admin can paste it in a
// support thread. Never the row id: it is steam:<SteamID64> for any Steam
// player. Usernames stay, so a helper can tell who is missing; other names a
// row was seen under (aliases) are only counted.

export interface LeaderboardReset {
  at?: number
  reason?: string
}

/** getLeaderboard's diagnostics block; absent from bridges up to 1.7.73. */
export interface LeaderboardDiagnostics {
  bridgeVersion?: string
  sweepIntervalMs?: number
  lastSweepAt?: number
  sweepCount?: number
  lastSweepPlayers?: number
  loadedFrom?: string
  flushSeq?: number
  resets?: LeaderboardReset[]
}

interface LeaderboardRowInput {
  id?: string
  username?: string
  online?: boolean
  currentKills?: number
  allTimeKills?: number
  currentDays?: number
  bestDays?: number
  deaths?: number
  lastSampledAt?: number
  lastSampleSource?: string
  everRead?: boolean
  aliases?: string[]
  awaitingNewLife?: boolean
}

export interface LeaderboardDataInput {
  players?: LeaderboardRowInput[]
  generatedAt?: number
  trackingStartedAt?: number
  diagnostics?: LeaderboardDiagnostics | null
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const shortText = (value: unknown, max = 64): string | null =>
  typeof value === 'string' ? value.slice(0, max) : null

/**
 * Whether the bridge has read this row's kills and days (null: it doesn't
 * say). everRead also covers a row read before the update, by a bridge that
 * kept no read time; lastSampledAt alone would call it never read.
 */
export function leaderboardRowRead(
  row: Pick<LeaderboardRowInput, 'lastSampledAt' | 'everRead'>,
  diagnostics: LeaderboardDiagnostics | null | undefined,
): boolean | null {
  if (!diagnostics) return null
  return row.everRead === true || finiteOrNull(row.lastSampledAt) !== null
}

export function redactLeaderboardDiagnostics(data: LeaderboardDataInput) {
  const players = Array.isArray(data.players) ? data.players.filter((p) => p && typeof p === 'object') : []
  const raw = data.diagnostics && typeof data.diagnostics === 'object' ? data.diagnostics : null
  const bridge = raw
    ? {
        version: shortText(raw.bridgeVersion),
        sweepIntervalMs: finiteOrNull(raw.sweepIntervalMs),
        lastSweepAt: finiteOrNull(raw.lastSweepAt),
        sweepCount: finiteOrNull(raw.sweepCount),
        lastSweepPlayers: finiteOrNull(raw.lastSweepPlayers),
        loadedFrom: shortText(raw.loadedFrom),
        flushSeq: finiteOrNull(raw.flushSeq),
        resets: (Array.isArray(raw.resets) ? raw.resets : [])
          .filter((entry) => entry && typeof entry === 'object')
          .map((entry) => ({ at: finiteOrNull(entry.at), reason: shortText(entry.reason) })),
      }
    : null
  const rows = players.map((player) => ({
    username: shortText(player.username, 128),
    aliasCount: Array.isArray(player.aliases) ? player.aliases.length : 0,
    read: leaderboardRowRead(player, raw),
    lastSampledAt: finiteOrNull(player.lastSampledAt),
    lastSampleSource: shortText(player.lastSampleSource),
    online: player.online === true,
    awaitingNewLife: player.awaitingNewLife === true,
    currentKills: finiteOrNull(player.currentKills),
    allTimeKills: finiteOrNull(player.allTimeKills),
    currentDays: finiteOrNull(player.currentDays),
    bestDays: finiteOrNull(player.bestDays),
    deaths: finiteOrNull(player.deaths),
  }))
  return {
    generatedAt: finiteOrNull(data.generatedAt),
    trackingStartedAt: finiteOrNull(data.trackingStartedAt),
    bridge,
    playerCount: rows.length,
    onlineCount: rows.filter((row) => row.online).length,
    notReadCount: bridge ? rows.filter((row) => !row.read).length : null,
    players: rows,
  }
}
