import type { ServerInstance } from '@/lib/api'

// What servers that run at the same time share: the machine's memory and its
// network ports. Settings › Connection and the Dashboard's list of servers
// warn from these about the servers chosen to start with the panel.

export const BYTES_PER_GB = 1024 ** 3

export function formatGb(bytes: number): string {
  return (bytes / BYTES_PER_GB).toFixed(1)
}

// The heap the servers may take between them: the sum of their maximum
// memory (-Xmx), in GB. The JVM uses a little more than that on top.
export function heapOfServers(servers: ServerInstance[]): number {
  return servers.reduce((sum, server) => sum + (Number(server.maxMemory) || 0), 0)
}

export type PortConflict = {
  kind: 'game' | 'rcon'
  first: ServerInstance
  second: ServerInstance
}

// Two local servers can't both run on the same ports: the game port and the
// one after it (UDP, DefaultPort and DefaultPort + 1), and the RCON port
// (TCP). A remote server runs on another machine and is left out.
export function portConflicts(servers: ServerInstance[]): PortConflict[] {
  const local = servers.filter((server) => !server.isRemote)
  const conflicts: PortConflict[] = []
  for (let i = 0; i < local.length; i += 1) {
    for (let j = i + 1; j < local.length; j += 1) {
      const first = local[i]
      const second = local[j]
      const gameA = Number(first.serverPort)
      const gameB = Number(second.serverPort)
      if (Number.isInteger(gameA) && Number.isInteger(gameB) && Math.abs(gameA - gameB) <= 1) {
        conflicts.push({ kind: 'game', first, second })
      }
      const rconA = Number(first.rconPort)
      const rconB = Number(second.rconPort)
      if (Number.isInteger(rconA) && rconA > 0 && rconA === rconB) {
        conflicts.push({ kind: 'rcon', first, second })
      }
    }
  }
  return conflicts
}
