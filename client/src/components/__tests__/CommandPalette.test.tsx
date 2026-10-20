import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { UnsavedChangesProvider, useUnsavedChangesGuard } from '@/contexts/UnsavedChangesContext'
import { CommandPalette } from '../CommandPalette'
import type { ServerInstance } from '@/lib/api'

// The command palette (UX plan §2.7): Ctrl/Cmd+K finds any page, a page's
// section, or a server to switch to. It hides what a role can't use, shows
// why a page that needs a (local) server can't open, and asks before
// leaving a page with unsaved edits, like the sidebar.

const auth = vi.hoisted(() => ({ can: (_capability: string) => true }))
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ can: (capability: string) => auth.can(capability) }),
}))

const server = (id: number, name: string, extra: Partial<ServerInstance> = {}) =>
  ({ id, name, isActive: false, isRemote: false, ...extra }) as ServerInstance

const ALPHA = server(1, 'Alpha', { isActive: true })
const BRAVO = server(2, 'Bravo')

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

function Dirty() {
  useUnsavedChangesGuard(true)
  return null
}

function renderPalette({
  servers = [ALPHA, BRAVO] as ServerInstance[] | null,
  activeServer = ALPHA as ServerInstance | null,
  dirty = false,
  onSwitchServer = vi.fn(),
  onOpenChange = vi.fn(),
} = {}) {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <ConfirmProvider>
        <UnsavedChangesProvider>
          {dirty && <Dirty />}
          <CommandPalette
            open
            onOpenChange={onOpenChange}
            servers={servers}
            activeServer={activeServer}
            onSwitchServer={onSwitchServer}
            onShowShortcuts={vi.fn()}
          />
          <Where />
        </UnsavedChangesProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  )
  return { onSwitchServer, onOpenChange, input: screen.getByRole('combobox', { name: 'Search pages, sections and servers' }) }
}

const where = () => screen.getByTestId('where').textContent
const listbox = () => screen.getByRole('listbox', { name: 'Results' })
const optionNames = () => within(listbox()).queryAllByRole('option').map((o) => o.textContent ?? '')

afterEach(() => {
  cleanup()
  auth.can = () => true
})

describe('CommandPalette', () => {
  it('lists every page by its full title, with its digit shortcut, before anything is typed', () => {
    renderPalette()
    const pages = within(listbox()).getByRole('group', { name: 'Pages' })
    const config = within(pages).getByRole('option', { name: /Server Configuration/ })
    expect(config).toHaveTextContent('8')
    expect(within(pages).getByRole('option', { name: /Add a Server/ })).toBeInTheDocument()
    // Sections wait for a query; the switch-server entry is there from the start.
    expect(within(listbox()).queryByRole('group', { name: 'Sections' })).not.toBeInTheDocument()
    expect(within(listbox()).getByRole('option', { name: 'Switch to Bravo' })).toBeInTheDocument()
  })

  it('filters as you type, ignoring case and accents, and opens the highlighted page on Enter', async () => {
    const { input, onOpenChange } = renderPalette()
    fireEvent.change(input, { target: { value: 'BACKUPS' } })
    expect(optionNames()[0]).toMatch(/World Backups/)
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => {})
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(where()).toBe('/backups')
  })

  it('finds a section of a page and deep-links to it', async () => {
    const { input } = renderPalette()
    fireEvent.change(input, { target: { value: 'roles' } })
    const sections = within(listbox()).getByRole('group', { name: 'Sections' })
    const roles = within(sections).getByRole('option', { name: /Settings › Roles & Permissions/ })
    fireEvent.click(roles)
    await act(async () => {})
    expect(where()).toBe('/settings?tab=roles')
  })

  it('moves the highlight with the arrow keys', () => {
    const { input } = renderPalette()
    const first = input.getAttribute('aria-activedescendant')
    expect(document.getElementById(first!)).toHaveTextContent('Dashboard')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const second = input.getAttribute('aria-activedescendant')
    expect(second).not.toBe(first)
    expect(document.getElementById(second!)).toHaveTextContent('Console')
    expect(document.getElementById(second!)).toHaveAttribute('aria-selected', 'true')
  })

  it('leaves out pages and sections the role cannot use', () => {
    auth.can = (capability) => capability !== 'files.manage' && capability !== 'users.manage'
    const { input } = renderPalette()
    expect(optionNames().some((name) => /Server Files/.test(name))).toBe(false)
    fireEvent.change(input, { target: { value: 'users' } })
    expect(optionNames().some((name) => /Settings › Users/.test(name))).toBe(false)
  })

  it('shows why a page that needs a server cannot open, and does not open it', async () => {
    const { input } = renderPalette({ servers: [], activeServer: null })
    fireEvent.change(input, { target: { value: 'console' } })
    // Scoped to Pages: the Console's own tabs are deep links in another group.
    const pages = within(listbox()).getByRole('group', { name: 'Pages' })
    const consoleOption = within(pages).getByRole('option', { name: /^Console/ })
    expect(consoleOption).toHaveAttribute('aria-disabled', 'true')
    expect(consoleOption).toHaveTextContent('Add a server first')
    fireEvent.click(consoleOption)
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => {})
    expect(where()).toBe('/settings')
  })

  it('says a local-only page is not available for a remote server', () => {
    const remote = server(3, 'Remote', { isActive: true, isRemote: true })
    const { input } = renderPalette({ servers: [remote], activeServer: remote })
    fireEvent.change(input, { target: { value: 'mods' } })
    const pages = within(listbox()).getByRole('group', { name: 'Pages' })
    expect(within(pages).getByRole('option', { name: /^Mod/ })).toHaveTextContent('Not available for remote')
  })

  it('switches the active server', () => {
    const { input, onSwitchServer } = renderPalette()
    fireEvent.change(input, { target: { value: 'bravo' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSwitchServer).toHaveBeenCalledWith(BRAVO)
  })

  it('says when nothing matches', () => {
    const { input } = renderPalette()
    fireEvent.change(input, { target: { value: 'zzzz-nothing' } })
    expect(screen.getByText('Nothing matches “zzzz-nothing”.')).toBeInTheDocument()
  })

  it('asks before leaving a page with unsaved edits', async () => {
    const { input } = renderPalette({ dirty: true })
    fireEvent.change(input, { target: { value: 'discord' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    await act(async () => {})
    expect(where()).toBe('/settings')
  })
})
