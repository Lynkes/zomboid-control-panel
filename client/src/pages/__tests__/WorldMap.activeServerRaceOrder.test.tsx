import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import WorldMap from '../WorldMap'
import { panelBridgeApi, serversApi, updateApi, mapApi, type ServerInstance } from '@/lib/api'

// continuous-bug-hunt round 26 (PanelBridge command queue and response
// matching): fetchPlayerPositions runs on a 3s poll (POLL_INTERVAL) AND is
// now also fired directly by the activeServerChanged handler (see
// fetchPlayerPositionsRef's own comment in WorldMap.tsx), with nothing
// before this fix to stop an OLDER poll tick -- already in flight for the
// server that was active a moment ago -- from resolving AFTER the switch
// and repainting the just-cleared map with the previous server's stale
// player positions. Same shape as Players/Events/Dashboard's own
// activeServerRaceOrder fixes (round 9/10), via the shared useRequestGuard
// hook (playerPositionsGuard in WorldMap.tsx) -- WorldMap never got the
// same treatment until now.
//
// The extra wrinkle this test also proves: WorldMap's fetchPlayerPositions
// has its OWN in-flight gate (playerFetchGateRef) on top of the guard. The
// activeServerChanged-triggered call can arrive while that gate is still
// held by the stale poll tick, meaning it does no new fetch of its own --
// but it must still bump the guard so the stale tick's own eventual
// response is recognized as stale once it finally lands. Getting that
// ordering backwards (checking the gate before bumping the guard) would
// silently defeat the whole fix.

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

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    mapApi: { ...actual.mapApi, resolve: vi.fn(), vehicles: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getServerInfo: vi.fn(),
      getStatus: vi.fn(),
      sendCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
      getCatalogItems: vi.fn().mockRejectedValue(new Error('no catalog in test env')),
      triggerAirdrop: vi.fn(),
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getUpdateStatus = vi.mocked(updateApi.getStatus)
const mapResolve = vi.mocked(mapApi.resolve)
const mapVehicles = vi.mocked(mapApi.vehicles)
const getServerInfo = vi.mocked(panelBridgeApi.getServerInfo)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)

const testServer: ServerInstance = {
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

class StubResizeObserver {
  private cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
  }
  observe() {
    this.cb(
      [{ contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
  unobserve() {}
  disconnect() {}
}

function makeFakeSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const fake = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(cb)
      return fake
    }),
    off: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(cb)
      return fake
    }),
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((cb) => cb(...args))
    },
  }
  return fake
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderWorldMap(socket: ReturnType<typeof makeFakeSocket>) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <SocketContext.Provider value={socket as unknown as Socket}>
          <WorldMap />
        </SocketContext.Provider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function setUp() {
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
  getUpdateStatus.mockResolvedValue({} as Awaited<ReturnType<typeof updateApi.getStatus>>)
  mapResolve.mockResolvedValue({
    root: '/tiles',
    b42Dir: 'b42',
    b41Path: '/tiles/b41',
    tileSize: 1024,
    width: 1157312,
    height: 509520,
    maxLevel: 21,
    renderedMaxLevel: 10,
  })
  mapVehicles.mockResolvedValue({ vehicles: [] })
  getBridgeStatus.mockResolvedValue({ modConnected: true, modStatus: { version: '1.7.40' } } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  getResolvedActive.mockResolvedValue({ server: testServer })
}

describe('WorldMap.tsx: a stale in-flight player-position response must not repaint the map after a server switch', () => {
  it('drops an old-server response that lands after activeServerChanged, even when the gate blocks the switch-triggered refetch itself', async () => {
    await setUp()

    // Mount: resolves fast with server A's player, Alice.
    getServerInfo.mockResolvedValueOnce({ success: true, data: { players: [{ name: 'Alice', x: 10000, y: 10000 }] } } as Awaited<ReturnType<typeof panelBridgeApi.getServerInfo>>)

    const socket = makeFakeSocket()
    renderWorldMap(socket)
    await screen.findByRole('button', { name: /pan to alice/i }, { timeout: 5000 })

    // A later poll tick (still "server A" from WorldMap's own point of view)
    // fires and is held open -- stands in for a slow/degraded response that
    // hasn't come back yet when the operator switches servers.
    let resolveStalePoll: (value: Awaited<ReturnType<typeof panelBridgeApi.getServerInfo>>) => void = () => {}
    const stalePoll = new Promise<Awaited<ReturnType<typeof panelBridgeApi.getServerInfo>>>((resolve) => { resolveStalePoll = resolve })
    getServerInfo.mockImplementationOnce(() => stalePoll)
    await waitFor(() => expect(getServerInfo).toHaveBeenCalledTimes(2), { timeout: 5000 })

    // Next getServerInfo call (whichever one actually reaches the network --
    // may be the switch-triggered call, or the next natural poll tick,
    // depending on exactly when the in-flight gate releases) resolves with
    // server B's player, Bob.
    getServerInfo.mockImplementation(() => Promise.resolve({ success: true, data: { players: [{ name: 'Bob', x: 5000, y: 5000 }] } } as Awaited<ReturnType<typeof panelBridgeApi.getServerInfo>>))

    // Switch servers while the stale poll is still in flight.
    await act(async () => { socket.emit('activeServerChanged') })

    // handleActiveServerChanged clears players unconditionally up front.
    await waitFor(() => expect(screen.queryByRole('button', { name: /pan to alice/i })).toBeNull())

    // The stale call finally lands, arriving strictly after the switch.
    await act(async () => { resolveStalePoll({ success: true, data: { players: [{ name: 'Alice', x: 10000, y: 10000 }] } } as Awaited<ReturnType<typeof panelBridgeApi.getServerInfo>>) })
    // Give the (buggy, pre-fix) late apply a tick to land before asserting
    // the negative.
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('button', { name: /pan to alice/i })).toBeNull()

    // Server B's data eventually shows up (either from the switch-triggered
    // call or the next natural poll tick, both real -- POLL_INTERVAL = 3s).
    await waitFor(
      () => expect(screen.getByRole('button', { name: /pan to bob/i })).toBeInTheDocument(),
      { timeout: 6000 },
    )
    expect(screen.queryByRole('button', { name: /pan to alice/i })).toBeNull()
  }, 15000)
})
