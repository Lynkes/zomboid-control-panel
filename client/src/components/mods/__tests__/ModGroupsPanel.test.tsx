import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ModGroupsPanel, type ModGroupsPanelProps } from '../ModGroupsPanel'
import { modsApi, type ModGroup, type ModGroupsStatus } from '@/lib/api'

// The "Mod groups" panel on the Mod Manager's Load order tab: groups with their
// in-order status, create / edit, Apply group order (preview, then confirm),
// Export, Import, Delete and the "keep group order when saving" switch. The API
// is mocked at modsApi; downloads, toasts and the confirm dialog are spies.

const toastSpy = vi.hoisted(() => vi.fn())
const confirmSpy = vi.hoisted(() => vi.fn())
const downloadSpy = vi.hoisted(() => vi.fn())

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))
vi.mock('@/contexts/ConfirmContext', () => ({
  useConfirm: () => confirmSpy,
  ConfirmProvider: ({ children }: { children: unknown }) => children,
}))
vi.mock('@/lib/modGroups', async () => {
  const actual = await vi.importActual<typeof import('@/lib/modGroups')>('@/lib/modGroups')
  return { ...actual, downloadJsonFile: downloadSpy }
})
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    modsApi: {
      ...actual.modsApi,
      getGroups: vi.fn(),
      getGroupsStatus: vi.fn(),
      createGroup: vi.fn(),
      updateGroup: vi.fn(),
      deleteGroup: vi.fn(),
      importGroup: vi.fn(),
      applyGroups: vi.fn(),
      setGroupsEnforce: vi.fn(),
    },
  }
})

const m = vi.mocked(modsApi)

const STAMP = '2026-10-01T00:00:00.000Z'
const KI5: ModGroup = {
  id: 'g1',
  name: 'KI5 Vehicles',
  description: 'Library, core, add-ons, fixes',
  modIds: ['KI5Lib', 'KI5Core', 'KI5Addon', 'KI5Fix'],
  createdAt: STAMP,
  updatedAt: STAMP,
}
const WEAPONS: ModGroup = {
  id: 'g2',
  name: 'Weapons',
  description: '',
  modIds: ['Brita', 'Arsenal'],
  createdAt: STAMP,
  updatedAt: STAMP,
}
const STATUS: ModGroupsStatus = {
  groups: [
    { id: 'g1', inOrder: false, present: 3, total: 4, missing: ['KI5Fix'] },
    { id: 'g2', inOrder: true, present: 2, total: 2, missing: [] },
  ],
  inOrder: false,
  conflicts: [],
}
const SERVER_MODS = ['KI5Core', 'KI5Lib', 'KI5Addon', 'Brita', 'Arsenal', 'Other']

function prime(groups: ModGroup[] = [KI5, WEAPONS], status: ModGroupsStatus = STATUS, enforce = false) {
  m.getGroups.mockResolvedValue({ groups, enforce })
  m.getGroupsStatus.mockResolvedValue(status)
  m.createGroup.mockResolvedValue({ group: KI5 })
  m.updateGroup.mockResolvedValue({ group: KI5 })
  m.deleteGroup.mockResolvedValue({ success: true })
  m.importGroup.mockResolvedValue({ group: { ...WEAPONS, id: 'g9', name: 'Imported' } })
  m.setGroupsEnforce.mockImplementation(async (on) => ({ enforce: on }))
}

const onOrderApplied = vi.fn()

function panelProps(overrides: Partial<ModGroupsPanelProps> = {}): ModGroupsPanelProps {
  return {
    canManage: true,
    serverModIds: SERVER_MODS,
    modNames: { KI5Lib: 'KI5 Library' },
    savedModIds: SERVER_MODS,
    orderDirty: false,
    orderSaving: false,
    onOrderApplied,
    ...overrides,
  }
}

function renderPanel(overrides: Partial<ModGroupsPanelProps> = {}) {
  const view = render(
    <TooltipProvider>
      <ModGroupsPanel {...panelProps(overrides)} />
    </TooltipProvider>,
  )
  return {
    ...view,
    rerenderPanel: (next: Partial<ModGroupsPanelProps>) =>
      view.rerender(
        <TooltipProvider>
          <ModGroupsPanel {...panelProps(next)} />
        </TooltipProvider>,
      ),
  }
}

const button = (name: string | RegExp) => screen.getByRole('button', { name })
const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement
const groupRow = (name: string) => screen.getByText(name).closest('li') as HTMLElement
const toastTitles = () => toastSpy.mock.calls.map((call) => call[0]?.title)

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  for (const fn of [m.getGroups, m.getGroupsStatus, m.createGroup, m.updateGroup, m.deleteGroup, m.importGroup, m.applyGroups, m.setGroupsEnforce]) {
    fn.mockReset()
  }
  confirmSpy.mockReset()
  localStorage.clear()
})

describe('ModGroupsPanel: the group list', () => {
  it('lists each group with how many of its mods are on this server and its in-order badge', async () => {
    prime()
    renderPanel()

    expect(await screen.findByText('KI5 Vehicles')).toBeInTheDocument()
    const ki5 = groupRow('KI5 Vehicles')
    expect(within(ki5).getByText('3 of 4 on this server')).toBeInTheDocument()
    expect(within(ki5).getByText('Out of order')).toBeInTheDocument()
    expect(within(ki5).getByText('Library, core, add-ons, fixes')).toBeInTheDocument()
    expect(within(ki5).getByText('Not on this server: KI5Fix')).toBeInTheDocument()

    const weapons = groupRow('Weapons')
    expect(within(weapons).getByText('2 of 2 on this server')).toBeInTheDocument()
    expect(within(weapons).getByText('In order')).toBeInTheDocument()
    expect(within(weapons).queryByText(/Not on this server/)).toBeNull()
  })

  it('reads the in-order status again when the saved load order changes', async () => {
    prime()
    const { rerenderPanel } = renderPanel()
    await screen.findByText('KI5 Vehicles')
    expect(m.getGroupsStatus).toHaveBeenCalledTimes(1)

    // A render that carries the same saved order does not refetch...
    rerenderPanel({ savedModIds: [...SERVER_MODS] })
    expect(m.getGroupsStatus).toHaveBeenCalledTimes(1)

    // ...a different saved order does.
    m.getGroupsStatus.mockResolvedValue({ groups: STATUS.groups.map((g) => ({ ...g, inOrder: true })), inOrder: true, conflicts: [] })
    rerenderPanel({ savedModIds: ['KI5Lib', 'KI5Core', 'KI5Addon', 'Brita', 'Arsenal', 'Other'] })
    await waitFor(() => expect(m.getGroupsStatus).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(within(groupRow('KI5 Vehicles')).getByText('In order')).toBeInTheDocument())
  })

  it('says which groups contradict each other, by name', async () => {
    prime([KI5, WEAPONS], { ...STATUS, conflicts: ['g1', 'g2'] })
    renderPanel()

    expect(await screen.findByText(/no load order can satisfy all of them/)).toHaveTextContent('Involved: KI5 Vehicles, Weapons')
  })

  it('explains what groups are when there are none, and opens the dialog from the empty state', async () => {
    prime([], { groups: [], inOrder: true, conflicts: [] })
    renderPanel()

    expect(await screen.findByText('No mod groups yet')).toBeInTheDocument()
    expect(screen.getByText(/its library first, then the core mods, then the add-ons, and the fixes last/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'New group' })).toHaveLength(1)
    // Nothing to apply without groups.
    expect(screen.queryByRole('button', { name: 'Apply group order' })).toBeNull()

    fireEvent.click(button('New group'))
    expect(await screen.findByRole('heading', { name: 'New mod group' })).toBeInTheDocument()
  })

  it('offers a retry when the groups cannot be loaded', async () => {
    m.getGroups.mockRejectedValueOnce(new Error('boom'))
    m.getGroupsStatus.mockResolvedValue(STATUS)
    renderPanel()

    expect(await screen.findByText('Mod groups could not be loaded.')).toBeInTheDocument()
    m.getGroups.mockResolvedValue({ groups: [KI5], enforce: false })
    fireEvent.click(button('Retry'))

    expect(await screen.findByText('KI5 Vehicles')).toBeInTheDocument()
  })

  it('collapses to its header and remembers it', async () => {
    prime()
    const first = renderPanel()
    await screen.findByText('KI5 Vehicles')

    fireEvent.click(button(/^Mod groups/))
    expect(screen.queryByText('KI5 Vehicles')).toBeNull()
    // Out of order is still visible while collapsed.
    expect(screen.getByText('Out of order')).toBeInTheDocument()

    first.unmount()
    renderPanel()
    expect(await screen.findByRole('button', { name: /^Mod groups/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('KI5 Vehicles')).toBeNull()
  })
})

describe('ModGroupsPanel: create and edit', () => {
  it('creates a group and reloads the list', async () => {
    prime([], { groups: [], inOrder: true, conflicts: [] })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'New group' }))

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'KI5 Vehicles' } })
    fireEvent.click(button('Add KI5Lib to the group'))
    fireEvent.click(button('Add KI5Core to the group'))
    m.getGroups.mockResolvedValue({ groups: [KI5], enforce: false })
    fireEvent.click(button('Create group'))

    await waitFor(() =>
      expect(m.createGroup).toHaveBeenCalledWith({ name: 'KI5 Vehicles', description: '', modIds: ['KI5Lib', 'KI5Core'], color: null, keepTogether: false }),
    )
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'New mod group' })).toBeNull())
    expect(toastTitles()).toContain('Group created')
    expect(await screen.findByText('KI5 Vehicles')).toBeInTheDocument()
    expect(m.updateGroup).not.toHaveBeenCalled()
  })

  it('edits a group: reorders with move down, removes a member, saves it with updateGroup', async () => {
    prime()
    renderPanel()
    await screen.findByText('KI5 Vehicles')

    fireEvent.click(button('Edit group KI5 Vehicles'))
    expect(await screen.findByRole('heading', { name: 'Edit mod group' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('KI5 Vehicles')

    fireEvent.click(button('Move KI5Core down in the group'))
    fireEvent.click(button('Remove KI5Fix from the group'))
    fireEvent.click(button('Add Other to the group'))
    fireEvent.click(button('Save changes'))

    await waitFor(() => expect(m.updateGroup).toHaveBeenCalledWith('g1', {
      name: 'KI5 Vehicles',
      description: 'Library, core, add-ons, fixes',
      modIds: ['KI5Lib', 'KI5Addon', 'KI5Core', 'Other'],
      color: null,
      keepTogether: false,
    }))
    expect(toastTitles()).toContain('Group saved')
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Edit mod group' })).toBeNull())
    expect(m.createGroup).not.toHaveBeenCalled()
  })

  it('keeps the dialog open with the server\'s reason when the save is refused', async () => {
    prime()
    m.updateGroup.mockRejectedValue(new Error('A group named "Weapons" already exists.'))
    renderPanel()
    await screen.findByText('KI5 Vehicles')

    fireEvent.click(button('Edit group KI5 Vehicles'))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Weapons' } })
    fireEvent.click(button('Save changes'))

    expect(await screen.findByText('A group named "Weapons" already exists.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Edit mod group' })).toBeInTheDocument()
  })
})

describe('ModGroupsPanel: Apply group order', () => {
  it('previews what would move, asks, then writes and reloads the load order', async () => {
    prime()
    m.applyGroups.mockImplementation(async (preview) =>
      preview
        ? { changed: true, moved: ['KI5Core', 'KI5Lib'], order: ['KI5Lib', 'KI5Core'], written: false, conflicts: [] }
        : { changed: true, moved: ['KI5Core', 'KI5Lib'], order: ['KI5Lib', 'KI5Core'], written: true, conflicts: [] },
    )
    confirmSpy.mockResolvedValue(true)
    renderPanel()
    await screen.findByText('KI5 Vehicles')

    fireEvent.click(button('Apply group order'))

    await waitFor(() => expect(onOrderApplied).toHaveBeenCalledTimes(1))
    // Preview first (nothing written), the write only after the yes.
    expect(m.applyGroups.mock.calls.map((call) => call[0])).toEqual([true, false])
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    const asked = confirmSpy.mock.calls[0][0]
    expect(asked.description).toContain('2 mods would move so that every group is in order')
    expect(asked.items).toEqual(['KI5Core', 'KI5Lib (KI5 Library)'])
    expect(asked.confirmLabel).toBe('Apply order')
    // A routine write, not a destructive one.
    expect(asked.destructive).toBe(false)
    expect(toastTitles()).toContain('Group order applied')
  })

  it('writes nothing when the confirmation is declined', async () => {
    prime()
    m.applyGroups.mockResolvedValue({ changed: true, moved: ['KI5Core'], order: [], written: false, conflicts: [] })
    confirmSpy.mockResolvedValue(false)
    renderPanel()
    await screen.findByText('KI5 Vehicles')

    fireEvent.click(button('Apply group order'))

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1))
    expect(confirmSpy.mock.calls[0][0].description).toContain('1 mod would move')
    await waitFor(() => expect(button('Apply group order')).toBeEnabled())
    expect(m.applyGroups).toHaveBeenCalledTimes(1)
    expect(m.applyGroups).toHaveBeenCalledWith(true)
    expect(onOrderApplied).not.toHaveBeenCalled()
  })

  it('says so, and asks nothing, when the preview finds nothing to move', async () => {
    prime()
    m.applyGroups.mockResolvedValue({ changed: false, moved: [], order: SERVER_MODS, written: false, conflicts: [] })
    renderPanel()
    await screen.findByText('KI5 Vehicles')

    fireEvent.click(button('Apply group order'))

    await waitFor(() => expect(toastTitles()).toContain('Groups already in order'))
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(m.applyGroups).toHaveBeenCalledTimes(1)
  })

  it('reports a failed write', async () => {
    prime()
    m.applyGroups.mockImplementation(async (preview) => {
      if (!preview) throw new Error('INI is read-only')
      return { changed: true, moved: ['KI5Core'], order: [], written: false, conflicts: [] }
    })
    confirmSpy.mockResolvedValue(true)
    renderPanel()
    await screen.findByText('KI5 Vehicles')

    fireEvent.click(button('Apply group order'))

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Could not apply the group order',
      description: 'INI is read-only',
      variant: 'destructive',
    })))
    expect(onOrderApplied).not.toHaveBeenCalled()
  })

  it('is off while every group is in order, while the list has unsaved changes and while it is saving', async () => {
    prime([KI5, WEAPONS], { groups: STATUS.groups.map((g) => ({ ...g, inOrder: true })), inOrder: true, conflicts: [] })
    const { rerenderPanel } = renderPanel()
    await screen.findByText('KI5 Vehicles')
    expect(button('Apply group order')).toBeDisabled()

    m.getGroupsStatus.mockResolvedValue(STATUS)
    rerenderPanel({ savedModIds: ['x'], orderDirty: true })
    await waitFor(() => expect(within(groupRow('KI5 Vehicles')).getByText('Out of order')).toBeInTheDocument())
    expect(button('Apply group order')).toBeDisabled()

    rerenderPanel({ savedModIds: ['x'], orderDirty: false, orderSaving: true })
    expect(button('Apply group order')).toBeDisabled()

    rerenderPanel({ savedModIds: ['x'], orderDirty: false, orderSaving: false })
    expect(button('Apply group order')).toBeEnabled()
  })
})

describe('ModGroupsPanel: delete', () => {
  it('asks first and deletes only after a yes', async () => {
    prime()
    confirmSpy.mockResolvedValue(true)
    renderPanel()
    await screen.findByText('KI5 Vehicles')

    fireEvent.click(button('Delete group KI5 Vehicles'))

    await waitFor(() => expect(m.deleteGroup).toHaveBeenCalledWith('g1'))
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Delete group "KI5 Vehicles"?',
      confirmLabel: 'Delete group',
    }))
    expect(toastTitles()).toContain('Group deleted')
    // The list was reloaded.
    await waitFor(() => expect(m.getGroups).toHaveBeenCalledTimes(2))
  })

  it('keeps the group when the confirmation is declined', async () => {
    prime()
    confirmSpy.mockResolvedValue(false)
    renderPanel()
    await screen.findByText('KI5 Vehicles')

    fireEvent.click(button('Delete group KI5 Vehicles'))

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1))
    expect(m.deleteGroup).not.toHaveBeenCalled()
    expect(screen.getByText('KI5 Vehicles')).toBeInTheDocument()
  })
})

describe('ModGroupsPanel: export', () => {
  it('downloads zcp-mod-group-<slug>.json holding the group document', async () => {
    prime()
    renderPanel()
    await screen.findByText('KI5 Vehicles')

    fireEvent.click(button('Export group KI5 Vehicles'))

    expect(downloadSpy).toHaveBeenCalledTimes(1)
    const [fileName, document] = downloadSpy.mock.calls[0]
    expect(fileName).toBe('zcp-mod-group-ki5-vehicles.json')
    // Exactly the shareable fields: no id, no dates.
    expect(document).toEqual({
      schema: 1,
      kind: 'zcp-mod-group',
      name: 'KI5 Vehicles',
      description: 'Library, core, add-ons, fixes',
      modIds: ['KI5Lib', 'KI5Core', 'KI5Addon', 'KI5Fix'],
    })
    expect(toastTitles()).toContain('Group exported')
  })

  it('leaves the empty description out of the file', async () => {
    prime()
    renderPanel()
    await screen.findByText('Weapons')

    fireEvent.click(button('Export group Weapons'))

    expect(downloadSpy.mock.calls[0][1]).toEqual({ schema: 1, kind: 'zcp-mod-group', name: 'Weapons', modIds: ['Brita', 'Arsenal'] })
  })
})

describe('ModGroupsPanel: import', () => {
  const pick = (content: string, name = 'group.json') =>
    fireEvent.change(fileInput(), { target: { files: [new File([content], name, { type: 'application/json' })] } })

  it('sends a valid group document to the server and reloads the list', async () => {
    prime()
    renderPanel()
    await screen.findByText('KI5 Vehicles')

    pick(JSON.stringify({ schema: 1, kind: 'zcp-mod-group', name: 'Imported', description: 'From a friend', modIds: ['A', 'B'], extra: 'dropped' }))

    await waitFor(() => expect(m.importGroup).toHaveBeenCalledTimes(1))
    expect(m.importGroup).toHaveBeenCalledWith({ schema: 1, kind: 'zcp-mod-group', name: 'Imported', description: 'From a friend', modIds: ['A', 'B'] })
    await waitFor(() => expect(toastTitles()).toContain('Group imported'))
    await waitFor(() => expect(m.getGroups).toHaveBeenCalledTimes(2))
  })

  it('rejects a document of another kind without calling the API', async () => {
    prime()
    renderPanel()
    await screen.findByText('KI5 Vehicles')

    pick(JSON.stringify({ schema: 1, kind: 'zcp-mod-preset', name: 'Not a group', modIds: ['A', 'B'] }))

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Not a mod group file',
      description: expect.stringContaining('not a mod group export'),
      variant: 'destructive',
    })))
    expect(m.importGroup).not.toHaveBeenCalled()
  })

  it('rejects a file that is not JSON, or a group without mods, without calling the API', async () => {
    prime()
    renderPanel()
    await screen.findByText('KI5 Vehicles')

    pick('this is not json at all', 'notes.txt')
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ description: 'The file is not a JSON document.' })))

    pick(JSON.stringify({ schema: 1, kind: 'zcp-mod-group', name: 'Empty', modIds: [] }))
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ description: 'The file needs a name and a list of mod IDs.' })))

    expect(m.importGroup).not.toHaveBeenCalled()
  })

  it('shows the server\'s reason when it refuses a document the panel accepted', async () => {
    prime()
    m.importGroup.mockRejectedValue(new Error('Too many mod groups.'))
    renderPanel()
    await screen.findByText('KI5 Vehicles')

    pick(JSON.stringify({ schema: 1, kind: 'zcp-mod-group', name: 'One more', modIds: ['A', 'B'] }))

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Import failed',
      description: 'Too many mod groups.',
      variant: 'destructive',
    })))
  })

  it('opens the file picker from the Import button', async () => {
    prime()
    renderPanel()
    await screen.findByText('KI5 Vehicles')
    const click = vi.spyOn(fileInput(), 'click')

    fireEvent.click(button('Import'))

    expect(click).toHaveBeenCalledTimes(1)
  })
})

describe('ModGroupsPanel: keep group order when saving', () => {
  const enforceSwitch = () => screen.getByRole('switch', { name: 'Keep group order when saving the load order' })

  it('shows the server\'s setting with its one-line explanation', async () => {
    prime([KI5], STATUS, true)
    renderPanel()

    await screen.findByText('KI5 Vehicles')
    expect(enforceSwitch()).toBeChecked()
    expect(enforceSwitch()).toHaveAccessibleDescription('When on, saving the load order moves group members back into their group order.')
  })

  it('sends the new setting to the server when toggled', async () => {
    prime([KI5], STATUS, false)
    renderPanel()
    await screen.findByText('KI5 Vehicles')
    expect(enforceSwitch()).not.toBeChecked()

    fireEvent.click(enforceSwitch())

    await waitFor(() => expect(m.setGroupsEnforce).toHaveBeenCalledWith(true))
    await waitFor(() => expect(enforceSwitch()).toBeChecked())

    fireEvent.click(enforceSwitch())
    await waitFor(() => expect(m.setGroupsEnforce).toHaveBeenLastCalledWith(false))
    await waitFor(() => expect(enforceSwitch()).not.toBeChecked())
  })

  it('puts the switch back and says why when the server refuses', async () => {
    prime([KI5], STATUS, false)
    m.setGroupsEnforce.mockRejectedValue(new Error('Config is locked.'))
    renderPanel()
    await screen.findByText('KI5 Vehicles')

    fireEvent.click(enforceSwitch())

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Could not change the setting',
      description: 'Config is locked.',
      variant: 'destructive',
    })))
    expect(enforceSwitch()).not.toBeChecked()
  })

  it('is shown on the empty state too', async () => {
    prime([], { groups: [], inOrder: true, conflicts: [] }, true)
    renderPanel()

    await screen.findByText('No mod groups yet')
    expect(enforceSwitch()).toBeChecked()
  })
})

describe('ModGroupsPanel: without mods.manage', () => {
  it('lists and exports, but cannot create, edit, delete, import or switch', async () => {
    prime()
    renderPanel({ canManage: false })
    await screen.findByText('KI5 Vehicles')

    expect(button('Edit group KI5 Vehicles')).toBeDisabled()
    expect(button('Delete group KI5 Vehicles')).toBeDisabled()
    expect(button('Import')).toBeDisabled()
    expect(button('New group')).toBeDisabled()
    expect(button('Apply group order')).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Keep group order when saving the load order' })).toBeDisabled()
    expect(button('Export group KI5 Vehicles')).toBeEnabled()
  })
})

describe('ModGroupsPanel: colour, keep together, placement and conflicts', () => {
  it('shows a group kept together and its placement, and keeps the placement in this browser', async () => {
    prime([{ ...KI5, color: 'amber', keepTogether: true }, WEAPONS])
    renderPanel()
    await screen.findByText('KI5 Vehicles')
    expect(within(groupRow('KI5 Vehicles')).getByText('Kept together')).toBeInTheDocument()
    expect(within(groupRow('KI5 Vehicles')).queryByText('Loads first')).toBeNull()

    fireEvent.click(button('Edit group KI5 Vehicles'))
    fireEvent.click(await screen.findByRole('radio', { name: 'First' }))
    fireEvent.click(button('Save changes'))

    await waitFor(() => expect(m.updateGroup).toHaveBeenCalledWith('g1', expect.objectContaining({ color: 'amber', keepTogether: true })))
    // The server does not keep a placement: it is not sent, this browser keeps it.
    expect(m.updateGroup.mock.calls[0][1]).not.toHaveProperty('placement')
    expect(JSON.parse(localStorage.getItem('zcp:mods:groupPlacement') ?? '{}')).toEqual({ g1: 'first' })
    expect(await within(groupRow('KI5 Vehicles')).findByText('Loads first')).toBeInTheDocument()
  })

  it('opens the Conflicts view from a group conflict badge', async () => {
    prime()
    const onShowConflicts = vi.fn()
    const summary = { internal: 1, external: 1, modIds: ['KI5Core', 'KI5Addon', 'Other'] }
    renderPanel({ conflictsByGroup: new Map([['g1', summary]]), onShowConflicts })
    await screen.findByText('KI5 Vehicles')

    fireEvent.click(button('2 file conflicts involve KI5 Vehicles. Show them'))

    expect(onShowConflicts).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1' }), summary)
    expect(within(groupRow('Weapons')).queryByText(/conflict/)).toBeNull()
  })
})