import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { rconApi, serversApi, configApi, ApiError, type ServerInstance } from '@/lib/api'
import enConsole from '../../locales/en/console.json'

// bug-hunt-2026-09-18 (console page hunt, capability gate sweep): on every
// visit the RCON tab's mount effect fired two requests without checking the
// caller could make them --
//  * GET /rcon/history needs rcon.execute (it returns every past command), so
//    a role without it got a "History Unavailable" toast on each page load;
//  * POST /config/test-rcon needs server.configure (NOT rcon.execute), so a
//    role that can run commands but not configure the server got a 403, which
//    testRconConnection's catch reads as "host unreachable": a false red
//    banner AND a disabled command input for a role that could have used it.

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
    rconApi: { ...actual.rconApi, execute: vi.fn(), getHistory: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    configApi: { ...actual.configApi, testRcon: vi.fn() },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const getHistory = vi.mocked(rconApi.getHistory)
const testRcon = vi.mocked(configApi.testRcon)

const server: ServerInstance = {
  id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: '', zomboidDataPath: null,
  serverConfigPath: null, rconHost: '10.0.0.5', rconPort: 27015, rconPassword: 'hunter2',
  serverPort: 16261, minMemory: 2048, maxMemory: 4096, useNoSteam: false, useDebug: false,
  isRemote: false, isActive: true, startCommand: '', adminPassword: '',
  createdAt: '2026-01-01T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = () => true
})

async function renderRconTab() {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [server] })
  getHistory.mockResolvedValue({ history: [] })
  // What the real route answers a role without server.configure.
  testRcon.mockRejectedValue(new ApiError('Forbidden', 403))
  render(
    <TooltipProvider>
      <ConfirmProvider>
        <Console />
      </ConfirmProvider>
    </TooltipProvider>,
  )
  fireEvent.mouseDown(await screen.findByRole('tab', { name: /rcon console/i }), { button: 0 })
  return (await screen.findByLabelText(/rcon command input/i)) as HTMLInputElement
}

describe('Console.tsx: mount-time RCON probes respect the capability their route requires', () => {
  it('does not probe the connection, or show an unreachable banner, for a role without server.configure', async () => {
    mockCan = (capability) => capability !== 'server.configure'
    const input = await renderRconTab()

    // Let the mount effects settle.
    await waitFor(() => expect(getHistory).toHaveBeenCalled())
    expect(testRcon).not.toHaveBeenCalled()
    expect(screen.queryByText(enConsole.rcon.hostUnreachableTitle)).not.toBeInTheDocument()
    expect(screen.queryByText(enConsole.rcon.offline)).not.toBeInTheDocument()
    expect(input).not.toBeDisabled()
  })

  it('does not fetch command history, or toast about it, for a role without rcon.execute', async () => {
    mockCan = (capability) => capability !== 'rcon.execute'
    await renderRconTab()

    await waitFor(() => expect(testRcon).toHaveBeenCalled())
    expect(getHistory).not.toHaveBeenCalled()
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: enConsole.toasts.historyUnavailableTitle }),
    )
  })
})
