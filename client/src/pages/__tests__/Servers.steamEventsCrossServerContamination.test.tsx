import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, serversDetectApi, dockerApi, configApi, updateApi, serverApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// steam-update-events-cross-server-contamination, 2026-09-18: POST
// /steam-update's concurrency guard is scoped per installPath, so an update
// on one server and a verify on a DIFFERENT server can genuinely run at the
// same time (two admins, or one admin with two servers registered). The
// steam:start/steam:log/steam:complete socket events used to carry no
// identifier at all -- whichever dialog was open received every event
// regardless of which server it belonged to, so an unrelated server's log
// lines leaked into this dialog's panel, and an unrelated server's
// steam:complete could close THIS dialog out as that server's own
// success/failure. This proves the fix: events tagged with a DIFFERENT
// server's installPath than the one this dialog started are ignored, and
// the dialog only resolves on its own operation's matching event.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
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
    serversApi: {
      ...actual.serversApi,
      getAll: vi.fn(),
      getStatus: vi.fn(),
      getRconStatuses: vi.fn(),
      discoverMounts: vi.fn(),
      steamVerify: vi.fn(),
      steamUpdate: vi.fn(),
    },
    serversDetectApi: {
      ...actual.serversDetectApi,
      detect: vi.fn(),
      autoScan: vi.fn(),
    },
    dockerApi: {
      ...actual.dockerApi,
      getStatus: vi.fn(),
      getStats: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
      updateAppSettings: vi.fn(),
    },
    updateApi: {
      ...actual.updateApi,
      getStatus: vi.fn(),
    },
    serverApi: {
      ...actual.serverApi,
      detectSteamCmd: vi.fn(),
      getBranches: vi.fn(),
    },
  }
})

// Same registry-outside-React pattern as Debug.activeServerRaceOrder.test.tsx
// -- lets the test fire socket events independent of re-renders.
const socketHandlers = new Map<string, Set<(...args: unknown[]) => void>>()
const fakeSocket = {
  connected: true,
  on: (event: string, handler: (...args: unknown[]) => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: (...args: unknown[]) => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
} as unknown as Parameters<typeof SocketContext.Provider>[0]['value']

function emitSocket(event: string, data: unknown) {
  act(() => {
    socketHandlers.get(event)?.forEach((h) => h(data))
  })
}

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serversApi.getStatus)
const getRconStatuses = vi.mocked(serversApi.getRconStatuses)
const discoverMounts = vi.mocked(serversApi.discoverMounts)
const steamUpdate = vi.mocked(serversApi.steamUpdate)
const detect = vi.mocked(serversDetectApi.detect)
const autoScan = vi.mocked(serversDetectApi.autoScan)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const dockerGetStats = vi.mocked(dockerApi.getStats)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateAppSettings = vi.mocked(configApi.updateAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)
const detectSteamCmd = vi.mocked(serverApi.detectSteamCmd)
const getBranches = vi.mocked(serverApi.getBranches)

const SERVER_A = {
  id: 1,
  name: 'server-a',
  serverName: 'server-a-cfg',
  installPath: '/srv/a',
  zomboidDataPath: '/srv/a/data',
  serverConfigPath: '/srv/a/data/Server/server-a.ini',
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  isActive: false,
  startCommand: '',
  adminPassword: '',
  createdAt: new Date(0).toISOString(),
} as never

function renderServers() {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={fakeSocket}>
        <TooltipProvider>
          <ConfirmProvider>
            <Servers />
          </ConfirmProvider>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

async function setUpFixtures() {
  getAll.mockResolvedValue({ servers: [SERVER_A] } as never)
  getStatus.mockResolvedValue({ servers: [] } as never)
  getRconStatuses.mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  dockerGetStats.mockResolvedValue({ containers: {} } as never)
  getAppSettings.mockResolvedValue({ settings: { steamcmdPath: '/opt/steamcmd' } } as never)
  updateAppSettings.mockResolvedValue({ success: true } as never)
  updateGetStatus.mockResolvedValue({} as never)
  detect.mockResolvedValue({ servers: [] } as never)
  autoScan.mockResolvedValue({ servers: [] } as never)
  detectSteamCmd.mockResolvedValue({ found: false, path: null } as never)
  getBranches.mockResolvedValue({ branches: [] } as never)
}

async function openCardMenu(serverName: string) {
  const trigger = await screen.findByRole('button', { name: new RegExp(`options for ${serverName}`, 'i') })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

async function openSteamDialogForServerA() {
  const menu = await openCardMenu('server-a')
  fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.updateServer }))
  await screen.findByRole('heading', { name: en.steamDialog.updateTitle })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

describe('Servers.tsx: steam:* events are scoped to the operation this dialog started', () => {
  it('ignores log lines and a completion event for a different server\'s concurrent operation, then still resolves correctly on its own matching event', async () => {
    mockCan = () => true
    await setUpFixtures()
    steamUpdate.mockResolvedValue({ success: true } as never)

    renderServers()
    await screen.findByText('server-a')

    await openSteamDialogForServerA()
    fireEvent.click(screen.getByRole('button', { name: en.steamDialog.startUpdate }))
    await waitFor(() => expect(steamUpdate).toHaveBeenCalledTimes(1))
    // Confirms the exact installPath this dialog's operation is tracking --
    // the fixture used below for the "other server" must differ from it.
    expect(steamUpdate).toHaveBeenCalledWith('/opt/steamcmd', '/srv/a', 'public')

    // An unrelated, concurrently-running operation on a DIFFERENT server
    // (installPath '/srv/b') sends its own start/log -- must never surface
    // in this dialog, which only ever asked about '/srv/a'.
    emitSocket('steam:start', { type: 'update', message: 'Updating server...', installPath: '/srv/b' })
    emitSocket('steam:log', { type: 'stdout', text: 'unrelated-server-b-line', installPath: '/srv/b' })
    expect(screen.queryByText(/unrelated-server-b-line/)).not.toBeInTheDocument()

    // The unrelated server's operation now fails -- this must NOT be
    // mistaken for server A's own result. The dialog must still read as
    // running, not completed/failed.
    emitSocket('steam:complete', { success: false, message: 'server B failed', installPath: '/srv/b' })
    const findOutlineRunningButton = () =>
      screen.getAllByRole('button', { name: en.steamDialog.running }).find(
        (b) => b.getAttribute('data-variant') === 'outline',
      )
    await waitFor(() => expect(findOutlineRunningButton()).toBeDefined())
    expect(screen.queryByText('server B failed')).not.toBeInTheDocument()

    // Server A's own matching completion event still resolves the dialog
    // normally -- the fix doesn't just drop everything, only what
    // doesn't match.
    emitSocket('steam:complete', { success: true, message: 'Server update completed successfully', installPath: '/srv/a' })
    await waitFor(() => expect(screen.getByRole('button', { name: en.steamDialog.done })).toBeInTheDocument())
  })
})
