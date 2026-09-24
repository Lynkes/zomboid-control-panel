import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { rconApi, serversApi, configApi, type ServerInstance } from '@/lib/api'

// bug-hunt-2026-09-18 (round 19, client-vs-server permission gate sweep):
// the Recheck button calls testRconConnection() -> configApi.testRcon() ->
// POST /config/test-rcon, gated server-side on server.configure -- a
// DIFFERENT route and capability from rcon.js's own /rcon/test (double-gated
// rcon.execute+servers.manage). The button had no permission check of any
// kind, so a role holding rcon.execute but not server.configure saw it
// fully enabled and only found out with a 403.

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
    rconApi: {
      ...actual.rconApi,
      execute: vi.fn(),
      getHistory: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    configApi: { ...actual.configApi, testRcon: vi.fn() },
  }
})

const getHistory = vi.mocked(rconApi.getHistory)
const getAllServers = vi.mocked(serversApi.getAll)
const testRcon = vi.mocked(configApi.testRcon)

const rconReadyServer: ServerInstance = {
  id: 1,
  name: 'Ashenwood',
  serverName: 'Ashenwood',
  installPath: '',
  zomboidDataPath: null,
  serverConfigPath: null,
  rconHost: '10.0.0.5',
  rconPort: 27015,
  rconPassword: 'hunter2',
  serverPort: 16261,
  minMemory: 2048,
  maxMemory: 4096,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  isActive: true,
  startCommand: '',
  adminPassword: '',
  createdAt: '2026-01-01T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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

async function setUp() {
  getAllServers.mockResolvedValue({ servers: [rconReadyServer] })
  getHistory.mockResolvedValue({ history: [] })
  testRcon.mockResolvedValue({ success: true, connected: true })
}

async function openRconTab() {
  const tabButton = await screen.findByRole('tab', { name: /rcon console/i })
  fireEvent.mouseDown(tabButton, { button: 0 })
}

describe('Console.tsx: Recheck is gated on server.configure, not rcon.execute', () => {
  it('disables the Recheck button and never calls testRcon again when the role lacks server.configure', async () => {
    mockCan = (capability) => capability !== 'server.configure'
    await setUp()

    renderConsole()
    await openRconTab()

    const recheckButton = await screen.findByRole('button', { name: /recheck/i })
    expect(recheckButton).toBeDisabled()

    testRcon.mockClear()
    fireEvent.click(recheckButton)
    expect(testRcon).not.toHaveBeenCalled()
  })

  it('enables Recheck when the role holds server.configure, even without rcon.execute', async () => {
    mockCan = (capability) => capability === 'server.configure'
    await setUp()

    renderConsole()
    await openRconTab()

    const recheckButton = await screen.findByRole('button', { name: /recheck/i })
    expect(recheckButton).not.toBeDisabled()
  })
})
