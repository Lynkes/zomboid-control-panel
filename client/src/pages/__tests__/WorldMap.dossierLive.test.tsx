import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import WorldMap from '../WorldMap'
import { panelBridgeApi, serversApi, updateApi, mapApi, type ServerInstance } from '@/lib/api'

// The dossier card kept the player object from the moment of the click: HP,
// position and stats never updated (after Heal the bar kept the old HP), and
// a player who logged off kept a live-looking card with working actions. It
// now follows the player by name in the polled roster. The coordinate HUD
// also printed the raw fractional cursor position (x10486.734375).

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

const getServerInfo = vi.mocked(panelBridgeApi.getServerInfo)

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

function serverInfoWith(players: Array<Record<string, unknown>>) {
  return { success: true, data: { players } } as Awaited<ReturnType<typeof panelBridgeApi.getServerInfo>>
}

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
  getServerInfo.mockResolvedValue(serverInfoWith([{ name: 'Kate', x: 10000, y: 10000, health: 40 }]))
  vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({ modConnected: true, modStatus: { version: '1.7.40' } } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
  vi.mocked(panelBridgeApi.sendCommand).mockResolvedValue({ success: true, data: {} } as Awaited<ReturnType<typeof panelBridgeApi.sendCommand>>)
}

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

async function openKatesDossier() {
  fireEvent.click(await screen.findByRole('button', { name: /pan to kate/i }, { timeout: 5000 }))
  const close = await screen.findByRole('button', { name: 'Close dossier' })
  return close.closest('div.relative') as HTMLElement
}

describe('WorldMap.tsx dossier follows the live player', () => {
  it('shows the new HP after Heal instead of the HP from the click', async () => {
    setUp()
    renderWorldMap()
    const card = await openKatesDossier()
    expect(within(card).getByText('40%')).toBeInTheDocument()

    getServerInfo.mockResolvedValue(serverInfoWith([{ name: 'Kate', x: 10010, y: 10020, health: 100 }]))
    fireEvent.click(within(card).getByRole('button', { name: /Heal/ }))

    await waitFor(() => expect(within(card).getByText('100%')).toBeInTheDocument(), { timeout: 5000 })
    expect(within(card).getByText('10010, 10020')).toBeInTheDocument()
    expect(within(card).queryByText('40%')).toBeNull()
  }, 20000)

  it('marks a player who logged off as offline and disables the actions', async () => {
    setUp()
    renderWorldMap()
    const card = await openKatesDossier()

    getServerInfo.mockResolvedValue(serverInfoWith([]))
    // The next poll (every 3 s) finds nobody online.
    await waitFor(() => expect(within(card).getByText('Offline')).toBeInTheDocument(), { timeout: 8000 })
    expect(within(card).getByText('This player is no longer online.')).toBeInTheDocument()
    expect(within(card).getByText('Kate')).toBeInTheDocument()
    expect(within(card).queryByText('40%')).toBeNull()
    expect(within(card).getByRole('button', { name: /Heal/ })).toBeDisabled()
    // The way to the player's other controls stays: Players knows them offline too.
    expect(within(card).getByRole('link', { name: 'Open player controls' })).toHaveAttribute('href', '/players?player=Kate')
  }, 20000)

  it('prints whole squares in the coordinate HUD, never the fractional cursor position', async () => {
    setUp()
    const { container } = renderWorldMap()
    await screen.findByRole('button', { name: /pan to kate/i }, { timeout: 5000 })
    const canvas = screen.getByRole('img', { name: /world map/i })
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
    })

    fireEvent.mouseMove(canvas, { clientX: 403, clientY: 297 })

    const hud = await waitFor(() => {
      const span = Array.from(container.querySelectorAll('span.text-foreground'))
        .find((el) => /^x[\s\d.-]+·y/.test(el.textContent ?? ''))
      expect(span).toBeTruthy()
      return span!
    })
    expect(hud.textContent).toMatch(/^x\s*-?\d+·y\s*-?\d+$/)
  }, 20000)
})
