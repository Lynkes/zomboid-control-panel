export function buildTeleportPlayerCommand(player1: string, player2: string): string {
  return `teleportplayer "${player1}" "${player2}"`
}

export function buildTeleportToCommand(x: number, y: number, z: number, targetPlayer?: string): string {
  const target = targetPlayer ? `"${targetPlayer}" ` : ''
  return `teleportto ${target}${x},${y},${z}`
}