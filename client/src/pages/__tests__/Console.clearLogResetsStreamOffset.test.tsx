import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { serverApi, serversApi, rconApi, configApi, type ServerInstance } from '@/lib/api'

// console follow-ups (2026-09-18): after "clear", the file on disk is empty but
// serverLogSizeRef kept the pre-clear byte size, so the next stream poll asked
// for bytes past the end of the file. It only worked through the server's
// "rotated" fallback (which replaces the whole view). The offset now restarts
// at 0 right after a successful clear.

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
})

describe('Console.tsx: clearing the server log restarts the stream offset', () => {
  it('polls from offset 0 after a successful clear, not from the pre-clear file size', async () => {
    vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [server] })
    vi.mocked(serverApi.getConsoleLog).mockResolvedValue({
      lines: ['boot ok'], size: 4096, path: 'C:/servers/ashenwood/server-console.txt', exists: true,
    })
    vi.mocked(serverApi.streamConsoleLog).mockResolvedValue({ newLines: [], currentSize: 4096 })
    vi.mocked(serverApi.clearConsoleLog).mockResolvedValue({ success: true } as never)
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

    // Sanity: before the clear, polls use the loaded size.
    await waitFor(() => expect(serverApi.streamConsoleLog).toHaveBeenCalledWith(4096), { timeout: 4000 })

    fireEvent.click(screen.getByRole('button', { name: /^clear$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /erase log file/i }))
    await waitFor(() => expect(serverApi.clearConsoleLog).toHaveBeenCalled())

    vi.mocked(serverApi.streamConsoleLog).mockClear()
    await waitFor(() => expect(serverApi.streamConsoleLog).toHaveBeenCalled(), { timeout: 4000 })
    await act(async () => {})

    for (const call of vi.mocked(serverApi.streamConsoleLog).mock.calls) {
      expect(call[0]).toBe(0)
    }
  }, 15000)
})
