import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi, serversApi } from '@/lib/api'

// "Create group from selection": tick mods on the Load order tab, and the group
// dialog opens with them as its members, in load order (not the order they were
// ticked), ready to be named and saved.

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))
vi.mock('@/contexts/ConfirmContext', () => ({
  useConfirm: () => vi.fn(),
  ConfirmProvider: ({ children }: { children: unknown }) => children,
}))

const auth = vi.hoisted(() => ({ canManage: true }))
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => auth.canManage,
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
      getGroups: vi.fn(),
      getGroupsStatus: vi.fn(),
      createGroup: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getActive: vi.fn() },
  }
})

Element.prototype.scrollIntoView = vi.fn()

const m = vi.mocked(modsApi)
const MOD_IDS = ['KI5Lib', 'KI5Core', 'KI5Addon', 'Unrelated']

function prime() {
  m.getTrackedMods.mockResolvedValue({ mods: [] } as never)
  m.getStatus.mockResolvedValue({ totalModsTracked: 4, workshopAcfConfigured: false, autoRestartEnabled: false } as never)
  m.getCurrentConfig.mockResolvedValue({ configured: true, modIds: MOD_IDS, workshopIds: [], maps: [], totalMods: 4 } as never)
  m.getIgnoredMods.mockResolvedValue([] as never)
  m.getIgnoredModPairs.mockResolvedValue([] as never)
  m.collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  m.getPresets.mockResolvedValue([] as never)
  m.getCachedConflicts.mockResolvedValue(null as never)
  m.listDiskOnly.mockResolvedValue({ mods: [] } as never)
  m.getGroups.mockResolvedValue({ groups: [], enforce: true })
  m.getGroupsStatus.mockResolvedValue({ groups: [], inOrder: true, conflicts: [] })
  m.createGroup.mockResolvedValue({ group: { id: 'g1', name: 'KI5', description: '', modIds: [], createdAt: '', updatedAt: '' } } as never)
  vi.mocked(serversApi.getActive).mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as never)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
  auth.canManage = true
})

async function openLoadOrder() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
  fireEvent.click(await screen.findByRole('button', { name: /load order/i }))
  await screen.findByText('Unrelated')
}

const tick = (id: string) => fireEvent.click(screen.getByRole('checkbox', { name: `Select ${id}` }))
const memberIds = () => Array.from(document.querySelectorAll('[data-member-id]')).map((el) => el.getAttribute('data-member-id'))

describe('Mods.tsx Load order: Create group from selection', () => {
  it('needs two mods, then opens the group dialog with them in load order', async () => {
    prime()
    await openLoadOrder()
    expect(screen.queryByRole('button', { name: 'Create group from selection' })).toBeNull()

    tick('KI5Addon')
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create group from selection' })).toBeDisabled()

    tick('KI5Lib') // ticked second, but earlier in the load order
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create group from selection' }))

    expect(await screen.findByRole('heading', { name: 'New mod group' })).toBeInTheDocument()
    expect(memberIds()).toEqual(['KI5Lib', 'KI5Addon'])
  })

  it('saves the group with those members and clears the selection', async () => {
    prime()
    await openLoadOrder()
    tick('KI5Core')
    tick('KI5Lib')
    fireEvent.click(screen.getByRole('button', { name: 'Create group from selection' }))
    await screen.findByRole('heading', { name: 'New mod group' })

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'KI5 Vehicles' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))

    await waitFor(() => expect(m.createGroup).toHaveBeenCalledTimes(1))
    expect(m.createGroup.mock.calls[0][0]).toMatchObject({ name: 'KI5 Vehicles', modIds: ['KI5Lib', 'KI5Core'] })
    await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull())
  })

  it('keeps the selection when the dialog is cancelled, and Clear selection empties it', async () => {
    prime()
    await openLoadOrder()
    tick('KI5Core')
    tick('KI5Lib')
    fireEvent.click(screen.getByRole('button', { name: 'Create group from selection' }))
    await screen.findByRole('heading', { name: 'New mod group' })
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'New mod group' })).toBeNull())
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    expect(m.createGroup).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.queryByText('2 selected')).toBeNull()
  })

  it('has no checkboxes without mods.manage', async () => {
    auth.canManage = false
    prime()
    await openLoadOrder()

    expect(screen.queryByRole('checkbox', { name: /^Select / })).toBeNull()
  })
})
