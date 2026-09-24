import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { serverApi, serversApi, rconApi, configApi, type ServerInstance } from '@/lib/api'
import enConsole from '../../locales/en/console.json'

// console follow-ups (2026-09-18): GET /server/console-log and /console-log/stream
// are gated on server.world_events (server/routes/server.js). The Server Log
// tab had no such check, so a role without it polled the stream every 2s,
// collected a 403 each time and, after three, showed a "stream unavailable"
// banner that blamed the stream instead of the missing permission. It now
// skips the requests entirely and says why.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'custom', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serverApi: {
      ...actual.serverApi,
      getConsoleLog: vi.fn(),
      streamConsoleLog: vi.fn(),
      clearConsoleLog: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    rconApi: { ...actual.rconApi, getHistory: vi.fn() },
    configApi: { ...actual.configApi, testRcon: vi.fn() },
  }
})

const server: ServerInstance = {
  id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood',
  zomboidDataPath: null, serverConfigPath: null, rconHost: '', rconPort: 0, rconPassword: '',
  serverPort: 16261, minMemory: 2048, maxMemory: 4096, useNoSteam: false, useDebug: false,
  isRemote: false, isActive: true, startCommand: '', adminPassword: '',
  createdAt: '2026-01-01T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = () => true
})

function renderConsole() {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [server] })
  vi.mocked(serverApi.getConsoleLog).mockResolvedValue({
    lines: ['boot ok'], size: 42, path: 'C:/servers/ashenwood/server-console.txt', exists: true,
  })
  vi.mocked(serverApi.streamConsoleLog).mockResolvedValue({ newLines: [], currentSize: 42 })
  vi.mocked(rconApi.getHistory).mockResolvedValue({ history: [] })
  vi.mocked(configApi.testRcon).mockResolvedValue({ success: true, connected: true })
  render(
    <TooltipProvider>
      <ConfirmProvider>
        <Console />
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

describe('Console.tsx: the Server Log tab is gated on server.world_events', () => {
  it('without server.world_events: explains why, never fetches or polls the log, shows no stream-unavailable banner', async () => {
    mockCan = (capability) => capability !== 'server.world_events'
    renderConsole()

    expect(await screen.findByText(enConsole.unavailable.noPermissionTitle)).toBeInTheDocument()
    expect(screen.getByText(enConsole.unavailable.noPermissionDesc)).toBeInTheDocument()

    // Well past two poll intervals (2s each).
    await act(async () => { await new Promise((r) => setTimeout(r, 4500)) })

    expect(serverApi.getConsoleLog).not.toHaveBeenCalled()
    expect(serverApi.streamConsoleLog).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  }, 10000)

  it('with server.world_events: loads the log as before and shows no permission notice', async () => {
    renderConsole()

    expect(await screen.findByText('boot ok')).toBeInTheDocument()
    expect(serverApi.getConsoleLog).toHaveBeenCalled()
    expect(screen.queryByText(enConsole.unavailable.noPermissionTitle)).not.toBeInTheDocument()
  })
})
