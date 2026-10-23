import { describe, expect, it } from 'vitest'
import type { ServerInstance } from '@/lib/api'
import { formatGb, heapOfServers, portConflicts } from '@/lib/serversTogether'

// What servers that run together share: the machine's memory and its ports.

function server(id: string, extra: Partial<ServerInstance> = {}): ServerInstance {
  return { id, name: id, serverName: id, serverPort: 16261, rconPort: 27015, maxMemory: 8, isRemote: false, ...extra } as ServerInstance
}

describe('heapOfServers()', () => {
  it('adds up their maximum memory', () => {
    expect(heapOfServers([server('a', { maxMemory: 8 }), server('b', { maxMemory: 6 })])).toBe(14)
  })
})

describe('formatGb()', () => {
  it('shows one decimal', () => {
    expect(formatGb(3.5 * 1024 ** 3)).toBe('3.5')
  })
})

describe('portConflicts()', () => {
  it('finds game ports one apart or equal, and the same RCON port', () => {
    const conflicts = portConflicts([
      server('a', { serverPort: 16261, rconPort: 27015 }),
      server('b', { serverPort: 16262, rconPort: 27016 }),
      server('c', { serverPort: 16271, rconPort: 27015 }),
    ])
    expect(conflicts.map((c) => `${c.kind}:${c.first.id}-${c.second.id}`)).toEqual(['game:a-b', 'rcon:a-c'])
  })

  it('leaves remote servers and servers two ports apart alone', () => {
    expect(portConflicts([
      server('a', { serverPort: 16261, rconPort: 27015 }),
      server('b', { serverPort: 16263, rconPort: 27016 }),
      server('far', { serverPort: 16261, rconPort: 27015, isRemote: true }),
    ])).toEqual([])
  })
})
