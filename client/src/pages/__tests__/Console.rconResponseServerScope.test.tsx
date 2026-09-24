import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Console from '../Console'
import { rconApi, serversApi, configApi, type ServerInstance } from '@/lib/api'

// console follow-ups (2026-09-18): 'rcon:response' is broadcast to ONE global
// "rcon-live" room, so with two servers registered (or two operators looking at
// different ones) server A's command output showed up in server B's Console
// panel. The server now tags the event with the serverId it ran on
// (server/routes/rcon.js) and this page drops events for any other server.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    rconApi: { ...actual.rconApi, execute: vi.fn(), getHistory: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    configApi: { ...actual.configApi, testRcon: vi.fn() },
  }
})

const server: ServerInstance = {
  id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: '', zomboidDataPath: null,
  serverConfigPath: null, rconHost: '10.0.0.5', rconPort: 27015, rconPassword: 'hunter2',
  serverPort: 16261, minMemory: 2048, maxMemory: 4096, useNoSteam: false, useDebug: false,
  isRemote: false, isActive: true, startCommand: '', adminPassword: '',
  createdAt: '2026-01-01T00:00:00.000Z',
}

function createFakeSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const socket = {
    connected: true,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler)
    }),
    emit: vi.fn(),
  }
  return {
    socket: socket as unknown as Socket,
    trigger: (event: string, data?: unknown) => {
      act(() => listeners.get(event)?.forEach((h) => h(data)))
    },
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderRconTab({ probeOk = true } = {}) {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [server] })
  vi.mocked(rconApi.getHistory).mockResolvedValue({ history: [] })
  if (probeOk) vi.mocked(configApi.testRcon).mockResolvedValue({ success: true, connected: true })
  else vi.mocked(configApi.testRcon).mockRejectedValue(new Error('unreachable'))
  const fake = createFakeSocket()
  render(
    <SocketContext.Provider value={fake.socket}>
      <TooltipProvider>
        <ConfirmProvider>
          <Console />
        </ConfirmProvider>
      </TooltipProvider>
    </SocketContext.Provider>,
  )
  fireEvent.mouseDown(await screen.findByRole('tab', { name: /rcon console/i }), { button: 0 })
  await screen.findByLabelText(/rcon command input/i)
  return fake
}

const broadcast = (serverId: number | string | null | undefined, response: string) => ({
  command: 'players',
  response,
  success: true,
  serverId,
  timestamp: new Date().toISOString(),
})

describe('Console.tsx: rcon:response broadcasts are scoped to the server being shown', () => {
  it('shows output tagged with the active server and hides output tagged with another server', async () => {
    const { trigger } = await renderRconTab()

    trigger('rcon:response', broadcast(2, 'output from the OTHER server'))
    trigger('rcon:response', broadcast(1, 'output from Ashenwood'))

    expect(await screen.findByText('output from Ashenwood')).toBeInTheDocument()
    expect(screen.queryByText('output from the OTHER server')).not.toBeInTheDocument()
  })

  it('compares ids as strings, so a string serverId matches a numeric active id', async () => {
    const { trigger } = await renderRconTab()

    trigger('rcon:response', broadcast('1', 'string-tagged output'))

    expect(await screen.findByText('string-tagged output')).toBeInTheDocument()
  })

  it('does not let another server\'s successful reply flip the connection banner to online', async () => {
    const { trigger } = await renderRconTab({ probeOk: false })
    await screen.findByText(/rcon offline/i)

    trigger('rcon:response', broadcast(2, 'other server is fine'))

    expect(screen.queryByText(/rcon online/i)).not.toBeInTheDocument()
    expect(screen.getByText(/rcon offline/i)).toBeInTheDocument()
  })
})
