import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { serverApi, serversApi, rconApi, configApi, type ServerInstance } from '@/lib/api'
import enConsole from '@/locales/en/console.json'
import { MemoryRouter } from 'react-router-dom'

// Console audit (2026-10-12), the three client halves of the /console-log/stream
// fixes:
//  - the log pane never appeared when server-console.txt did not exist yet at
//    page load (only the initial fetch ever set serverLogExists);
//  - the "rotated" answer replaced the whole view with every line it carried
//    (the other path slices to 500, and the pane renders all it holds);
//  - the identity token of the file the offset belongs to is echoed back, so a
//    second open page learns about a recreated log too.

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
    serverApi: {
      ...actual.serverApi,
      getConsoleLog: vi.fn(),
      streamConsoleLog: vi.fn(),
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

function renderConsole() {
  return render(
    <TooltipProvider>
      <ConfirmProvider>
        <MemoryRouter><Console /></MemoryRouter>
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

beforeEach(() => {
  vi.mocked(serversApi.getAll).mockReset().mockResolvedValue({ servers: [server] })
  vi.mocked(rconApi.getHistory).mockReset().mockResolvedValue({ history: [] })
  vi.mocked(configApi.testRcon).mockReset().mockResolvedValue({ success: true, connected: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Console.tsx: the server log stream', () => {
  it('shows the log pane once the file appears after the page loaded', async () => {
    vi.mocked(serverApi.getConsoleLog).mockReset().mockResolvedValue({
      success: true, lines: [], exists: false, path: 'C:/servers/ashenwood/server-console.txt',
    })
    vi.mocked(serverApi.streamConsoleLog).mockReset().mockResolvedValue({
      success: true, newLines: ['game finally started'], currentSize: 120, rotated: true, identity: '7:1700000000000',
    })
    renderConsole()

    expect(await screen.findByText(enConsole.serverLog.notFoundTitle)).toBeInTheDocument()
    expect(await screen.findByText('game finally started', undefined, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.queryByText(enConsole.serverLog.notFoundTitle)).not.toBeInTheDocument()
  }, 15000)

  it('keeps showing "not found" while the stream still says the file does not exist', async () => {
    vi.mocked(serverApi.getConsoleLog).mockReset().mockResolvedValue({ success: true, lines: [], exists: false })
    vi.mocked(serverApi.streamConsoleLog).mockReset().mockResolvedValue({ success: true, newLines: [], exists: false })
    renderConsole()

    expect(await screen.findByText(enConsole.serverLog.notFoundTitle)).toBeInTheDocument()
    await waitFor(() => expect(serverApi.streamConsoleLog).toHaveBeenCalled(), { timeout: 4000 })
    expect(screen.getByText(enConsole.serverLog.notFoundTitle)).toBeInTheDocument()
  }, 15000)

  it('keeps only the last 500 lines of a rotated answer', async () => {
    vi.mocked(serverApi.getConsoleLog).mockReset().mockResolvedValue({
      success: true, lines: ['boot ok'], size: 42, exists: true, path: 'C:/servers/ashenwood/server-console.txt',
    })
    const many = Array.from({ length: 1500 }, (_, i) => `line ${i}`)
    vi.mocked(serverApi.streamConsoleLog).mockReset().mockResolvedValue({
      success: true, newLines: many, currentSize: 9000, rotated: true, truncated: true,
    })
    renderConsole()

    await screen.findByText('line 1499', undefined, { timeout: 4000 })
    expect(screen.getByText('line 1000')).toBeInTheDocument()
    expect(screen.queryByText('line 999')).not.toBeInTheDocument()
    expect(screen.queryByText('line 0')).not.toBeInTheDocument()
  }, 15000)

  it("echoes the file's identity token back with each poll and follows the one the server returns", async () => {
    vi.mocked(serverApi.getConsoleLog).mockReset().mockResolvedValue({
      success: true, lines: ['boot ok'], size: 42, exists: true, identity: '7:1700000000000',
      path: 'C:/servers/ashenwood/server-console.txt',
    })
    vi.mocked(serverApi.streamConsoleLog).mockReset()
      .mockResolvedValueOnce({
        success: true, newLines: ['restarted'], currentSize: 10, rotated: true, identity: '9:1700000099000',
      })
      .mockResolvedValue({ success: true, newLines: [], currentSize: 10, identity: '9:1700000099000' })
    renderConsole()

    await waitFor(() => expect(serverApi.streamConsoleLog).toHaveBeenCalledTimes(2), { timeout: 8000 })
    const calls = vi.mocked(serverApi.streamConsoleLog).mock.calls
    expect(calls[0]).toEqual([42, '7:1700000000000'])
    expect(calls[1]).toEqual([10, '9:1700000099000'])
  }, 15000)
})
