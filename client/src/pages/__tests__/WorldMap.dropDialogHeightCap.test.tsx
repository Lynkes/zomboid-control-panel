import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import WorldMap from '../WorldMap'
import { panelBridgeApi, serversApi, updateApi, mapApi, type ServerInstance } from '@/lib/api'

// bug-hunt-2026-09-18 (round 4, closing a round-3 flagged gap): the Custom
// Drop dialog's own item-rows container had NO max-h/overflow -- its own
// comment said so deliberately ("NO overflow-y-auto here so the ItemPicker
// dropdown isn't clipped") -- and dropItems is user-growable up to 50 rows
// (each a full ItemPicker + qty + delete button), so nothing stopped the
// dialog itself (also uncapped) from running the Save/Drop footer buttons
// off a short viewport exactly like the four dialogs fixed in round 3.
// Verified live with Playwright at 375x667: the dialog measured 715px tall
// with even ONE row already present, overflowing top AND bottom -- adding
// rows only made it worse. Fixed at BOTH levels (round 3's convention on
// the outer DialogContent, PLUS a bound on the inner rows container so 50
// rows can't make the inner scroll region itself absurd) -- capping only
// the outer dialog would still leave a single very-long row list pushing
// the header/search bar off the top with the same effect.
//
// HONEST CAVEAT (measured, not assumed): bounding the rows container does
// reproduce the exact clipping the original comment warned about, once the
// catalog is realistically sized. ItemPicker.tsx is NOT a portal -- its
// dropdown is a plain `position: absolute` sibling inside this same
// container (confirmed by reading it) -- so with a small (~1-3 item) test
// catalog the dropdown fit inside the bounded rows container in every row
// position tried, but with a realistic 80-item catalog the dropdown (up to
// min(520px, 60vh) tall) was clipped by the rows container's cap (measured
// bounded to 288px) in EVERY row position tried (first, middle, last).
// That's a real, structural trade-off of capping this container without
// also portaling ItemPicker's own dropdown (out of scope here -- a
// different file). Not reproduced in this jsdom test (jsdom does not
// compute real layout or clipping); this comment exists so a future reader
// doesn't mistake "the footer is now reachable" for "the picker dropdown
// is never clipped."

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
      // Same simplification as WorldMap.capabilityGating.test.tsx: rejecting
      // the catalog fetch forces ItemPicker's manual-ID text-input fallback
      // deterministically, which is enough to drive the dialog's own
      // structure without needing its full autocomplete.
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
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)

const testServer: ServerInstance = {
  id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: '',
  zomboidDataPath: null, serverConfigPath: null, rconHost: '10.0.0.5', rconPort: 27015,
  rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
  useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
  adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z',
}

// Same StubResizeObserver as WorldMap.capabilityGating.test.tsx -- jsdom has
// no ResizeObserver, and WorldMap's canvas-sizing effect needs a real
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
}

describe('WorldMap -- Custom Drop dialog fits a short mobile viewport', () => {
  it('caps both the dialog and its item-rows container, and adding rows stays inside the same scrollable list', async () => {
    await setUp()
    renderWorldMap()

    await waitFor(() => expect(getBridgeStatus).toHaveBeenCalled())
    const canvas = await screen.findByRole('img', { name: /world map/i })
    fireEvent.contextMenu(canvas, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /custom drop/i }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.className).toMatch(/max-h-\[85vh\]/)
    expect(dialog.className).toMatch(/overflow-y-auto/)

    const addItemButton = within(dialog).getByRole('button', { name: /add item/i })
    const rowsContainer = addItemButton.parentElement?.previousElementSibling as HTMLElement
    expect(rowsContainer).toBeTruthy()
    expect(rowsContainer.className).toMatch(/max-h-72/)
    expect(rowsContainer.className).toMatch(/overflow-y-auto/)

    // Grow the list well past what a single screen shows -- the rows
    // container must still be the one holding all of them, not the dialog
    // silently growing unbounded again.
    for (let i = 0; i < 10; i++) await act(async () => { fireEvent.click(addItemButton) })
    const itemInputs = within(rowsContainer).getAllByPlaceholderText('e.g., Base.Axe')
    expect(itemInputs.length).toBe(11)
    expect(rowsContainer.contains(itemInputs[itemInputs.length - 1])).toBe(true)
  })
})
