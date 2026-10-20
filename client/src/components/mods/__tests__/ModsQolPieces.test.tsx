import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ModGroup, ModGroupSuggestion, ModNote } from '@/lib/api'
import { AddToGroupDialog } from '../AddToGroupDialog'
import { ModNoteDialog, MOD_NOTE_MAX } from '../ModNoteDialog'
import { GroupDots, NoteIndicator } from '../GroupDots'
import { GroupSuggestions } from '../GroupSuggestions'

// The small pieces of the Mod Manager's group and note features: the "Add to
// group" picker, the note dialog, a row's colour dots and note icon, and the
// suggested groups.

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const STAMP = '2026-10-01T00:00:00.000Z'
const group = (id: string, name: string, modIds: string[], extra: Partial<ModGroup> = {}): ModGroup => ({
  id,
  name,
  description: '',
  modIds,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...extra,
})

describe('AddToGroupDialog', () => {
  const GROUPS = [group('a', 'Vehicles', ['Car', 'Lib']), group('b', 'Maps', ['M1', 'M2'], { color: 'lime' })]

  it('adds the mods to the picked group', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<AddToGroupDialog modIds={['Truck']} label="Truck pack" groups={GROUPS} onAdd={onAdd} onCreateNew={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByText("Pick the group for Truck pack. It joins at the end of the group's order.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Vehicles/ }))

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(GROUPS[0]))
  })

  it('shows a group that already has every mod, but it cannot be picked', () => {
    render(<AddToGroupDialog modIds={['Car', 'Lib']} groups={GROUPS} onAdd={vi.fn()} onCreateNew={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByText("Pick the group for 2 mods. They join at the end of the group's order.")).toBeInTheDocument()
    const vehicles = screen.getByRole('button', { name: /Vehicles/ })
    expect(vehicles).toBeDisabled()
    expect(vehicles).toHaveTextContent('Already in this group')
    expect(screen.getByRole('button', { name: /Maps/ })).toBeEnabled()
  })

  it('keeps the dialog open and shows why when adding fails', async () => {
    const onAdd = vi.fn().mockRejectedValue(new Error('Group is full'))
    const onClose = vi.fn()
    render(<AddToGroupDialog modIds={['Truck']} groups={GROUPS} onAdd={onAdd} onCreateNew={vi.fn()} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: /Maps/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Group is full')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Maps/ })).toBeEnabled()
  })

  it('starts a new group, and searches when there are many groups', () => {
    const many = Array.from({ length: 8 }, (_, i) => group(`g${i}`, i === 3 ? 'Weapons' : `Group ${i}`, ['x', 'y']))
    const onCreateNew = vi.fn()
    render(<AddToGroupDialog modIds={['Truck']} groups={many} onAdd={vi.fn()} onCreateNew={onCreateNew} onClose={vi.fn()} />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Search groups' }), { target: { value: 'weap' } })
    const list = screen.getByRole('list', { name: 'Groups' })
    expect(within(list).getAllByRole('button')).toHaveLength(1)
    expect(within(list).getByRole('button')).toHaveTextContent('Weapons')

    fireEvent.click(screen.getByRole('button', { name: 'New group…' }))
    expect(onCreateNew).toHaveBeenCalled()
  })

  it('says how to start when there is no group yet', () => {
    render(<AddToGroupDialog modIds={['Truck']} groups={[]} onAdd={vi.fn()} onCreateNew={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('No groups yet. Start one with New group.')).toBeInTheDocument()
  })
})

describe('ModNoteDialog', () => {
  const NOTE: ModNote = { text: 'Keep 1.2, 1.3 breaks saves', updatedAt: STAMP, updatedBy: 'alice' }

  it('saves a new note, trimmed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<ModNoteDialog name="Brita's Weapons" note={undefined} canEdit onSave={onSave} onClose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: 'Add a note' })).toBeInTheDocument()
    const save = screen.getByRole('button', { name: 'Save note' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: '  Needs Arsenal  ' } })
    fireEvent.click(save)

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Needs Arsenal'))
  })

  it('shows who edited a note last, and deletes it with an empty text', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<ModNoteDialog name="Brita's Weapons" note={NOTE} canEdit onSave={onSave} onClose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: 'Edit note' })).toBeInTheDocument()
    expect(screen.getByText(/Last edited by alice/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(''))
  })

  it('caps the text at the server limit and counts it', () => {
    render(<ModNoteDialog name="X" note={undefined} canEdit onSave={vi.fn()} onClose={vi.fn()} />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'a'.repeat(MOD_NOTE_MAX + 50) } })

    expect((screen.getByRole('textbox', { name: 'Note' }) as HTMLTextAreaElement).value).toHaveLength(MOD_NOTE_MAX)
    expect(screen.getByText(`${MOD_NOTE_MAX} / ${MOD_NOTE_MAX}`)).toBeInTheDocument()
  })

  it('shows the note read-only without mods.manage', () => {
    render(<ModNoteDialog name="X" note={NOTE} canEdit={false} onSave={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveAttribute('readonly')
    expect(screen.queryByRole('button', { name: 'Save note' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete note' })).toBeNull()
    // The footer says Close (next to the dialog's own X), not Cancel.
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2)
  })

  it('shows a failed save in the dialog', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('A mod note can be at most 1000 characters'))
    render(<ModNoteDialog name="X" note={NOTE} canEdit onSave={onSave} onClose={vi.fn()} />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'New text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('A mod note can be at most 1000 characters')
  })
})

describe('GroupDots and NoteIndicator', () => {
  it('names every group for screen readers and shows three dots at most', () => {
    const groups = ['A', 'B', 'C', 'D'].map((name, i) => group(`g${i}`, name, ['x', 'y']))
    const { container } = render(<GroupDots groups={groups} />)

    expect(screen.getByText('In groups: A, B, C, D')).toBeInTheDocument()
    expect(container.querySelector('[data-group-dots]')).toHaveAttribute('title', 'In groups: A, B, C, D')
    expect(container.querySelectorAll('[data-group-dots] > span.rounded-full')).toHaveLength(3)
    expect(container).toHaveTextContent('+1')
  })

  it('renders nothing for a mod in no group, or without a note', () => {
    const { container } = render(
      <>
        <GroupDots groups={[]} />
        <NoteIndicator note={undefined} />
      </>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('opens the note from its icon', () => {
    const onOpen = vi.fn()
    render(<NoteIndicator note={{ text: 'Keep 1.2', updatedAt: STAMP, updatedBy: null }} onOpen={onOpen} />)

    fireEvent.click(screen.getByRole('button', { name: 'Note: Keep 1.2' }))

    expect(onOpen).toHaveBeenCalled()
  })
})

describe('GroupSuggestions', () => {
  const SUGGESTIONS: ModGroupSuggestion[] = [
    { key: 'dependency:abc', kind: 'dependency', name: 'KI5 Library', modIds: ['KI5Lib', 'Car1', 'Car2'] },
    { key: 'prefix:def', kind: 'prefix', name: 'Brita', modIds: ['Brita', 'Brita_2', 'BritaArmor'] },
  ]
  const NAMES = { KI5Lib: 'KI5 Library', Car1: 'Car one', Car2: 'Car two' }

  function renderSuggestions(canManage = true) {
    const onCreate = vi.fn()
    const onDismiss = vi.fn()
    render(
      <TooltipProvider>
        <GroupSuggestions suggestions={SUGGESTIONS} modNames={NAMES} canManage={canManage} onCreate={onCreate} onDismiss={onDismiss} storageKey="test:suggestions" />
      </TooltipProvider>,
    )
    return { onCreate, onDismiss }
  }

  it('lists each suggestion with why it was suggested', () => {
    renderSuggestions()

    expect(screen.getByRole('button', { name: 'Suggested groups (2)' })).toHaveAttribute('aria-expanded', 'true')
    const list = screen.getByRole('list', { name: 'Suggested groups' })
    // A library suggestion counts the mods needing it, not the library.
    expect(list).toHaveTextContent('KI5 Library and 2 mods that need it')
    expect(list).toHaveTextContent('3 mods named "Brita…"')
    expect(list).toHaveTextContent('KI5 Library, Car one, Car two')
  })

  it('creates and dismisses', () => {
    const { onCreate, onDismiss } = renderSuggestions()

    fireEvent.click(screen.getByRole('button', { name: 'Create the group KI5 Library' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the suggestion Brita' }))

    expect(onCreate).toHaveBeenCalledWith(SUGGESTIONS[0])
    expect(onDismiss).toHaveBeenCalledWith(SUGGESTIONS[1])
  })

  it('folds away, and remembers it', () => {
    renderSuggestions()
    fireEvent.click(screen.getByRole('button', { name: 'Suggested groups (2)' }))
    expect(screen.queryByRole('list', { name: 'Suggested groups' })).toBeNull()

    cleanup()
    renderSuggestions()
    expect(screen.queryByRole('list', { name: 'Suggested groups' })).toBeNull()
  })

  it('turns Create and Dismiss off without mods.manage', () => {
    renderSuggestions(false)

    expect(screen.getByRole('button', { name: 'Create the group KI5 Library' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Dismiss the suggestion Brita' })).toBeDisabled()
  })
})
