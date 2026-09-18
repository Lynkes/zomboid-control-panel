import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { serverApi, serversApi, rconApi, configApi, type ServerInstance } from '@/lib/api'

// bug-hunt-2026-09-18 (console page hunt, capability gate sweep): the Server
// Log tab's "clear" button calls POST /server/console-log/clear, which the
// server gates on server.configure (server/routes/server.js). The button had no
// permission check -- a role that can read the log (server.world_events) but
// lacks server.configure saw it enabled, got the "Erase the console log?"
// confirm dialog, and only learned it was never allowed from a 403 toast.
// Same class as the Recheck fix (Console.recheckConfigureCapability.test.tsx).

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'moderator', capabilities: [] },
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

async function renderWithLog() {
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
  await screen.findByText('boot ok')
  return screen.getByRole('button', { name: /^clear$/i })
}

describe('Console.tsx: clearing the server log is gated on server.configure', () => {
  it('disables the clear button and never opens the confirm dialog or calls the route without server.configure', async () => {
    mockCan = (capability) => capability !== 'server.configure'
    const clear = await renderWithLog()

    expect(clear).toBeDisabled()
    fireEvent.click(clear)

    expect(screen.queryByText(/erase the console log for/i)).not.toBeInTheDocument()
    expect(serverApi.clearConsoleLog).not.toHaveBeenCalled()
  })

  it('still offers the confirm dialog when the role holds server.configure', async () => {
    mockCan = () => true
    const clear = await renderWithLog()

    expect(clear).not.toBeDisabled()
    fireEvent.click(clear)

    expect(await screen.findByText(/erase the console log for Ashenwood/i)).toBeInTheDocument()
  })
})
