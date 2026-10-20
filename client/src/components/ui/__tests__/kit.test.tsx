import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Archive, Trash2, Users } from 'lucide-react'
import { StatusPill } from '../status-pill'
import { StatStrip } from '../stat-strip'
import { Toolbar } from '../toolbar'
import { Segmented } from '../segmented'
import { RowActions } from '../row-actions'
import { Stepper } from '../stepper'
import { SectionCard } from '../section-card'
import { ServerHeader } from '@/components/ServerHeader'

// The shared kit of the UX restructure (plan §3). Each block pins the
// behaviour pages will rely on when they adopt it.

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('StatusPill', () => {
  it('puts the state word next to its dot, with the reason after it', () => {
    render(<StatusPill tone="error" label="RCON: Disconnected" detail="Authentication failed" />)
    const pill = screen.getByText('RCON: Disconnected')
    expect(pill.querySelector('span[aria-hidden="true"]')).toHaveClass('bg-destructive')
    expect(screen.getByText('— Authentication failed')).toBeInTheDocument()
  })

  it('becomes a link to the fix when given `to`', () => {
    render(<MemoryRouter><StatusPill tone="warn" label="Bridge offline" to="/settings?tab=bridge" /></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Bridge offline' })).toHaveAttribute('href', '/settings?tab=bridge')
  })

  it('shows a spinner instead of a dot while busy', () => {
    const { container } = render(<StatusPill tone="busy" label="Starting" />)
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })
})

describe('StatStrip', () => {
  it('renders one list of numbers; a cell with `to` is a link and one with onClick a button', () => {
    const onClick = vi.fn()
    render(
      <MemoryRouter>
        <StatStrip
          items={[
            { id: 'online', label: 'Online', value: 12, icon: Users },
            { id: 'banned', label: 'Banned', value: 3, onClick, ariaLabel: 'Show banned players' },
            { id: 'backups', label: 'Backups', value: 40, to: '/backups', icon: Archive, tone: 'warning' },
          ]}
        />
      </MemoryRouter>,
    )
    const list = screen.getByRole('list')
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(within(list).getByText('12')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show banned players' }))
    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.getByRole('link', { name: /Backups/ })).toHaveAttribute('href', '/backups')
  })

  it('renders nothing for no items', () => {
    const { container } = render(<StatStrip items={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('Toolbar', () => {
  it('focuses the search on "/" when asked, but not while typing in a field', () => {
    const onChange = vi.fn()
    render(
      <>
        <input aria-label="Other field" />
        <Toolbar search={{ value: '', onChange, placeholder: 'Filter mods', ariaLabel: 'Filter mods', slashToFocus: true }} />
      </>,
    )
    const search = screen.getByRole('searchbox', { name: 'Filter mods' })
    fireEvent.keyDown(window, { key: '/' })
    expect(search).toHaveFocus()

    const other = screen.getByRole('textbox', { name: 'Other field' })
    other.focus()
    fireEvent.keyDown(window, { key: '/' })
    expect(other).toHaveFocus()
  })

  it('clears the query with Escape and with the clear button', () => {
    const onChange = vi.fn()
    render(<Toolbar search={{ value: 'brita', onChange, placeholder: 'Filter', ariaLabel: 'Filter' }} end={<span>12 mods</span>} />)
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Filter' }), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith('')
    expect(screen.getByText('12 mods')).toBeInTheDocument()
  })
})

describe('Segmented', () => {
  it('is a radio group with one tab stop; arrows move the selection', () => {
    const onValueChange = vi.fn()
    render(
      <Segmented
        value="all"
        onValueChange={onValueChange}
        ariaLabel="Show"
        items={[{ value: 'all', label: 'All', count: 40 }, { value: 'modified', label: 'Modified', count: 3 }, { value: 'unsaved', label: 'Unsaved' }]}
      />,
    )
    const group = screen.getByRole('radiogroup', { name: 'Show' })
    const all = within(group).getByRole('radio', { name: /All/ })
    expect(all).toHaveAttribute('aria-checked', 'true')
    expect(all).toHaveAttribute('tabindex', '0')
    expect(within(group).getByRole('radio', { name: /Modified/ })).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(all, { key: 'ArrowRight' })
    expect(onValueChange).toHaveBeenLastCalledWith('modified')
    fireEvent.keyDown(all, { key: 'End' })
    expect(onValueChange).toHaveBeenLastCalledWith('unsaved')
    fireEvent.click(within(group).getByRole('radio', { name: /Modified/ }))
    expect(onValueChange).toHaveBeenLastCalledWith('modified')
  })
})

describe('RowActions', () => {
  it('keeps the primary visible and puts destructive items last, after a separator', async () => {
    const onDelete = vi.fn()
    render(
      <RowActions
        ariaLabel="Actions for Backup 3"
        primary={<button type="button">Restore</button>}
        items={[
          { label: 'Delete', icon: Trash2, onSelect: onDelete, destructive: true },
          { label: 'Download', onSelect: vi.fn() },
          { label: 'Snapshot', onSelect: vi.fn(), disabled: true, reason: 'Stop the server first' },
        ]}
      />,
    )
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for Backup 3' }), { button: 0, ctrlKey: false })
    const menu = await screen.findByRole('menu')
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['Download', 'SnapshotStop the server first', 'Delete'])
    expect(within(menu).getByRole('separator')).toBeInTheDocument()
    expect(items[1]).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(items[2])
    expect(onDelete).toHaveBeenCalledOnce()
  })
})

describe('Stepper', () => {
  const steps = [
    { id: 'files', label: 'Files', status: 'done' as const },
    { id: 'details', label: 'Details', status: 'current' as const },
    { id: 'review', label: 'Review', status: 'upcoming' as const },
    { id: 'install', label: 'Install', status: 'locked' as const, lockedReason: 'Fill in the details first' },
  ]

  it('marks the current step and says where it is', () => {
    render(<Stepper steps={steps} />)
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()
    expect(screen.getByText('Details').closest('[aria-current="step"]')).not.toBeNull()
  })

  it('makes every step but a locked one a button when steps are clickable', () => {
    const onStepClick = vi.fn()
    render(<Stepper steps={steps} onStepClick={onStepClick} />)
    fireEvent.click(screen.getByRole('button', { name: /Files/ }))
    expect(onStepClick).toHaveBeenCalledWith('files')
    expect(screen.queryByRole('button', { name: /Install/ })).not.toBeInTheDocument()
  })
})

describe('SectionCard', () => {
  it('titles its section with a heading at the requested level, and labels the region by it', () => {
    render(<SectionCard title="Scheduled tasks" description="Restarts and backups." headingLevel={3} actions={<button type="button">New task</button>}>body</SectionCard>)
    const heading = screen.getByRole('heading', { level: 3, name: 'Scheduled tasks' })
    expect(screen.getByRole('region', { name: 'Scheduled tasks' })).toContainElement(heading)
    expect(screen.getByRole('button', { name: 'New task' })).toBeInTheDocument()
  })

  it('collapses from its title and remembers the state under storageKey', () => {
    const { unmount } = render(<SectionCard title="Advanced" collapsible storageKey="card:advanced">secret body</SectionCard>)
    const toggle = screen.getByRole('button', { name: 'Advanced' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('secret body')).not.toBeInTheDocument()
    unmount()

    render(<SectionCard title="Advanced" collapsible storageKey="card:advanced">secret body</SectionCard>)
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('ServerHeader', () => {
  it('makes the server name the page title, with its state, facts and actions (menu before the primary)', async () => {
    const onWipe = vi.fn()
    render(
      <ServerHeader
        name="Knox Survivors"
        status={{ tone: 'ok', label: 'Running' }}
        meta={<span>Muldraugh · up 3h</span>}
        secondary={<button type="button">Stop</button>}
        primary={<button type="button">Restart</button>}
        menu={[{ label: 'Save world', onSelect: vi.fn() }, { label: 'Wipe', onSelect: onWipe, destructive: true }]}
      />,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Knox Survivors' })).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Muldraugh · up 3h')).toBeInTheDocument()
    const buttons = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)
    expect(buttons).toEqual(['Stop', 'More actions for Knox Survivors', 'Restart'])
  })
})
