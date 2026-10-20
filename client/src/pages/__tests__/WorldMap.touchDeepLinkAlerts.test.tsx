import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import WorldMap from '../WorldMap'
import { panelBridgeApi, serversApi, updateApi, mapApi, type ServerInstance } from '@/lib/api'

// World Map, slice C of the UX restructure:
// - touch screens had no way to the map's action menu (iOS sends no
//   contextmenu event): a long press now opens it, a drag doesn't;
// - Players -> "Show on map" lands on the player (?player=);
// - a bridge that is down says so above the map and links to the fix.

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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function setUp({ bridgeUp = true, players = [{ name: 'Kate', x: 10000, y: 10000, health: 40 }] }: {
  bridgeUp?: boolean
  players?: Array<Record<string, unknown>>
} = {}) {
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
  vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server: testServer })
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
  vi.mocked(mapApi.vehicles).mockResolvedValue({ vehicles: [] })
  if (bridgeUp) {
    vi.mocked(panelBridgeApi.getServerInfo).mockResolvedValue(
      { success: true, data: { players } } as Awaited<ReturnType<typeof panelBridgeApi.getServerInfo>>,
    )
    vi.mocked(panelBridgeApi.getStatus).mockResolvedValue(
      { modConnected: true, modStatus: { version: '1.7.40' } } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>,
    )
  } else {
    vi.mocked(panelBridgeApi.getServerInfo).mockRejectedValue(new Error('bridge down'))
    vi.mocked(panelBridgeApi.getStatus).mockResolvedValue(
      { modConnected: false } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>,
    )
  }
  vi.mocked(panelBridgeApi.sendCommand).mockResolvedValue({ success: true, data: {} } as Awaited<ReturnType<typeof panelBridgeApi.sendCommand>>)
}

function renderWorldMap(path = '/world-map') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TooltipProvider>
        <SocketContext.Provider value={null}>
          <WorldMap />
        </SocketContext.Provider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function mapCanvas() {
  const canvas = await screen.findByRole('img', { name: /world map/i })
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
  })
  return canvas
}

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))

describe('WorldMap.tsx on a touch screen', () => {
  it('opens the map actions menu after a 500 ms press, at the pressed square', async () => {
    setUp()
    renderWorldMap()
    await screen.findByRole('button', { name: /pan to kate/i }, { timeout: 5000 })
    const canvas = await mapCanvas()

    fireEvent.touchStart(canvas, { touches: [{ clientX: 120, clientY: 140 }] })
    await wait(200)
    expect(screen.queryByRole('menu')).toBeNull()

    const menu = await screen.findByRole('menu', { name: 'Map actions' }, { timeout: 2000 })
    expect(within(menu).getByRole('menuitem', { name: /lightning strike/i })).toBeInTheDocument()

    // Lifting the finger is not a tap: the menu stays and no player is picked.
    fireEvent.touchEnd(canvas, { touches: [], changedTouches: [{ clientX: 120, clientY: 140 }] })
    expect(screen.getByRole('menu', { name: 'Map actions' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close dossier' })).toBeNull()
  }, 20000)

  it('does not open the menu when the finger moves more than 8 px (that is a pan)', async () => {
    setUp()
    renderWorldMap()
    await screen.findByRole('button', { name: /pan to kate/i }, { timeout: 5000 })
    const canvas = await mapCanvas()

    fireEvent.touchStart(canvas, { touches: [{ clientX: 120, clientY: 140 }] })
    fireEvent.touchMove(canvas, { touches: [{ clientX: 135, clientY: 140 }] })
    await wait(800)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.touchEnd(canvas, { touches: [], changedTouches: [{ clientX: 135, clientY: 140 }] })
  }, 20000)

  it('does not open the menu for a quick tap', async () => {
    setUp()
    renderWorldMap()
    await screen.findByRole('button', { name: /pan to kate/i }, { timeout: 5000 })
    const canvas = await mapCanvas()

    fireEvent.touchStart(canvas, { touches: [{ clientX: 120, clientY: 140 }] })
    fireEvent.touchEnd(canvas, { touches: [], changedTouches: [{ clientX: 120, clientY: 140 }] })
    await wait(800)
    expect(screen.queryByRole('menu')).toBeNull()
  }, 20000)
})

describe('WorldMap.tsx deep links', () => {
  it('?player= opens that player (names match case-insensitively) without a click', async () => {
    setUp()
    renderWorldMap('/world-map?player=kate')

    const close = await screen.findByRole('button', { name: 'Close dossier' }, { timeout: 5000 })
    const card = close.closest('div.relative') as HTMLElement
    expect(within(card).getByText('Kate')).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Open player controls' })).toHaveAttribute('href', '/players?player=Kate')
  }, 20000)

  it('?player= for someone not on the map says so and links to the Players page', async () => {
    setUp()
    renderWorldMap('/world-map?player=Nobody')

    await screen.findByRole('button', { name: /pan to kate/i }, { timeout: 5000 })
    expect(await screen.findByText("Nobody isn't on the map")).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open in Players' })).toHaveAttribute('href', '/players?player=Nobody')
    expect(screen.queryByRole('button', { name: 'Close dossier' })).toBeNull()
  }, 20000)
})

describe('WorldMap.tsx page alerts', () => {
  it('a bridge that is down gets a page alert that links to Settings › PanelBridge', async () => {
    setUp({ bridgeUp: false })
    renderWorldMap()

    expect(await screen.findByText('PanelBridge is offline', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Set up PanelBridge' })).toHaveAttribute('href', '/settings?tab=bridge')
  }, 20000)

  it('no alert while the bridge is up', async () => {
    setUp()
    renderWorldMap()

    await screen.findByRole('button', { name: /pan to kate/i }, { timeout: 5000 })
    expect(screen.queryByText('PanelBridge is offline')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Set up PanelBridge' })).toBeNull()
  }, 20000)
})
