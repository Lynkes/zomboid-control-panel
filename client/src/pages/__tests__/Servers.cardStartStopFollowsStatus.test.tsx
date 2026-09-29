import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Servers from '../Servers'
import { serversApi, dockerApi, configApi, updateApi, serverApi, type ComposedServerStatus } from '@/lib/api'
import en from '../../locales/en/servers.json'

// 2026-09 Discord report (Windows native, server "MAZE", RCON
// 127.0.0.1:27015): after a Stop that really stopped the server, the
// selected server's card showed "Process Down (Stopped by an operator)",
// "RCON Down (127.0.0.1:27015)", "PanelBridge Up" -- and a Stop button, for
// minutes. The button and the badges both read the same composed
// host/RCON/PanelBridge status (resolveServerCardRunning: Stop while ANY
// signal is up); the server let an exited process's PanelBridge heartbeat
// stay "active" (fixed server-side), and this page only refreshed that
// composed status on its 10s interval or a server:status push -- never after
// its own confirmed inline Stop. These pin the card's side: Start whenever
// the badges say everything is down, the badges and the button moving
// together, and the switch landing within seconds of a stop.

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
    serversApi: {
      ...actual.serversApi,
      getAll: vi.fn(),
      getStatus: vi.fn(),
      getComposedStatus: vi.fn(),
      getRconStatuses: vi.fn(),
      discoverMounts: vi.fn(),
      activate: vi.fn(),
    },
    dockerApi: { ...actual.dockerApi, getStatus: vi.fn(), getStats: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    serverApi: { ...actual.serverApi, start: vi.fn(), stop: vi.fn() },
  }
})

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastMock, dismiss: vi.fn(), toasts: [] }),
}))

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serversApi.getStatus)
const getComposedStatus = vi.mocked(serversApi.getComposedStatus)
const getRconStatuses = vi.mocked(serversApi.getRconStatuses)
const discoverMounts = vi.mocked(serversApi.discoverMounts)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const dockerGetStats = vi.mocked(dockerApi.getStats)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)
const stop = vi.mocked(serverApi.stop)

const MAZE = {
  id: 1,
  name: 'Maze with friends',
  serverName: 'MAZE',
  installPath: 'C:/PZServer',
  zomboidDataPath: 'C:/PZServer_Data',
  serverConfigPath: 'C:/PZServer_Data/Server/MAZE.ini',
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  isActive: true,
  startCommand: '',
  adminPassword: '',
  createdAt: new Date(0).toISOString(),
} as never

const RUNNING: ComposedServerStatus = {
  provider: 'native',
  selected: true,
  host: { status: 'running', label: 'Process', detail: null },
  server: { status: 'connected', label: 'RCON', detail: '127.0.0.1:27015' },
  bridge: { status: 'active', label: 'PanelBridge', detail: null },
  summary: 'Process running, RCON connected',
}

const STOPPED: ComposedServerStatus = {
  provider: 'native',
  selected: true,
  host: { status: 'stopped', label: 'Process', detail: 'Stopped by an operator' },
  server: { status: 'disconnected', label: 'RCON', detail: '127.0.0.1:27015' },
  bridge: { status: 'offline', label: 'PanelBridge', detail: null },
  summary: 'Process stopped, RCON disconnected',
}

function setServerState(running: boolean) {
  getStatus.mockResolvedValue({
    servers: [{ id: 1, running, pid: running ? '4242' : null, stateUnknown: false }],
  } as never)
  getComposedStatus.mockResolvedValue(running ? RUNNING : STOPPED)
}

function setUpFixtures(running: boolean) {
  getAll.mockResolvedValue({ servers: [MAZE] } as never)
  setServerState(running)
  getRconStatuses.mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  dockerGetStats.mockResolvedValue({ containers: {} } as never)
  getAppSettings.mockResolvedValue({ settings: {} } as never)
  updateGetStatus.mockResolvedValue({} as never)
}

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
}

function renderServers(socket: typeof fakeSocket | null = null) {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={socket as never}>
        <TooltipProvider>
          <ConfirmProvider>
            <Servers />
          </ConfirmProvider>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

function card(): HTMLElement {
  const found = screen.getByText('Maze with friends').closest('.overflow-hidden.transition-colors')
  if (!found) throw new Error('could not find the Maze with friends card')
  return found as HTMLElement
}

// Well under the page's own 10s composed-status interval: a switch that only
// lands via that interval must fail these, not pass slowly.
const PROMPT = { timeout: 3000 }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

describe('Servers.tsx: the selected card offers Start as soon as the server is stopped', () => {
  it('shows Start next to Process/RCON/PanelBridge all Down -- the button and the badges agree', async () => {
    setUpFixtures(false)
    renderServers()

    await within(await screen.findByText('Maze with friends').then(card)).findByRole('button', { name: en.card.start }, PROMPT)
    const text = card().textContent ?? ''
    expect(text).toMatch(/Process\s*Down\s*\(Stopped by an operator\)/)
    expect(text).toMatch(/RCON\s*Down\s*\(127\.0\.0\.1:27015\)/)
    expect(text).toMatch(/PanelBridge\s*Down/)
    expect(text).not.toMatch(/\bUp\b/)
    expect(within(card()).queryByRole('button', { name: en.card.stop })).toBeNull()
  })

  it('switches from Stop to Start on the live server:status push, badges and button together', async () => {
    setUpFixtures(true)
    renderServers(fakeSocket)

    await within(await screen.findByText('Maze with friends').then(card)).findByRole('button', { name: en.card.stop }, PROMPT)
    expect(card().textContent).toMatch(/PanelBridge\s*Up/)

    setServerState(false)
    await act(async () => {
      socketHandlers.get('server:status')?.forEach((handler) => handler({ running: false, phase: 'stopped' }))
    })

    await within(card()).findByRole('button', { name: en.card.start }, PROMPT)
    expect(within(card()).queryByRole('button', { name: en.card.stop })).toBeNull()
    expect(card().textContent).toMatch(/PanelBridge\s*Down/)
    expect(card().textContent).toMatch(/Process\s*Down/)
  })

  it('switches to Start right after its own confirmed inline Stop, without waiting for a push or the 10s poll', async () => {
    setUpFixtures(true)
    stop.mockResolvedValue({ success: true, confirmed: false } as never)
    renderServers() // no socket: nothing else will announce the stop

    const stopButton = await within(await screen.findByText('Maze with friends').then(card)).findByRole('button', { name: en.card.stop }, PROMPT)
    fireEvent.click(stopButton)
    const dialog = await screen.findByRole('alertdialog')

    // The process exits: the confirmation poll and a fresh composed status
    // now both say stopped.
    setServerState(false)
    fireEvent.click(within(dialog).getByRole('button', { name: en.card.stop }))

    await within(card()).findByRole('button', { name: en.card.start }, PROMPT)
    expect(card().textContent).toMatch(/Process\s*Down/)
    expect(card().textContent).toMatch(/PanelBridge\s*Down/)
  })

  // The Dashboard already refetches before it toasts; the card toasted first,
  // so "Server Stopped" sat beside a card still showing its spinner and the
  // pre-stop badges for the length of a fresh process scan (~1.5s on Windows).
  it('toasts "Server Stopped" only after the card has refetched the stop it confirms', async () => {
    setUpFixtures(true)
    stop.mockResolvedValue({ success: true, confirmed: false } as never)
    renderServers()

    const stopButton = await within(await screen.findByText('Maze with friends').then(card)).findByRole('button', { name: en.card.stop }, PROMPT)
    fireEvent.click(stopButton)
    const dialog = await screen.findByRole('alertdialog')

    setServerState(false)
    let composedFetchesAfterStop = 0
    getComposedStatus.mockImplementation(async () => {
      composedFetchesAfterStop += 1
      return STOPPED
    })
    const composedFetchesAtToast: number[] = []
    toastMock.mockImplementation(() => {
      composedFetchesAtToast.push(composedFetchesAfterStop)
    })
    try {
      fireEvent.click(within(dialog).getByRole('button', { name: en.card.stop }))

      await vi.waitFor(
        () => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: en.toasts.serverStoppedTitle })),
        PROMPT,
      )
      expect(composedFetchesAtToast[0]).toBeGreaterThan(0)
    } finally {
      toastMock.mockReset()
    }
  })
})
