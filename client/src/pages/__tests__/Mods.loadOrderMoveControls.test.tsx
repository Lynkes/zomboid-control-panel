import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi, serversApi } from '@/lib/api'

// Discord request (verbatim): "When you add a new mod which should be loaded
// first or at least in the first 5 then you need to drag the mod all the way
// up and scroll and drag... Would be nice to have a button to at least move
// it top or bottom ... Especially useful with 200+ Mods." A newly enabled mod
// is appended to the end of Mods= (see toggleModId's setOrderedModIds), so the
// common case is exactly "last row -> first slot".
//
// These tests pin the page wiring: the move controls must go through the same
// orderedModIds -> "Unsaved order changes" -> Save Order -> saveModOrder path
// as drag-and-drop, bring the moved row back into view with focus on it, act
// on the FULL list even while the list is filtered, and stay out of reach of a
// role without mods.manage (the capability the save-order route requires).

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
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
    modsApi: {
      ...actual.modsApi,
      getTrackedMods: vi.fn(),
      getStatus: vi.fn(),
      getCurrentConfig: vi.fn(),
      getIgnoredMods: vi.fn(),
      getIgnoredModPairs: vi.fn(),
      collectionDiff: vi.fn(),
      getPresets: vi.fn(),
      getCachedConflicts: vi.fn(),
      listDiskOnly: vi.fn(),
      saveModOrder: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getActive: vi.fn() },
  }
})

// jsdom doesn't implement scrollIntoView; the move controls call it to bring
// the moved row back into view.
const scrollIntoView = vi.fn()
Element.prototype.scrollIntoView = scrollIntoView

const getTrackedMods = vi.mocked(modsApi.getTrackedMods)
const getStatus = vi.mocked(modsApi.getStatus)
const getCurrentConfig = vi.mocked(modsApi.getCurrentConfig)
const getIgnoredMods = vi.mocked(modsApi.getIgnoredMods)
const getIgnoredModPairs = vi.mocked(modsApi.getIgnoredModPairs)
const collectionDiff = vi.mocked(modsApi.collectionDiff)
const getPresets = vi.mocked(modsApi.getPresets)
const getCachedConflicts = vi.mocked(modsApi.getCachedConflicts)
const listDiskOnly = vi.mocked(modsApi.listDiskOnly)
const saveModOrder = vi.mocked(modsApi.saveModOrder)
const getActive = vi.mocked(serversApi.getActive)

const MOD_IDS = ['modA', 'modB', 'modC', 'NewMod']

function primeReadMocks(modIds = MOD_IDS) {
  getTrackedMods.mockResolvedValue({ mods: [] } as never)
  getStatus.mockResolvedValue({ totalModsTracked: modIds.length, workshopAcfConfigured: false, autoRestartEnabled: false } as never)
  getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds,
    workshopIds: [],
    maps: [],
    totalMods: modIds.length,
  } as never)
  getIgnoredMods.mockResolvedValue([] as never)
  getIgnoredModPairs.mockResolvedValue([] as never)
  collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  getPresets.mockResolvedValue([] as never)
  getCachedConflicts.mockResolvedValue(null as never)
  listDiskOnly.mockResolvedValue({ mods: [] } as never)
  getActive.mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as never)
  saveModOrder.mockResolvedValue({ message: 'Mod load order saved successfully', modCount: modIds.length } as never)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  // clearAllMocks keeps queued mockReturnValueOnce values: a test that fails
  // before its held reload is consumed would hand that never-settling
  // promise to the next test. primeReadMocks re-primes all of these.
  for (const mock of [getTrackedMods, getStatus, getCurrentConfig, getIgnoredMods, getIgnoredModPairs, collectionDiff, getPresets, getCachedConflicts, listDiskOnly, saveModOrder, getActive]) {
    mock.mockReset()
  }
  mockCan = () => true
})

async function openLoadOrder() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())
  fireEvent.click(await screen.findByRole('button', { name: /load order/i }))
  await screen.findByText('NewMod')
}

// Mod IDs as the Load Order rows currently show them, top to bottom. Read
// from the rows themselves: an open Auto-sort proposal lists mod IDs too.
const shownOrder = () =>
  Array.from(document.querySelectorAll('[data-load-order-index]')).map((row) => row.querySelector('.font-mono')?.textContent)
const rowOf = (el: HTMLElement) => el.closest('[data-load-order-index]') as HTMLElement
const rowAt = (index: number) => document.querySelector(`[data-load-order-index="${index}"]`) as HTMLElement
// The Load Order tab's polite live region (toasts have role="status" too).
const loadOrderStatus = () => document.querySelector('p.sr-only[role="status"]') as HTMLElement
// Rows showing the drag-source fade.
const fadedRows = () => Array.from(document.querySelectorAll('[data-load-order-index].opacity-30'))
// fireEvent.click's default detail is 0 -- what Enter/Space on a button
// produces. A mouse click has detail 1.
const mouseClick = (el: HTMLElement) => fireEvent.click(el, { detail: 1 })

describe('Mods.tsx Load Order: move to top / bottom', () => {
  it('Move to top takes the newest mod from the last row to slot 1, and Save Order writes that order', async () => {
    primeReadMocks()
    await openLoadOrder()
    expect(screen.queryByText('Unsaved order changes')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod to the top' }))

    expect(shownOrder()).toEqual(['NewMod', 'modA', 'modB', 'modC'])
    // Same dirty state a drag produces -- nothing is written yet.
    expect(screen.getByText('Unsaved order changes')).toBeInTheDocument()
    expect(saveModOrder).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /save order/i }))
    await waitFor(() => expect(saveModOrder).toHaveBeenCalledWith(['NewMod', 'modA', 'modB', 'modC']))
  })

  it('Move to bottom sends a mod to the last slot', async () => {
    primeReadMocks()
    await openLoadOrder()

    fireEvent.click(screen.getByRole('button', { name: 'Move modA to the bottom' }))

    expect(shownOrder()).toEqual(['modB', 'modC', 'NewMod', 'modA'])
    fireEvent.click(screen.getByRole('button', { name: /save order/i }))
    await waitFor(() => expect(saveModOrder).toHaveBeenCalledWith(['modB', 'modC', 'NewMod', 'modA']))
  })

  it('scrolls the moved row into view, keeps keyboard focus on the pressed control and announces the new position', async () => {
    primeReadMocks()
    await openLoadOrder()

    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod to the top' }))

    // Now first: "Move to top" is disabled on that row, so keyboard focus
    // goes to its DisabledReason wrapper -- not to <body>, and not to a
    // control that moves the mod back down -- and the tooltip says why
    // pressing it again does nothing.
    const topControl = screen.getByRole('button', { name: 'Move NewMod to the top' })
    expect(topControl).toBeDisabled()
    expect(rowOf(topControl)).toHaveAttribute('data-load-order-index', '0')
    await waitFor(() => expect(document.activeElement).toBe(topControl.parentElement))
    expect((await screen.findAllByText('Already first in the load order')).length).toBeGreaterThan(0)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(rowOf(topControl))
    expect(loadOrderStatus()).toHaveTextContent('NewMod moved to position 1 of 4')
  })

  it('a held Enter on Move up stops at the top instead of walking the mod back down', async () => {
    primeReadMocks()
    await openLoadOrder()

    screen.getByRole('button', { name: 'Move NewMod up' }).focus()
    // Enter's key-repeat fires a click on every repeated keydown, on
    // whatever holds focus by then.
    for (let press = 0; press < 6; press++) fireEvent.click(document.activeElement as HTMLElement)

    expect(shownOrder()).toEqual(['NewMod', 'modA', 'modB', 'modC'])
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move NewMod up' }).parentElement)
  })

  it('a held Enter on Move down stops at the bottom too', async () => {
    primeReadMocks()
    await openLoadOrder()

    screen.getByRole('button', { name: 'Move modB down' }).focus()
    for (let press = 0; press < 5; press++) fireEvent.click(document.activeElement as HTMLElement)

    expect(shownOrder()).toEqual(['modA', 'modC', 'NewMod', 'modB'])
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move modB down' }).parentElement)
  })

  it('after a mouse move to either end, focuses the moved row without popping a tooltip', async () => {
    primeReadMocks()
    await openLoadOrder()

    mouseClick(screen.getByRole('button', { name: 'Move NewMod to the top' }))
    expect(shownOrder()).toEqual(['NewMod', 'modA', 'modB', 'modC'])
    await waitFor(() => expect(document.activeElement).toBe(rowAt(0)))
    expect(screen.queryByRole('tooltip')).toBeNull()

    // A double-click's second click lands after the list has scrolled, on
    // whatever control is under the pointer by then: it's ignored.
    fireEvent.click(screen.getByRole('button', { name: 'Move modC to the top' }), { detail: 2 })
    expect(shownOrder()).toEqual(['NewMod', 'modA', 'modB', 'modC'])

    mouseClick(screen.getByRole('button', { name: 'Move modA to the bottom' }))
    expect(shownOrder()).toEqual(['NewMod', 'modB', 'modC', 'modA'])
    await waitFor(() => expect(document.activeElement).toBe(rowAt(3)))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('announces a move that puts the saved order back, and marks the moved row', async () => {
    primeReadMocks()
    await openLoadOrder()

    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod up' }))
    expect(loadOrderStatus()).toHaveTextContent('NewMod moved to position 3 of 4')

    // The nudge undone: the order equals the saved one again, so the
    // unsaved bar goes away -- but the move still happened and is announced.
    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod down' }))
    expect(shownOrder()).toEqual(MOD_IDS)
    expect(screen.queryByText('Unsaved order changes')).toBeNull()
    expect(loadOrderStatus()).toHaveTextContent('NewMod moved to position 4 of 4')
    expect(rowOf(screen.getByText('NewMod'))).toHaveClass('!bg-primary/[0.055]')
  })

  it('retires the announcement and the row mark once a drag replaces that order', async () => {
    primeReadMocks()
    await openLoadOrder()

    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod to the top' }))
    expect(loadOrderStatus()).toHaveTextContent('NewMod moved to position 1 of 4')

    fireEvent.dragStart(rowOf(screen.getByText('NewMod')))
    fireEvent.dragOver(rowOf(screen.getByText('modC')))
    fireEvent.dragEnd(rowOf(screen.getByText('NewMod')))
    expect(shownOrder()).toEqual(['modA', 'modB', 'modC', 'NewMod'])
    // Not left describing an order that no longer exists...
    expect(loadOrderStatus().textContent).toBe('')
    expect(rowOf(screen.getByText('NewMod'))).not.toHaveClass('!bg-primary/[0.055]')

    // ...so the same move again changes the region and is announced again.
    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod to the top' }))
    expect(loadOrderStatus()).toHaveTextContent('NewMod moved to position 1 of 4')
  })

  it('keeps focus on the same enabled control after a one-step move, so it can be pressed again', async () => {
    primeReadMocks()
    await openLoadOrder()

    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod up' }))

    const upControl = screen.getByRole('button', { name: 'Move NewMod up' })
    expect(rowOf(upControl)).toHaveAttribute('data-load-order-index', '2')
    await waitFor(() => expect(document.activeElement).toBe(upControl))

    fireEvent.click(upControl)
    expect(shownOrder()).toEqual(['modA', 'NewMod', 'modB', 'modC'])
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move NewMod up' })))
  })

  it('Reset discards a move the same way it discards a drag', async () => {
    primeReadMocks()
    await openLoadOrder()

    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod to the top' }))
    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }))

    expect(shownOrder()).toEqual(MOD_IDS)
    expect(screen.queryByText('Unsaved order changes')).toBeNull()
  })

  it('a drag ends cleanly even though the order changed under it', async () => {
    primeReadMocks()
    await openLoadOrder()

    // The row being dragged is the one each dragover moves; it has to stay
    // the same DOM node or the browser's dragend goes to a detached node the
    // page never hears from, and the drag never ends.
    const source = rowOf(screen.getByText('NewMod'))
    fireEvent.dragStart(source)
    fireEvent.dragOver(rowOf(screen.getByText('modB')))
    expect(shownOrder()).toEqual(['modA', 'NewMod', 'modB', 'modC'])
    expect(source.isConnected).toBe(true)
    expect(fadedRows()).toEqual([source])

    fireEvent.dragEnd(source)
    expect(fadedRows()).toEqual([])
    // Nothing left to steer a later, unrelated dragover (a file, a text
    // selection) over the list.
    fireEvent.dragOver(rowAt(3))
    expect(shownOrder()).toEqual(['modA', 'NewMod', 'modB', 'modC'])
  })

  it('a drop on the list ends the drag even when dragend never arrives', async () => {
    primeReadMocks()
    await openLoadOrder()

    fireEvent.dragStart(rowOf(screen.getByText('NewMod')))
    fireEvent.dragOver(rowOf(screen.getByText('modA')))
    fireEvent.drop(rowOf(screen.getByText('modA')))
    expect(shownOrder()).toEqual(['NewMod', 'modA', 'modB', 'modC'])
    expect(fadedRows()).toEqual([])

    fireEvent.dragOver(rowAt(3))
    expect(shownOrder()).toEqual(['NewMod', 'modA', 'modB', 'modC'])
  })

  it('drag-and-drop still reorders through the same save path', async () => {
    primeReadMocks()
    await openLoadOrder()

    fireEvent.dragStart(rowOf(screen.getByText('NewMod')))
    fireEvent.dragOver(rowOf(screen.getByText('modA')))
    fireEvent.dragEnd(rowOf(screen.getByText('NewMod')))

    expect(shownOrder()).toEqual(['NewMod', 'modA', 'modB', 'modC'])
    fireEvent.click(screen.getByRole('button', { name: /save order/i }))
    await waitFor(() => expect(saveModOrder).toHaveBeenCalledWith(['NewMod', 'modA', 'modB', 'modC']))
  })

  it('locks reordering until Save Order and its reload have finished, so no move is silently overwritten', async () => {
    primeReadMocks()
    await openLoadOrder()
    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod to the top' }))

    let finishSave!: () => void
    saveModOrder.mockReturnValueOnce(new Promise((resolve) => { finishSave = () => resolve({ message: 'ok', modCount: 4 } as never) }))
    let finishReload!: () => void
    getCurrentConfig.mockReturnValueOnce(new Promise((resolve) => {
      finishReload = () => resolve({ configured: true, modIds: ['NewMod', 'modA', 'modB', 'modC'], workshopIds: [], maps: [], totalMods: 4 } as never)
    }))
    fireEvent.click(screen.getByRole('button', { name: /save order/i }))
    await waitFor(() => expect(saveModOrder).toHaveBeenCalled())

    // The save's reload replaces the order with what the server wrote, so a
    // move made before it lands would vanish -- every control is off, as
    // Auto-sort already was.
    expect(screen.getByRole('button', { name: 'Move modA to the bottom' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move modC up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /auto-sort by dependencies/i })).toBeDisabled()
    expect(rowOf(screen.getByText('modA'))).toHaveAttribute('draggable', 'false')
    fireEvent.dragStart(rowOf(screen.getByText('modC')))
    fireEvent.dragOver(rowOf(screen.getByText('NewMod')))
    expect(shownOrder()).toEqual(['NewMod', 'modA', 'modB', 'modC'])

    // Still locked once the write itself is done, while the reload is out.
    finishSave()
    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Move modA to the bottom' })).toBeDisabled()

    finishReload()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move modA to the bottom' })).toBeEnabled())
    expect(screen.queryByText('Unsaved order changes')).toBeNull()
    expect(rowOf(screen.getByText('modA'))).toHaveAttribute('draggable', 'true')
  })

  it('locks reordering while an Auto-sort proposal is open, and says so', async () => {
    primeReadMocks()
    // modA requires NewMod, which loads after it: Auto-sort proposes a change.
    getCurrentConfig.mockResolvedValue({
      configured: true,
      modIds: MOD_IDS,
      workshopIds: ['111'],
      workshopModMap: { '111': [{ id: 'modA', require: ['NewMod'] }] },
      maps: [],
      totalMods: MOD_IDS.length,
    } as never)
    await openLoadOrder()
    expect(screen.getByText('Drag or use the arrow buttons to reorder. Changes are not saved until you click Save.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /auto-sort by dependencies/i }))
    await screen.findByRole('button', { name: /^apply$/i })

    // Apply writes the proposal computed from the order as it was, so a move
    // made now would be discarded by it.
    expect(screen.getByText('Apply or cancel the proposed order below before reordering by hand.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move NewMod to the top' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move modA down' })).toBeDisabled()
    // (Rows by position: the proposal lists the mods it moves by ID too.)
    expect(rowAt(1)).toHaveAttribute('draggable', 'false')

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(screen.getByRole('button', { name: 'Move NewMod to the top' })).toBeEnabled()
    expect(rowAt(1)).toHaveAttribute('draggable', 'true')
  })

  it('a drag whose dragend was lost cannot reorder behind an open Auto-sort proposal', async () => {
    primeReadMocks()
    getCurrentConfig.mockResolvedValue({
      configured: true,
      modIds: MOD_IDS,
      workshopIds: ['111'],
      workshopModMap: { '111': [{ id: 'modA', require: ['NewMod'] }] },
      maps: [],
      totalMods: MOD_IDS.length,
    } as never)
    await openLoadOrder()

    // A drag the page never saw end (no dragend, no drop).
    fireEvent.dragStart(rowOf(screen.getByText('NewMod')))
    fireEvent.dragOver(rowOf(screen.getByText('modC')))
    expect(shownOrder()).toEqual(['modA', 'modB', 'NewMod', 'modC'])

    fireEvent.click(screen.getByRole('button', { name: /auto-sort by dependencies/i }))
    await screen.findByRole('button', { name: /^apply$/i })
    expect(fadedRows()).toEqual([])
    // Apply would write the proposal computed from the order above, so a
    // dragover now must not change it.
    fireEvent.dragOver(rowAt(0))
    expect(shownOrder()).toEqual(['modA', 'modB', 'NewMod', 'modC'])

    // The stale index is gone, not just blocked: still no reorder once the
    // proposal is cancelled.
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    fireEvent.dragOver(rowAt(0))
    expect(shownOrder()).toEqual(['modA', 'modB', 'NewMod', 'modC'])
  })

  it('stays locked until a conflict card\'s "Make X win" save and its reload have finished', async () => {
    primeReadMocks(['modA', 'modB'])
    getCurrentConfig.mockResolvedValue({ configured: true, modIds: ['modA', 'modB'], workshopIds: ['ws1', 'ws2'], maps: [], totalMods: 2 } as never)
    getCachedConflicts.mockResolvedValue({
      totalConflicts: 1,
      identicalSkipped: 0,
      pairs: [
        {
          modA: { workshopId: 'ws1', modId: 'modA', modName: 'Mod Alpha' },
          modB: { workshopId: 'ws2', modId: 'modB', modName: 'Mod Beta' },
          files: [{ file: 'media/lua/shared/Conflict.lua', category: 'lua', severity: 'high' }],
          highCount: 1,
          mediumCount: 0,
          lowCount: 0,
        },
      ],
      totalPairs: 1,
      modsScanned: 2,
      missingDeps: [],
      steamDeps: [],
      modLoadOrder: ['modA', 'modB'],
    } as never)
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Mods />
        </TooltipProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())

    // A drag the page never saw end, left over from before the save.
    fireEvent.click(await screen.findByRole('button', { name: /^load order/i }))
    fireEvent.dragStart(rowOf(await screen.findByText('modB')))

    // Same route to the button as Mods.promoteModOverOpponentServerChanged.test.tsx.
    fireEvent.click(await screen.findByRole('button', { name: /^conflicts/i }))
    const trigger = (await screen.findAllByText('Mod Alpha'))
      .map((el) => el.closest('button[data-state]'))
      .find((el): el is HTMLButtonElement => el != null)
    fireEvent.click(trigger!)
    let finishReload!: () => void
    getCurrentConfig.mockReturnValueOnce(new Promise((resolve) => {
      finishReload = () => resolve({ configured: true, modIds: ['modB', 'modA'], workshopIds: ['ws1', 'ws2'], maps: [], totalMods: 2 } as never)
    }))
    fireEvent.click(await screen.findByRole('button', { name: /make a win/i }))
    await waitFor(() => expect(saveModOrder).toHaveBeenCalledWith(['modB', 'modA']))

    fireEvent.click(await screen.findByRole('button', { name: /^load order/i }))
    await waitFor(() => expect(shownOrder()).toEqual(['modB', 'modA']))
    expect(screen.getByRole('button', { name: 'Move modA up' })).toBeDisabled()
    // The leftover drag can't reorder under the lock either.
    fireEvent.dragOver(rowAt(0))
    expect(shownOrder()).toEqual(['modB', 'modA'])

    finishReload()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move modA up' })).toBeEnabled())
  })

  it('moves within the FULL order while the list is filtered', async () => {
    primeReadMocks()
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Mods />
        </TooltipProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())
    // The filter box lives on "Active on server"; the Load Order list honours it.
    fireEvent.click(await screen.findByRole('button', { name: /^active on server/i }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Filter active mods' }), { target: { value: 'newmod' } })
    fireEvent.click(await screen.findByRole('button', { name: /load order/i }))
    await waitFor(() => expect(screen.queryByText('modA')).toBeNull())
    // The filter is set on another tab; this one says why rows are missing
    // and why there is no drag handle.
    expect(screen.getByText(/^Showing only mods matching "newmod"/)).toBeInTheDocument()
    expect(rowOf(screen.getByText('NewMod'))).toHaveAttribute('draggable', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod to the top' }))
    fireEvent.click(screen.getByRole('button', { name: /save order/i }))

    await waitFor(() => expect(saveModOrder).toHaveBeenCalledWith(['NewMod', 'modA', 'modB', 'modC']))
  })

  it('offers no reorder controls without mods.manage, and says why once', async () => {
    mockCan = (capability) => capability !== 'mods.manage'
    primeReadMocks()
    await openLoadOrder()

    expect(screen.queryByRole('button', { name: /^Move NewMod/ })).toBeNull()
    expect(screen.getByText('Your role does not have permission to manage mods.')).toBeInTheDocument()
    expect(rowOf(screen.getByText('NewMod'))).toHaveAttribute('draggable', 'false')
    // No drag handle on a row that can't be dragged.
    expect(rowOf(screen.getByText('NewMod')).querySelector('svg.lucide-grip-vertical')).toHaveClass('invisible')
    expect(screen.getByRole('button', { name: /auto-sort by dependencies/i })).toBeDisabled()

    // A drag that starts anyway (e.g. from a stale render) still can't reorder.
    fireEvent.dragStart(rowOf(screen.getByText('NewMod')))
    fireEvent.dragOver(rowOf(screen.getByText('modA')))
    expect(shownOrder()).toEqual(MOD_IDS)
  })
})
