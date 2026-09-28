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

    // Now first: "Move to top" is disabled on that row, so focus lands on the
    // DisabledReason wrapper around it (which explains why), not on <body>.
    const topControl = screen.getByRole('button', { name: 'Move NewMod to the top' })
    expect(topControl).toBeDisabled()
    expect(rowOf(topControl)).toHaveAttribute('data-load-order-index', '0')
    await waitFor(() => expect(document.activeElement).toBe(topControl.parentElement))
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(rowOf(topControl))
    expect(screen.getByText('NewMod moved to position 1 of 4')).toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: /auto-sort by dependencies/i })).toBeDisabled()

    // A drag that starts anyway (e.g. from a stale render) still can't reorder.
    fireEvent.dragStart(rowOf(screen.getByText('NewMod')))
    fireEvent.dragOver(rowOf(screen.getByText('modA')))
    expect(shownOrder()).toEqual(MOD_IDS)
  })
})
