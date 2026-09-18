import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import WorldMap, { gameTileToDzi, dziToGameTile, type MapConfig } from '../WorldMap'
import { panelBridgeApi, serversApi, updateApi, mapApi, type ServerInstance } from '@/lib/api'

// 2026-09-18, round 13 (map coordinate math). PZ's own float-position ->
// grid-square conversion is zombie.core.math.PZMath.fastfloor() (bytecode-
// confirmed against the real server jar, D:/pz-verify/server/java/
// projectzomboid.jar, javap -p -c -constants): `int t = (int) x; return (x
// < (float) t) ? t - 1 : t;` -- true floor, including negative coordinates
// (fastfloor(-0.3) === -1). WorldMap.tsx's own dziToGameTile() is an exact
// geometric inverse of gameTileToDzi() and can legitimately return a
// fractional tile position (the cursor can be anywhere inside a tile's
// diamond footprint) -- but handleContextMenu() used to store that raw
// fractional value as contextMenu.worldX/worldY, and several of its
// consumers (triggerLightningAt, createNoiseAt, callAirdrop, the repeat-
// last-drop and saved-package drop paths) sent it straight to the mod
// bridge with NO rounding at all, while others (teleportPlayerTo, the
// spawn/drop dialogs) applied their own Math.round() -- the wrong
// operation, since JS's round-half-up disagrees with PZ's own floor for
// any click in the "far" half of a tile, and diverges even further on
// negative coordinates (Math.round(-0.5) is 0, fastfloor(-0.5) is -1).
// Fixed by flooring once, where handleContextMenu builds contextMenu.

describe('gameTileToDzi / dziToGameTile: exact inverse, and floor is the correct square-selection op', () => {
  const cfg: MapConfig = {
    tileUrl: '/x',
    tileSize: 1024,
    fullWidth: 1000000,
    fullHeight: 1000000,
    maxLevel: 21,
    renderedMaxLevel: 21,
    isoX0: 500000,
    isoY0: -70000,
    isoHalfSqr: 32,
    isoQuarterSqr: 16,
    defaultCenter: { x: 0, y: 0 },
    defaultScale: 0.002,
    label: 'test',
  }

  it('round-trips exactly for an arbitrary game tile', () => {
    const dzi = gameTileToDzi(10486, 6678, cfg)
    const back = dziToGameTile(dzi.x, dzi.y, cfg)
    expect(back.x).toBeCloseTo(10486, 9)
    expect(back.y).toBeCloseTo(6678, 9)
  })

  it('a point inside a tile\'s footprint (not on the corner) yields a fractional tile position -- flooring it, not rounding, is what matches PZ\'s own square membership', () => {
    // gx=10486.6 sits past the halfway point of tile 10486's span --
    // PZ's own fastfloor() (bytecode-confirmed) assigns any x in
    // [10486, 10487) to square 10486, but JS's round-half-up would bump a
    // fractional part >= 0.5 up to 10487, a different square than the one
    // actually clicked.
    const dzi = gameTileToDzi(10486.6, 6678.3, cfg)
    const wp = dziToGameTile(dzi.x, dzi.y, cfg)

    // Exact round-trip -- confirms the projection/inverse pair itself is
    // correct and this test is really exercising the flooring question,
    // not a projection bug.
    expect(wp.x).toBeCloseTo(10486.6, 9)
    expect(wp.y).toBeCloseTo(6678.3, 9)

    expect(Number.isInteger(wp.x)).toBe(false)
    expect(Math.floor(wp.x)).toBe(10486)
    expect(Math.round(wp.x)).toBe(10487)
    expect(Math.floor(wp.x)).not.toBe(Math.round(wp.x))
  })

  it('negative coordinates: JS Math.round and PZ fastfloor disagree even on a round -0.5, floor matches fastfloor', () => {
    // Construct a DZI point whose inverse is exactly x = -0.5, y = -0.5 to
    // pin the sign-handling divergence directly (fastfloor(-0.5) === -1;
    // JS Math.round(-0.5) === -0, i.e. 0, one whole tile off).
    const dzi = gameTileToDzi(-0.5, -0.5, cfg)
    const wp = dziToGameTile(dzi.x, dzi.y, cfg)
    expect(wp.x).toBeCloseTo(-0.5, 9)
    expect(Math.floor(wp.x)).toBe(-1)
    expect(Math.round(wp.x)).toBe(-0)
  })
})

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
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    mapApi: { ...actual.mapApi, resolve: vi.fn(), vehicles: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getServerInfo: vi.fn(),
      getStatus: vi.fn(),
      sendCommand: vi.fn(),
      triggerLightning: vi.fn(),
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getUpdateStatus = vi.mocked(updateApi.getStatus)
const mapResolve = vi.mocked(mapApi.resolve)
const mapVehicles = vi.mocked(mapApi.vehicles)
const getServerInfo = vi.mocked(panelBridgeApi.getServerInfo)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const triggerLightning = vi.mocked(panelBridgeApi.triggerLightning)

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

function renderWorldMap() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <SocketContext.Provider value={null}>
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
  getResolvedActive.mockResolvedValue({ server: testServer })
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
  getServerInfo.mockResolvedValue({ success: true, data: { players: [] } } as Awaited<ReturnType<typeof panelBridgeApi.getServerInfo>>)
  getBridgeStatus.mockResolvedValue({ modConnected: true, modStatus: { version: '1.7.40' } } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  triggerLightning.mockResolvedValue({ success: true, data: {} } as Awaited<ReturnType<typeof panelBridgeApi.triggerLightning>>)
}

describe('WorldMap.tsx handleContextMenu: right-click targets a whole square, not a fractional point', () => {
  it('a world-effect action fired from a right-click always gets integer tile coordinates', async () => {
    await setUp()
    renderWorldMap()

    const canvas = await screen.findByRole('img', { name: /world map/i })
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    // An arbitrary, deliberately "off-grid" pixel -- picked to be
    // vanishingly unlikely to land exactly on a tile corner by chance, so
    // the raw geometric inverse is fractional and this test actually
    // exercises the floor.
    fireEvent.contextMenu(canvas, { clientX: 433, clientY: 287 })

    const lightningItem = await screen.findByRole('menuitem', { name: /lightning strike/i })
    fireEvent.click(lightningItem)

    await waitFor(() => expect(triggerLightning).toHaveBeenCalled())
    const [x, y] = triggerLightning.mock.calls[0]
    expect(Number.isInteger(x)).toBe(true)
    expect(Number.isInteger(y)).toBe(true)
  })
})
