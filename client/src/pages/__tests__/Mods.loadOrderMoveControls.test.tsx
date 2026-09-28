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

// Mod IDs as the Load Order rows currently show them, top to bottom.
const shownOrder = () => screen.getAllByText(/^(modA|modB|modC|NewMod)$/).map((el) => el.textContent)
const rowOf = (el: HTMLElement) => el.closest('[data-load-order-index]') as HTMLElement
const rowAt = (index: number) => document.querySelector(`[data-load-order-index="${index}"]`) as HTMLElement
// The Load Order tab's polite live region (toasts have role="status" too).
const loadOrderStatus = () => document.querySelector('p.sr-only[role="status"]') as HTMLElement

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

  it('scrolls the moved row into view, keeps focus on it and announces the new position', async () => {
    primeReadMocks()
    await openLoadOrder()

    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod to the top' }))

    // Now first: "Move to top" is disabled on that row, so focus goes to the
    // nearest control on it that still does something -- not to <body>, and
    // not to the disabled control's DisabledReason wrapper, whose "Already
    // first" tooltip would pop open right after a successful move.
    const topControl = screen.getByRole('button', { name: 'Move NewMod to the top' })
    expect(topControl).toBeDisabled()
    expect(rowOf(topControl)).toHaveAttribute('data-load-order-index', '0')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move NewMod down' })))
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(rowOf(topControl))
    expect(loadOrderStatus()).toHaveTextContent('NewMod moved to position 1 of 4')
  })

  it('after reaching either end, focuses the control that moves back the other way', async () => {
    primeReadMocks()
    await openLoadOrder()

    // A one-step move into the first slot disables the pressed control too.
    fireEvent.click(screen.getByRole('button', { name: 'Move modB up' }))
    expect(shownOrder()).toEqual(['modB', 'modA', 'modC', 'NewMod'])
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move modB down' })))

    fireEvent.click(screen.getByRole('button', { name: 'Move modB to the bottom' }))
    expect(shownOrder()).toEqual(['modA', 'modC', 'NewMod', 'modB'])
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move modB up' })))
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
