import { describe, expect, it } from 'vitest'
import { buildTeleportPlayerCommand, buildTeleportToCommand } from '../teleportCommands'

describe('Build 42 RCON teleport commands', () => {
  it('uses teleportplayer for player-to-player movement', () => {
    expect(buildTeleportPlayerCommand('player1', 'player2')).toBe(
      'teleportplayer "player1" "player2"',
    )
  })

  it('includes the target player for coordinate teleports', () => {
    expect(buildTeleportToCommand(100, 200, 0, 'player1')).toBe(
      'teleportto "player1" 100,200,0',
    )
  })

  it('keeps the self-teleport form when no target is supplied', () => {
    expect(buildTeleportToCommand(100, 200, 0)).toBe('teleportto 100,200,0')
  })
})