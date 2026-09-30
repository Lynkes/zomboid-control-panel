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
// 2026-09 community report (v1.4.0: "the panel does not appear in full
// when searching for items"): the dialog now uses the shared DialogBody
// pattern (DialogContent's own viewport bound, only the body scrolls, title
// and Cancel/Drop pinned) instead of its own 85vh cap on a dialog that
// scrolled as a whole, and ItemPicker's dropdown is a <body>-level popover
// bounded to the window (ui/popover.tsx), so neither the rows container's
// cap nor the dialog's scroll box clips it any more -- the trade-off this
// comment used to record is gone. See ItemPicker.dropdownPortal.test.tsx for
// the picker's own structure.

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
      // structure without needing its full autocomplete. The picker test
      // below resolves it instead; afterEach puts the rejection back.
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
const getCatalogItems = vi.mocked(panelBridgeApi.getCatalogItems)

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
  getCatalogItems.mockRejectedValue(new Error('no catalog in test env'))
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

const BOUND = 'max-h-[calc(100dvh-2rem)]'

async function openDropDialog() {
  await setUp()
  renderWorldMap()

  await waitFor(() => expect(getBridgeStatus).toHaveBeenCalled())
  const canvas = await screen.findByRole('img', { name: /world map/i })
  fireEvent.contextMenu(canvas, { clientX: 10, clientY: 10 })
  fireEvent.click(await screen.findByRole('menuitem', { name: /custom drop/i }))
  return screen.findByRole('dialog', { name: /custom item drop/i })
}

describe('WorldMap -- Custom Drop dialog fits a short mobile viewport', () => {
  it('uses the viewport-bounded DialogBody layout: only the body scrolls, the title and Cancel/Drop stay outside it', async () => {
    const dialog = await openDropDialog()
    // DialogContent's own bound, not a call-site cap on a dialog that
    // scrolled as a whole (and clipped the picker with it).
    expect(dialog.className).toContain(BOUND)
    expect(dialog.className).not.toMatch(/max-h-\[85vh\]/)

    const body = dialog.querySelector<HTMLElement>('[data-dialog-body]')
    expect(body).not.toBeNull()
    expect(body!.parentElement).toBe(dialog)
    expect(body!.className).toContain('min-h-0')
    expect(body!.className).toContain('overflow-y-auto')

    for (const name of [/^cancel$/i, /^drop$/i]) {
      const button = within(dialog).getByRole('button', { name })
      expect(body!.contains(button)).toBe(false)
    }
    expect(body!.contains(within(dialog).getByText('Custom item drop'))).toBe(false)
  })

  it('keeps the item rows in their own capped list inside the body as rows are added', async () => {
    const dialog = await openDropDialog()
    const body = dialog.querySelector<HTMLElement>('[data-dialog-body]')!

    const addItemButton = within(dialog).getByRole('button', { name: /add item/i })
    const rowsContainer = addItemButton.parentElement?.previousElementSibling as HTMLElement
    expect(rowsContainer).toBeTruthy()
    expect(body.contains(rowsContainer)).toBe(true)
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

  it("opens a row's item picker outside the dialog and the rows list, bounded to the window", async () => {
    getCatalogItems.mockResolvedValue({
      items: [
        { id: 'Base.Axe', name: 'Axe', category: 'WeaponPrimitive', weight: 3 },
        { id: 'Base.Bandage', name: 'Bandage', category: 'Bandage', weight: 0.1 },
      ],
      count: 2,
      scannedAt: null,
    })
    const dialog = await openDropDialog()
    const rowsContainer = within(dialog).getByRole('button', { name: /add item/i }).parentElement?.previousElementSibling as HTMLElement

    fireEvent.click(await within(dialog).findByRole('combobox', { name: 'Select item' }))
    const listbox = await screen.findByRole('listbox')
    const popover = screen.getByRole('dialog', { name: 'Select item' })

    expect(popover.contains(listbox)).toBe(true)
    expect(dialog.contains(popover)).toBe(false)
    expect(rowsContainer.contains(popover)).toBe(false)
    expect(popover.parentElement?.parentElement).toBe(document.body)
    expect(popover.className).toContain('max-h-[var(--radix-popover-content-available-height)]')

    // Picking an item fills the row and leaves the dialog open.
    fireEvent.click(screen.getByRole('option', { name: /axe/i }))
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByText('Axe')).toBeInTheDocument()
  })

  it("Escape in a row's item picker closes only the picker; the next Escape closes the dialog", async () => {
    getCatalogItems.mockResolvedValue({
      items: [{ id: 'Base.Axe', name: 'Axe', category: 'WeaponPrimitive', weight: 3 }],
      count: 1,
      scannedAt: null,
    })
    const dialog = await openDropDialog()
    const trigger = await within(dialog).findByRole('combobox', { name: 'Select item' })
    fireEvent.click(trigger)
    const popover = await screen.findByRole('dialog', { name: 'Select item' })
    const search = screen.getByRole('combobox', { name: 'Filter items' })
    await waitFor(() => expect(document.activeElement).toBe(search))

    fireEvent.keyDown(search, { key: 'Escape' })
    await waitFor(() => expect(popover).not.toBeInTheDocument())
    expect(dialog).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(trigger))

    // The dialog is a live, controlled one (this is what makes the check
    // above mean something): Escape from the trigger does close it.
    fireEvent.keyDown(trigger, { key: 'Escape' })
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
  })
})
