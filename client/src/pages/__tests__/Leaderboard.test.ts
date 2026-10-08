import { describe, expect, it } from 'vitest'
import { rankLeaderboard, type LeaderboardPlayer } from '../Leaderboard'
import { redactLeaderboardDiagnostics } from '@/lib/leaderboardDiagnostics'

const players: LeaderboardPlayer[] = [
  {
    id: 'alice', username: 'Alice', displayName: 'Alice', online: true,
    currentKills: 12, allTimeKills: 18, currentDays: 2, bestDays: 4,
    deaths: 1, favoriteWeapon: 'Axe', favoriteWeaponKills: 8,
  },
  {
    id: 'bob', username: 'Bob', displayName: 'Bob', online: false,
    currentKills: 30, allTimeKills: 30, currentDays: 3, bestDays: 3,
    deaths: 4, favoriteWeapon: 'Shotgun', favoriteWeaponKills: 5,
  },
  {
    id: 'cara', username: 'Cara', displayName: 'Cara', online: true,
    currentKills: 30, allTimeKills: 31, currentDays: 3, bestDays: 3,
    deaths: 0, favoriteWeapon: 'Axe', favoriteWeaponKills: 8,
  },
]

describe('leaderboard ranking', () => {
  it('sorts ties by all-time kills and then stable display name', () => {
    expect(rankLeaderboard(players, 'currentKills').map((player) => player.username))
      .toEqual(['Cara', 'Bob', 'Alice'])
  })

  it('searches usernames, display names, and favorite weapons', () => {
    expect(rankLeaderboard(players, 'allTimeKills', 'axe').map((player) => player.username))
      .toEqual(['Cara', 'Alice'])
    expect(rankLeaderboard(players, 'allTimeKills', 'bob').map((player) => player.username))
      .toEqual(['Bob'])
  })
})

describe('leaderboard diagnostics redaction (Copy diagnostics)', () => {
  const rows = [
    { ...players[0], id: 'steam:76561198000000001', aliases: ['alice_alt'], lastSampledAt: 1000, lastSampleSource: 'sweep' },
    { ...players[1], id: 'steam:76561198000000002' },
  ]

  it('keeps usernames, read times and counts, never a row id or an alias name', () => {
    const summary = redactLeaderboardDiagnostics({
      players: rows,
      generatedAt: 2000,
      trackingStartedAt: 500,
      diagnostics: { bridgeVersion: '1.7.74', lastSweepAt: 1000, sweepCount: 3, resets: [{ at: 400, reason: 'world changed' }] },
    })
    const text = JSON.stringify(summary)
    expect(text).not.toMatch(/steam:|7656119|alice_alt/)
    expect(summary.notReadCount).toBe(1)
    expect(summary.bridge?.resets).toEqual([{ at: 400, reason: 'world changed' }])
    expect(summary.players.map(({ username, read, aliasCount }) => ({ username, read, aliasCount }))).toEqual([
      { username: 'Alice', read: true, aliasCount: 1 },
      { username: 'Bob', read: false, aliasCount: 0 },
    ])
  })

  it('reports reads as unknown for a bridge that sends no diagnostics', () => {
    const summary = redactLeaderboardDiagnostics({ players: rows })
    expect(summary.bridge).toBeNull()
    expect(summary.notReadCount).toBeNull()
    expect(summary.players.every((row) => row.read === null)).toBe(true)
  })
})
