import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ModGroupDialog } from '../ModGroupDialog'
import type { ModGroup } from '@/lib/api'

// The create / edit dialog of a mod group: name, description and the ordered
// member list (move up / move down / remove, no drag), plus "Add mods" from the
// mods enabled on the server.

const SERVER_MODS = ['KI5Lib', 'KI5Core', 'KI5Addon', 'Brita', 'Arsenal']
const NAMES: Record<string, string> = {
  KI5Lib: 'KI5 Library',
  KI5Core: 'KI5 Core Vehicles',
  Brita: "Brita's Weapon Pack",
}

const GROUP: ModGroup = {
  id: 'g1',
  name: 'KI5 Vehicles',
  description: 'Library first',
  // KI5Fix is not enabled on the server right now.
  modIds: ['KI5Lib', 'KI5Core', 'KI5Addon', 'KI5Fix'],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderDialog(group: ModGroup | null, onSubmit = vi.fn().mockResolvedValue(undefined), onClose = vi.fn()) {
  render(<ModGroupDialog group={group} serverModIds={SERVER_MODS} modNames={NAMES} onClose={onClose} onSubmit={onSubmit} />)
  return { onSubmit, onClose }
}

// Member rows, top to bottom, as the mod IDs they show.
const memberOrder = () =>
  Array.from(document.querySelectorAll('[data-member-id]')).map((row) => row.getAttribute('data-member-id'))

const button = (name: string | RegExp) => screen.getByRole('button', { name })

describe('ModGroupDialog: creating a group', () => {
  it('starts empty, with the example order and a hint that two mods are needed', () => {
    renderDialog(null)

    expect(screen.getByRole('heading', { name: 'New mod group' })).toBeInTheDocument()
    expect(screen.getByText(/library → core mods → add-ons → fixes/)).toBeInTheDocument()
    expect(screen.getByText('No mods yet. Add them below, in the order they must load.')).toBeInTheDocument()
    expect(screen.getByText('Add at least two mods to save the group.')).toBeInTheDocument()
    expect(button('Create group')).toBeDisabled()
  })

  it('offers the enabled mods, appends the one clicked and takes it off the list', () => {
    renderDialog(null)

    fireEvent.click(button('Add KI5Core to the group'))
    fireEvent.click(button('Add KI5Lib to the group'))

    expect(memberOrder()).toEqual(['KI5Core', 'KI5Lib'])
    expect(screen.queryByRole('button', { name: 'Add KI5Core to the group' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add KI5Lib to the group' })).toBeNull()
    // The rest are still offered.
    expect(button('Add Brita to the group')).toBeInTheDocument()
  })

  it('searches the enabled mods by ID and by name', () => {
    renderDialog(null)
    const search = screen.getByRole('textbox', { name: 'Add mods' })

    fireEvent.change(search, { target: { value: 'ki5' } })
    expect(screen.getAllByRole('button', { name: /^Add .* to the group$/ }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Add KI5Lib to the group',
      'Add KI5Core to the group',
      'Add KI5Addon to the group',
    ])

    // A display name matches too (Brita's pack is listed by its ID).
    fireEvent.change(search, { target: { value: 'weapon pack' } })
    expect(screen.getAllByRole('button', { name: /^Add .* to the group$/ }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Add Brita to the group',
    ])

    fireEvent.change(search, { target: { value: 'nothing like this' } })
    expect(screen.getByText('No enabled mod matches your search.')).toBeInTheDocument()
  })

  it('saves the name, the description and the members in the order they were arranged', async () => {
    const { onSubmit } = renderDialog(null)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  KI5 Vehicles ' } })
    fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: 'Library, core, add-ons' } })
    fireEvent.click(button('Add KI5Addon to the group'))
    fireEvent.click(button('Add KI5Lib to the group'))
    fireEvent.click(button('Add KI5Core to the group'))
    // KI5Lib to the top: the library loads first.
    fireEvent.click(button('Move KI5Lib up in the group'))
    expect(memberOrder()).toEqual(['KI5Lib', 'KI5Addon', 'KI5Core'])
    fireEvent.click(button('Move KI5Core up in the group'))
    expect(memberOrder()).toEqual(['KI5Lib', 'KI5Core', 'KI5Addon'])

    fireEvent.click(button('Create group'))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'KI5 Vehicles',
      description: 'Library, core, add-ons',
      modIds: ['KI5Lib', 'KI5Core', 'KI5Addon'],
      color: null,
      keepTogether: false,
      placement: null,
    })
  })

  it('needs a name as well as two mods', () => {
    renderDialog(null)
    fireEvent.click(button('Add KI5Lib to the group'))
    fireEvent.click(button('Add KI5Core to the group'))
    expect(button('Create group')).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'KI5' } })
    expect(button('Create group')).toBeEnabled()
    expect(screen.queryByText('Add at least two mods to save the group.')).toBeNull()
  })
})

describe('ModGroupDialog: editing the member list', () => {
  it('shows each member with its name and ID, and mutes the ones that are not on the server', () => {
    renderDialog(GROUP)

    expect(screen.getByRole('heading', { name: 'Edit mod group' })).toBeInTheDocument()
    expect(memberOrder()).toEqual(['KI5Lib', 'KI5Core', 'KI5Addon', 'KI5Fix'])
    const libRow = document.querySelector('[data-member-id="KI5Lib"]') as HTMLElement
    expect(within(libRow).getByText('KI5Lib')).toBeInTheDocument()
    expect(within(libRow).getByText('KI5 Library')).toBeInTheDocument()
    expect(within(libRow).queryByText('not on this server')).toBeNull()

    const fixRow = document.querySelector('[data-member-id="KI5Fix"]') as HTMLElement
    expect(within(fixRow).getByText('not on this server')).toBeInTheDocument()
    // Kept in the list and still editable, only shown muted.
    expect(within(fixRow).getByRole('button', { name: 'Remove KI5Fix from the group' })).toBeEnabled()
  })

  it('moves members up and down, and disables the buttons at the ends', () => {
    renderDialog(GROUP)

    expect(button('Move KI5Lib up in the group')).toBeDisabled()
    expect(button('Move KI5Fix down in the group')).toBeDisabled()

    fireEvent.click(button('Move KI5Core down in the group'))
    expect(memberOrder()).toEqual(['KI5Lib', 'KI5Addon', 'KI5Core', 'KI5Fix'])
    fireEvent.click(button('Move KI5Fix up in the group'))
    expect(memberOrder()).toEqual(['KI5Lib', 'KI5Addon', 'KI5Fix', 'KI5Core'])
    expect(button('Move KI5Core down in the group')).toBeDisabled()
  })

  it('keeps keyboard focus on the control that was pressed, so it can be pressed again', () => {
    renderDialog(GROUP)

    fireEvent.click(button('Move KI5Core down in the group'))
    expect(document.activeElement).toBe(button('Move KI5Core down in the group'))

    fireEvent.click(button('Move KI5Core down in the group'))
    expect(memberOrder()).toEqual(['KI5Lib', 'KI5Addon', 'KI5Fix', 'KI5Core'])
    // Last now: "down" is disabled, so focus goes to the sibling control.
    expect(document.activeElement).toBe(button('Move KI5Core up in the group'))
  })

  it('announces a move to screen readers', () => {
    renderDialog(GROUP)

    fireEvent.click(button('Move KI5Core down in the group'))

    expect(document.querySelector('p.sr-only[role="status"]')).toHaveTextContent('KI5Core moved to position 3 of 4')
  })

  it('removes a member, hands it back to the Add list and focuses the next row', () => {
    renderDialog(GROUP)
    expect(screen.queryByRole('button', { name: 'Add KI5Core to the group' })).toBeNull()

    fireEvent.click(button('Remove KI5Core from the group'))

    expect(memberOrder()).toEqual(['KI5Lib', 'KI5Addon', 'KI5Fix'])
    expect(button('Add KI5Core to the group')).toBeInTheDocument()
    expect(document.activeElement).toBe(button('Remove KI5Addon from the group'))
  })

  it('saves only what changed: Save is off until something does', async () => {
    const { onSubmit } = renderDialog(GROUP)
    expect(button('Save changes')).toBeDisabled()

    fireEvent.click(button('Remove KI5Fix from the group'))
    expect(button('Save changes')).toBeEnabled()
    fireEvent.click(button('Save changes'))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      name: 'KI5 Vehicles',
      description: 'Library first',
      modIds: ['KI5Lib', 'KI5Core', 'KI5Addon'],
      color: null,
      keepTogether: false,
      placement: null,
    }))
  })

  it('refuses to go below two members', () => {
    renderDialog({ ...GROUP, modIds: ['KI5Lib', 'KI5Core'] })

    fireEvent.click(button('Remove KI5Core from the group'))

    expect(screen.getByText('Add at least two mods to save the group.')).toBeInTheDocument()
    expect(button('Save changes')).toBeDisabled()
  })
})

describe('ModGroupDialog: colour, keep together, placement and auto-order', () => {
  it('saves a colour, keep-together and a placement, and counts the members', async () => {
    const { onSubmit } = renderDialog(GROUP)

    expect(screen.getByText('4 mods')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'No colour' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Amber' }))
    expect(screen.getByRole('radio', { name: 'Amber' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('switch', { name: 'Keep together in load order' }))
    fireEvent.click(screen.getByRole('radio', { name: 'First' }))

    fireEvent.click(button('Save changes'))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      name: 'KI5 Vehicles',
      description: 'Library first',
      modIds: ['KI5Lib', 'KI5Core', 'KI5Addon', 'KI5Fix'],
      color: 'amber',
      keepTogether: true,
      placement: 'first',
    }))
  })

  it('moves through the colours with the arrow keys', () => {
    renderDialog(GROUP)
    const none = screen.getByRole('radio', { name: 'No colour' })

    fireEvent.keyDown(none, { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: 'Slate' })).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Slate' }))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' })
    expect(screen.getByRole('radio', { name: 'Pink' })).toHaveAttribute('aria-checked', 'true')
  })

  it('a placement change alone is a change to save', () => {
    renderDialog(GROUP)
    expect(button('Save changes')).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: 'Last' }))
    expect(button('Save changes')).toBeEnabled()
  })

  it('warns about members that are not on this server', () => {
    renderDialog(GROUP)
    expect(screen.getByText('1 member is not on this server. It keeps its place and loads once it is enabled.')).toBeInTheDocument()
  })

  it('auto-orders the members (requirements, then libraries first, fixes last) and can undo it', () => {
    render(
      <ModGroupDialog
        group={{ ...GROUP, modIds: ['KI5Fix', 'KI5Addon', 'KI5Trucks', 'KI5Lib'] }}
        serverModIds={['KI5Fix', 'KI5Addon', 'KI5Trucks', 'KI5Lib']}
        modNames={{ KI5Lib: 'KI5 Library', KI5Trucks: 'KI5 Trucks' }}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    fireEvent.click(button('Auto-order members'))

    expect(memberOrder()).toEqual(['KI5Lib', 'KI5Trucks', 'KI5Addon', 'KI5Fix'])
    expect(screen.getByText(/Ordered: requirements first/)).toBeInTheDocument()

    fireEvent.click(button('Undo'))
    expect(memberOrder()).toEqual(['KI5Fix', 'KI5Addon', 'KI5Trucks', 'KI5Lib'])
  })

  it('puts a required member before the one needing it, whatever the names say', () => {
    render(
      <ModGroupDialog
        group={{ ...GROUP, modIds: ['Alpha', 'Beta'] }}
        serverModIds={['Alpha', 'Beta']}
        modNames={{}}
        requires={new Map([['Alpha', ['Beta']]])}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    fireEvent.click(button('Auto-order members'))

    expect(memberOrder()).toEqual(['Beta', 'Alpha'])
  })

  it('says so when the members are already in that order', () => {
    renderDialog(GROUP)

    fireEvent.click(button('Auto-order members'))

    expect(screen.getByText('The members are already in that order.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('starts a new group from a suggestion: its name and members', () => {
    render(
      <ModGroupDialog
        group={null}
        initialName="KI5 Library"
        initialModIds={['KI5Lib', 'KI5Core']}
        serverModIds={SERVER_MODS}
        modNames={NAMES}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Name')).toHaveValue('KI5 Library')
    expect(memberOrder()).toEqual(['KI5Lib', 'KI5Core'])
    expect(button('Create group')).toBeEnabled()
  })

  it('reorders by dragging a member row', () => {
    renderDialog(GROUP)
    const rows = () => Array.from(document.querySelectorAll('[data-member-id]')) as HTMLElement[]

    fireEvent.dragStart(rows()[3])
    fireEvent.dragOver(rows()[0])
    fireEvent.drop(rows()[0])

    expect(memberOrder()).toEqual(['KI5Fix', 'KI5Lib', 'KI5Core', 'KI5Addon'])
  })
})

describe('ModGroupDialog: saving', () => {
  it('shows the error in the dialog and stays open when the save is refused', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('A group named "KI5 Vehicles" already exists.'))
    const { onClose } = renderDialog(null, onSubmit)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'KI5 Vehicles' } })
    fireEvent.click(button('Add KI5Lib to the group'))
    fireEvent.click(button('Add KI5Core to the group'))

    fireEvent.click(button('Create group'))

    expect(await screen.findByText('The group was not saved')).toBeInTheDocument()
    expect(screen.getByText('A group named "KI5 Vehicles" already exists.')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    // Usable again to fix and retry.
    expect(button('Create group')).toBeEnabled()
  })

  it('Cancel closes without saving', () => {
    const { onSubmit, onClose } = renderDialog(GROUP)

    fireEvent.click(button('Cancel'))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
