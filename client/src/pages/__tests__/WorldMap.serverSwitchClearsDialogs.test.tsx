import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import WorldMap from '../WorldMap'
import { panelBridgeApi, serversApi, updateApi, mapApi, type ServerInstance } from '@/lib/api'

// A dialog opened on the World Map belongs to the server it was opened for.
// The activeServerChanged handler cleared players, vehicles and the context
// menu but not the Remove vehicle confirm (or the spawn/drop dialogs): left
// open across a server switch, its confirm sent the OLD server's vehicle id
// to the NEW server, deleting whatever vehicle has that id there.

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
      sendCommand: vi.fn(),
      getCatalogItems: vi.fn().mockRejectedValue(new Error('no catalog in test env')),
      triggerAirdrop: vi.fn(),
    },
  }
})

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

function setUp() {
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
  vi.mocked(updateApi.getStatus).mockResolvedValue({} as Awaited<ReturnType<typeof updateApi.getStatus>>)
  vi.mocked(mapApi.resolve).mockResolvedValue({
    root: '/tiles',
    b42Dir: 'b42',
    b41Path: '/tiles/b41',
    tileSize: 1024,
    width: 1157312,
    height: 509520,
    maxLevel: 21,
    renderedMaxLevel: 10,
  })
  // A player, and a vehicle 300 squares further along both axes: once the
  // view is centred on the player at 0.02 px per map pixel (panToKate), the
  // vehicle sits 600 * 16 * 0.02 = 192 px straight below the centre, clear
  // of the player's marker.
  vi.mocked(mapApi.vehicles).mockResolvedValue({ vehicles: [] } as Awaited<ReturnType<typeof mapApi.vehicles>>)
  vi.mocked(panelBridgeApi.getServerInfo).mockResolvedValue({ success: true, data: { players: [{ name: 'Kate', x: 10000, y: 10000 }] } } as Awaited<ReturnType<typeof panelBridgeApi.getServerInfo>>)
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({ modConnected: true, modStatus: { version: '1.7.40' } } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  vi.mocked(panelBridgeApi.sendCommand).mockImplementation(async (action: string) => (
    action === 'getVehiclesDetailed'
      ? { success: true, data: { vehicles: [{ id: 42, x: 10300, y: 10300, type: 'Van' }] } }
      : { success: true, data: {} }
  ) as Awaited<ReturnType<typeof panelBridgeApi.sendCommand>>)
  vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server: testServer })
}

// The context menu, queried within itself: role queries over the whole map
// page are slow enough to time out.
async function openMenuItem(canvas: HTMLElement, at: { x: number; y: number }, name: RegExp) {
  fireEvent.contextMenu(canvas, { clientX: at.x, clientY: at.y })
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByRole('menuitem', { name }))
}

async function renderReadyMap() {
  const socket = makeFakeSocket()
  render(
    <MemoryRouter>
      <TooltipProvider>
        <SocketContext.Provider value={socket as unknown as Socket}>
          <WorldMap />
        </SocketContext.Provider>
      </TooltipProvider>
    </MemoryRouter>,
  )
  await screen.findByRole('button', { name: /pan to kate/i }, { timeout: 5000 })
  await screen.findByRole('button', { name: 'Hide vehicles (1 loaded)' }, { timeout: 5000 })
  // Map detection re-centres the view when it finishes; wait for it.
  const search = screen.getByRole('textbox', { name: 'Search map places' })
  await waitFor(() => expect(search).toBeEnabled(), { timeout: 5000 })
  const canvas = screen.getByRole('img', { name: /world map/i })
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
  })
  return { socket, canvas }
}

describe('WorldMap.tsx: dialogs opened for one server close when the active server changes', () => {
  it('closes an open Remove vehicle confirm, so it cannot delete a vehicle on the new server', async () => {
    setUp()
    const { socket, canvas } = await renderReadyMap()

    // A known view, whichever of the auto-fit and the detection re-centre
    // landed last.
    fireEvent.click(screen.getByRole('button', { name: /pan to kate/i }))
    await openMenuItem(canvas, { x: 400, y: 492 }, /Remove vehicle/)
    expect(await screen.findByText('Remove vehicle?')).toBeInTheDocument()

    await act(async () => { socket.emit('activeServerChanged') })

    await waitFor(() => expect(screen.queryByText('Remove vehicle?')).toBeNull())
    expect(panelBridgeApi.sendCommand).not.toHaveBeenCalledWith('removeVehicle', expect.anything())
  }, 20000)

  it('closes the spawn-vehicle and custom-drop dialogs', async () => {
    setUp()
    const { socket, canvas } = await renderReadyMap()

    await openMenuItem(canvas, { x: 100, y: 100 }, /Spawn vehicle here/)
    expect(await screen.findByText('Spawn Vehicle')).toBeInTheDocument()
    await act(async () => { socket.emit('activeServerChanged') })
    await waitFor(() => expect(screen.queryByText('Spawn Vehicle')).toBeNull())

    await screen.findByRole('button', { name: /pan to kate/i }, { timeout: 5000 })
    await openMenuItem(canvas, { x: 100, y: 100 }, /Custom drop/)
    expect(await screen.findByText('Custom item drop')).toBeInTheDocument()
    await act(async () => { socket.emit('activeServerChanged') })
    await waitFor(() => expect(screen.queryByText('Custom item drop')).toBeNull())
  }, 20000)
})
