import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi, serversApi } from '@/lib/api'

// Mod groups on the Load order tab: the panel mounts there (and only there), and
// POST /mods/save-order may answer that the server moved group members back into
// their group order (groupsAdjusted): the admin is told, and the list shows the
// order the server wrote, not the one that was on screen.

const toastSpy = vi.hoisted(() => vi.fn())
const confirmSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))
vi.mock('@/contexts/ConfirmContext', () => ({
  useConfirm: () => confirmSpy,
  ConfirmProvider: ({ children }: { children: unknown }) => children,
}))

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
      getGroups: vi.fn(),
      getGroupsStatus: vi.fn(),
      applyGroups: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getActive: vi.fn() },
  }
})

// jsdom doesn't implement scrollIntoView; the move controls call it.
Element.prototype.scrollIntoView = vi.fn()

const m = vi.mocked(modsApi)
const getActive = vi.mocked(serversApi.getActive)

const MOD_IDS = ['modA', 'modB', 'modC', 'NewMod']
const STAMP = '2026-10-01T00:00:00.000Z'
const GROUP = {
  id: 'g1',
  name: 'Library first',
  description: 'The library has to load before the mods that use it',
  modIds: ['NewMod', 'modA'],
  createdAt: STAMP,
  updatedAt: STAMP,
}

function prime(groupsInOrder = true) {
  m.getTrackedMods.mockResolvedValue({ mods: [] } as never)
  m.getStatus.mockResolvedValue({ totalModsTracked: 4, workshopAcfConfigured: false, autoRestartEnabled: false } as never)
  m.getCurrentConfig.mockResolvedValue({ configured: true, modIds: MOD_IDS, workshopIds: [], maps: [], totalMods: 4 } as never)
  m.getIgnoredMods.mockResolvedValue([] as never)
  m.getIgnoredModPairs.mockResolvedValue([] as never)
  m.collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  m.getPresets.mockResolvedValue([] as never)
  m.getCachedConflicts.mockResolvedValue(null as never)
  m.listDiskOnly.mockResolvedValue({ mods: [] } as never)
  m.saveModOrder.mockResolvedValue({ message: 'Mod load order saved successfully', modCount: 4 } as never)
  m.getGroups.mockResolvedValue({ groups: [GROUP], enforce: true })
  m.getGroupsStatus.mockResolvedValue({
    groups: [{ id: 'g1', inOrder: groupsInOrder, present: 2, total: 2, missing: [] }],
    inOrder: groupsInOrder,
    conflicts: [],
  })
  getActive.mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as never)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  for (const mock of [m.getTrackedMods, m.getStatus, m.getCurrentConfig, m.getIgnoredMods, m.getIgnoredModPairs, m.collectionDiff, m.getPresets, m.getCachedConflicts, m.listDiskOnly, m.saveModOrder, m.getGroups, m.getGroupsStatus, m.applyGroups, getActive]) {
    mock.mockReset()
  }
  confirmSpy.mockReset()
  localStorage.clear()
})

function renderMods() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function openLoadOrder() {
  renderMods()
  await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
  fireEvent.click(await screen.findByRole('button', { name: /load order/i }))
  await screen.findByText('NewMod')
}

const shownOrder = () =>
  Array.from(document.querySelectorAll('[data-load-order-index]')).map((row) => row.querySelector('.font-mono')?.textContent)
const toastTitles = () => toastSpy.mock.calls.map((call) => call[0]?.title)

describe('Mods.tsx Load order: Mod groups panel', () => {
  it('mounts on the Load order tab with the groups and their status, and not on the other tabs', async () => {
    prime(false)
    renderMods()
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
    await screen.findByRole('button', { name: /load order/i })
    expect(screen.queryByRole('button', { name: /^Mod groups/ })).toBeNull()
    // The page reads the groups once for every view (colour dots, Groups view).
    await waitFor(() => expect(m.getGroups).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: /load order/i }))

    expect(await screen.findByText('Library first')).toBeInTheDocument()
    // The panel uses the page's groups: no second read.
    expect(m.getGroups).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /^Mod groups/ })).toHaveAttribute('aria-expanded', 'true')
    // On the group's row (the panel's header says it too).
    const row = screen.getByText('Library first').closest('li') as HTMLElement
    expect(await within(row).findByText('Out of order')).toBeInTheDocument()
    expect(within(row).getByText('2 of 2 on this server')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Keep group order when saving the load order' })).toBeChecked()
    // The list below it is unchanged.
    expect(shownOrder()).toEqual(MOD_IDS)
  })

  it('does not break the load order list when the groups cannot be loaded', async () => {
    prime()
    m.getGroups.mockRejectedValue(new Error('Not found'))
    await openLoadOrder()

    expect(await screen.findByText('Mod groups could not be loaded.')).toBeInTheDocument()
    expect(shownOrder()).toEqual(MOD_IDS)
    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod to the top' }))
    expect(shownOrder()).toEqual(['NewMod', 'modA', 'modB', 'modC'])
  })

  it('Apply group order is off while the list has unsaved moves', async () => {
    prime(false)
    await openLoadOrder()
    await screen.findByText('Library first')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply group order' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod to the top' }))

    expect(screen.getByRole('button', { name: 'Apply group order' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^discard$/i }))
    expect(screen.getByRole('button', { name: 'Apply group order' })).toBeEnabled()
  })

  it('Apply group order writes through the server and reloads the list with the new order', async () => {
    prime(false)
    m.applyGroups.mockImplementation(async (preview) => ({
      changed: true,
      moved: ['NewMod', 'modA', 'modB', 'modC'],
      order: ['NewMod', 'modA', 'modB', 'modC'],
      written: !preview,
      conflicts: [],
    }))
    confirmSpy.mockResolvedValue(true)
    await openLoadOrder()
    await screen.findByText('Library first')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply group order' })).toBeEnabled())
    m.getCurrentConfig.mockResolvedValue({ configured: true, modIds: ['NewMod', 'modA', 'modB', 'modC'], workshopIds: [], maps: [], totalMods: 4 } as never)

    fireEvent.click(screen.getByRole('button', { name: 'Apply group order' }))

    await waitFor(() => expect(m.applyGroups).toHaveBeenCalledWith(false))
    await waitFor(() => expect(shownOrder()).toEqual(['NewMod', 'modA', 'modB', 'modC']))
    expect(toastTitles()).toContain('Group order applied')
  })
})

describe('Mods.tsx Load order: Save Order with groups', () => {
  it('warns when the server moved group members, and shows the order it wrote', async () => {
    prime()
    await openLoadOrder()
    await screen.findByText('Library first')
    // Moved NewMod to the top; the server keeps modA below it too and puts modC
    // back after modB, which the admin did not ask for.
    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod to the top' }))
    m.saveModOrder.mockResolvedValue({
      message: 'Mod load order saved successfully',
      modCount: 4,
      groupsAdjusted: ['modA', 'modC'],
      groupConflicts: [],
    } as never)
    m.getCurrentConfig.mockResolvedValue({ configured: true, modIds: ['NewMod', 'modA', 'modB', 'modC'], workshopIds: [], maps: [], totalMods: 4 } as never)
    const statusCalls = m.getGroupsStatus.mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: /save order/i }))

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Group order kept: 2 mods were moved',
      variant: 'warning',
    })))
    // The plain "saved" toast is still shown.
    expect(toastTitles()).toContain('Mod Order Saved')
    // The list is the order the server wrote...
    await waitFor(() => expect(shownOrder()).toEqual(['NewMod', 'modA', 'modB', 'modC']))
    expect(screen.queryByText('Unsaved changes')).toBeNull()
    // ...and the groups' status was read again against it.
    await waitFor(() => expect(m.getGroupsStatus.mock.calls.length).toBeGreaterThan(statusCalls))
  })

  it('uses the singular for one moved mod', async () => {
    prime()
    await openLoadOrder()
    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod to the top' }))
    m.saveModOrder.mockResolvedValue({ modCount: 4, groupsAdjusted: ['modA'], groupConflicts: [] } as never)

    fireEvent.click(screen.getByRole('button', { name: /save order/i }))

    await waitFor(() => expect(toastTitles()).toContain('Group order kept: 1 mod was moved'))
  })

  it('stays quiet when the server saved the order exactly as sent', async () => {
    prime()
    await openLoadOrder()
    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod to the top' }))
    m.saveModOrder.mockResolvedValue({ modCount: 4, groupsAdjusted: [], groupConflicts: [] } as never)

    fireEvent.click(screen.getByRole('button', { name: /save order/i }))

    await waitFor(() => expect(m.saveModOrder).toHaveBeenCalledWith(['NewMod', 'modA', 'modB', 'modC']))
    await waitFor(() => expect(toastTitles()).toContain('Mod Order Saved'))
    expect(toastTitles().filter((title) => typeof title === 'string' && title.startsWith('Group order kept'))).toEqual([])
  })

  it('stays quiet for an older server whose answer has no group fields', async () => {
    prime()
    await openLoadOrder()
    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod to the top' }))

    fireEvent.click(screen.getByRole('button', { name: /save order/i }))

    await waitFor(() => expect(toastTitles()).toContain('Mod Order Saved'))
    expect(toastTitles().filter((title) => typeof title === 'string' && /group/i.test(title))).toEqual([])
  })

  it('names the contradicting groups when the server could not satisfy them all', async () => {
    prime()
    await openLoadOrder()
    fireEvent.click(screen.getByRole('button', { name: 'Move NewMod to the top' }))
    m.saveModOrder.mockResolvedValue({ modCount: 4, groupsAdjusted: [], groupConflicts: ['Library first', 'Other group'] } as never)

    fireEvent.click(screen.getByRole('button', { name: /save order/i }))

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Mod groups contradict each other',
      description: expect.stringContaining('Library first, Other group'),
      variant: 'warning',
    })))
  })
})
