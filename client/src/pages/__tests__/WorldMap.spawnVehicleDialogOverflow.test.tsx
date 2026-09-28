import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import WorldMap from '../WorldMap'
import { panelBridgeApi, serversApi, updateApi, mapApi, type ServerInstance } from '@/lib/api'

// 2026-09 dialog viewport sweep: DialogContent now defaults to
// overflow-y-auto (so no dialog can run its buttons off a short window),
// which makes every dialog a clipping box for its absolutely positioned
// descendants. VehiclePicker's dropdown is exactly that -- a plain
// `absolute top-full`/`bottom-full` panel (~400px: search, a 320px list, a
// footer), not a portal -- and the Spawn Vehicle dialog around it is only
// ~200px tall, so under the new default the vehicle list would be cut off at
// the dialog's edge (measured in headless Chromium at 1366x650: the part of
// the list outside the dialog stopped hit-testing in both drop directions).
// The dialog opts back out with overflow-visible; this pins that opt-out and
// that the panel really renders inside the dialog (jsdom can't measure the
// clipping itself).

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
      getCatalogVehicles: vi.fn(),
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getUpdateStatus = vi.mocked(updateApi.getStatus)
const mapResolve = vi.mocked(mapApi.resolve)
const mapVehicles = vi.mocked(mapApi.vehicles)
const getServerInfo = vi.mocked(panelBridgeApi.getServerInfo)
const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)
const getCatalogVehicles = vi.mocked(panelBridgeApi.getCatalogVehicles)

const testServer: ServerInstance = {
  id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: '',
  zomboidDataPath: null, serverConfigPath: null, rconHost: '10.0.0.5', rconPort: 27015,
  rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
  useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
  adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z',
}

// Same StubResizeObserver as WorldMap.dropDialogHeightCap.test.tsx -- jsdom
// has no ResizeObserver, and WorldMap's canvas-sizing effect needs a real
// non-zero contentRect.
class StubResizeObserver {
  private cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.cb = cb }
  observe() {
    this.cb([{ contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('WorldMap -- Spawn Vehicle dialog does not clip its vehicle dropdown', () => {
  it('opts out of the DialogContent scroll container, and the open vehicle list renders inside the dialog', async () => {
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }))
    getResolvedActive.mockResolvedValue({ server: testServer })
    getUpdateStatus.mockResolvedValue({} as Awaited<ReturnType<typeof updateApi.getStatus>>)
    mapResolve.mockResolvedValue({
      root: '/tiles', b42Dir: 'b42', b41Path: '/tiles/b41', tileSize: 1024,
      width: 1157312, height: 509520, maxLevel: 21, renderedMaxLevel: 10,
    })
    mapVehicles.mockResolvedValue({ vehicles: [] })
    getServerInfo.mockResolvedValue({ success: true, data: { players: [] } } as Awaited<ReturnType<typeof panelBridgeApi.getServerInfo>>)
    getBridgeStatus.mockResolvedValue({ modConnected: true, modStatus: { version: '1.7.40' } } as Awaited<ReturnType<typeof panelBridgeApi.getStatus>>)
    sendCommand.mockResolvedValue({ success: true, data: {} } as Awaited<ReturnType<typeof panelBridgeApi.sendCommand>>)
    getCatalogVehicles.mockResolvedValue({
      vehicles: [
        { id: 'Base.CarNormal', name: 'Sedan', mass: 1200, seats: 4 },
        { id: 'Base.PickUpTruck', name: 'Pickup', mass: 1800, seats: 2 },
      ],
      count: 2,
      scannedAt: null,
    })

    render(
      <MemoryRouter>
        <TooltipProvider>
          <SocketContext.Provider value={null}>
            <WorldMap />
          </SocketContext.Provider>
        </TooltipProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(getBridgeStatus).toHaveBeenCalled())
    const canvas = await screen.findByRole('img', { name: /world map/i })
    fireEvent.contextMenu(canvas, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /spawn vehicle here/i }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.className).toContain('overflow-visible')
    expect(dialog.className).not.toContain('overflow-y-auto')

    fireEvent.click(await within(dialog).findByRole('combobox'))
    const listbox = await within(dialog).findByRole('listbox')
    expect(dialog.contains(listbox)).toBe(true)
    expect(within(listbox).getByText('Sedan')).toBeInTheDocument()
  })
})
