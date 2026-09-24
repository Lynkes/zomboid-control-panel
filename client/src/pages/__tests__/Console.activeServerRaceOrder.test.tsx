import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act } from '@testing-library/react'
import Console from '../Console'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import { serverApi, serversApi, rconApi, configApi, type ServerInstance } from '@/lib/api'

// bug-hunt-2026-09-18 (round 8): loadConsoleTarget's own `cancelled` flag
// (see Console.activeServerChanged.test.tsx, round-2026-09-04's fix) only
// flips true on UNMOUNT -- it does nothing to stop an OLDER of two
// overlapping GET /servers calls from applying its response after a NEWER
// call already has. Switching the active server while the page's initial
// (mount-triggered) fetch is still in flight is exactly this shape: mount
// fires call #1 for whatever was active at the time, activeServerChanged
// fires call #2 for the new target, and if #2's response lands first (the
// common case -- it's issued later but network timing doesn't respect
// request order) followed by #1 arriving late, #1's stale answer overwrites
// #2's correct one with no further trigger to self-correct. This test
// deliberately resolves the two mocked requests OUT OF ORDER (older one
// last) and asserts the newer server's state survives.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: null },
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

// Same stable-identity fake socket as Console.activeServerChanged.test.tsx --
// see that file's own comment for why it must not be a fresh object literal.
const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: () => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: () => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const getConsoleLog = vi.mocked(serverApi.getConsoleLog)
const clearConsoleLog = vi.mocked(serverApi.clearConsoleLog)
const getAllServers = vi.mocked(serversApi.getAll)
const getHistory = vi.mocked(rconApi.getHistory)
const testRcon = vi.mocked(configApi.testRcon)

function makeServer(overrides: Partial<ServerInstance>): ServerInstance {
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '', rconPort: 0, rconPassword: '',
    serverPort: 16261, minMemory: 2048, maxMemory: 4096, useNoSteam: false, useDebug: false,
    isRemote: false, isActive: true, startCommand: '', adminPassword: '',
    createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

// Same observable signal as the sibling test: serverA has a log source
// configured, serverB does not, so "Server log path not configured"
// showing (or not) says which server's data actually won.
const serverA = makeServer({ id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood' })
const serverB = makeServer({ id: 2, name: 'Brightmoor', serverName: 'Brightmoor', installPath: null, zomboidDataPath: null })

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

function renderConsole() {
  return render(
    <TooltipProvider>
      <ConfirmProvider>
        <Console />
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

describe('Console.tsx: an older, slower active-server response must not overwrite a newer one', () => {
  it('keeps the newer server selected when the mount-time fetch resolves AFTER the activeServerChanged fetch', async () => {
    let resolveMountFetch: (value: { servers: ServerInstance[] }) => void = () => {}
    const mountFetch = new Promise<{ servers: ServerInstance[] }>((resolve) => { resolveMountFetch = resolve })

    // Call #1 (mount): held open, stands in for a slow/delayed response.
    // Call #2 (activeServerChanged): resolves immediately with the NEW
    // server -- the realistic case where the later-issued request wins the
    // network race, as it normally would.
    getAllServers
      .mockImplementationOnce(() => mountFetch)
      .mockImplementationOnce(() => Promise.resolve({ servers: [serverB] }))
    getConsoleLog.mockResolvedValue({ lines: ['boot ok'], size: 42, path: 'C:/servers/ashenwood/server-console.txt', exists: true })
    clearConsoleLog.mockResolvedValue({ success: true })
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockReset()

    renderConsole()
    // Mount's own fetch hasn't resolved yet -- nothing to assert about its
    // content, just that the switch hasn't happened yet.
    expect(getAllServers).toHaveBeenCalledTimes(1)

    // Switch to serverB while the mount fetch is still pending -- its own
    // request (call #2) resolves right away.
    await act(async () => { emitActiveServerChanged() })
    expect(getAllServers).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('Server log path not configured')).toBeInTheDocument()

    // NOW the stale mount-time request for serverA finally lands, arriving
    // strictly after the newer, already-applied serverB response.
    await act(async () => { resolveMountFetch({ servers: [serverA] }) })

    // The bug: unfixed code has nothing gating this late apply, so it
    // silently reverts the page back to serverA -- the banner disappears
    // and "boot ok" reappears, even though serverB is the real, current
    // active server.
    expect(screen.queryByText('Server log path not configured')).toBeInTheDocument()
    expect(screen.queryByText('boot ok')).not.toBeInTheDocument()
  })
})
