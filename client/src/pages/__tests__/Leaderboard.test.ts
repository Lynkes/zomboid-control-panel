import { describe, expect, it } from 'vitest'
import { rankLeaderboard, type LeaderboardPlayer } from '../Leaderboard'

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
