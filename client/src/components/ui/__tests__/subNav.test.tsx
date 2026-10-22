import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom'
import { Settings, Users } from 'lucide-react'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SubNav, SubNavLayout, type SubNavGroup } from '../sub-nav'
import { useUrlParamState } from '@/hooks/useUrlParamState'

// The shared sub-navigation (UX plan §2.5): one rail for Settings, Mods,
// Events, Debug and ServerConfig. Its active row must show from the value
// itself (Settings' rail styled from Radix data-state, which a wrapping
// Tooltip overwrote, so no tab ever looked selected), it must become a
// select below lg, and a page keeps the selection in the URL.

const GROUPS: SubNavGroup[] = [
  {
    id: 'panel',
    label: 'Panel',
    items: [
      { id: 'general', label: 'General', icon: Settings },
      { id: 'users', label: 'Users', icon: Users, dirty: true },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { id: 'about', label: 'About' },
      { id: 'locked', label: 'Locked', disabled: true, disabledReason: 'Needs admin' },
    ],
  },
]

afterEach(() => cleanup())

describe('SubNav kind="tabs"', () => {
  function renderTabs(value = 'users', onValueChange = vi.fn()) {
    return render(
      <TooltipProvider>
        <Tabs value={value} onValueChange={onValueChange} orientation="vertical">
          <SubNavLayout nav={<SubNav kind="tabs" groups={GROUPS} value={value} onValueChange={onValueChange} ariaLabel="Settings sections" />}>
            <TabsContent value="general">general body</TabsContent>
            <TabsContent value="users">users body</TabsContent>
          </SubNavLayout>
        </Tabs>
      </TooltipProvider>,
    )
  }

  it('renders tabs under their group labels, and styles the selected one from its value', () => {
    renderTabs('users')
    const tablist = screen.getByRole('tablist', { name: 'Settings sections' })
    const users = within(tablist).getByRole('tab', { name: /Users/ })
    const general = within(tablist).getByRole('tab', { name: 'General' })
    expect(users).toHaveAttribute('aria-selected', 'true')
    expect(users.className).toMatch(/(^|\s)bg-primary\/10(\s|$)/)
    expect(users.className).not.toMatch(/data-\[state=active\]/)
    expect(general.className).not.toMatch(/(^|\s)bg-primary\/10(\s|$)/)
    expect(screen.getByText('Panel')).toBeInTheDocument()
    expect(screen.getByText('System')).toBeInTheDocument()
    expect(screen.getByText('users body')).toBeInTheDocument()
  })

  it('marks a dirty section for screen readers too, and keeps a disabled one disabled', () => {
    renderTabs('general')
    expect(screen.getByRole('tab', { name: /Users.*unsaved changes/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Locked' })).toBeDisabled()
  })

  it('selects a tab through the page\'s Tabs root', () => {
    const onValueChange = vi.fn()
    renderTabs('users', onValueChange)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'General' }), { button: 0 })
    expect(onValueChange).toHaveBeenCalledWith('general')
  })
})

describe('SubNav kind="nav"', () => {
  it('uses buttons with aria-current for the active view', () => {
    const onValueChange = vi.fn()
    render(<SubNav kind="nav" groups={GROUPS} value="general" onValueChange={onValueChange} ariaLabel="Mod views" />)
    const nav = screen.getByRole('navigation', { name: 'Mod views' })
    expect(within(nav).getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'true')
    expect(within(nav).getByRole('button', { name: 'About' })).not.toHaveAttribute('aria-current')
    expect(within(nav).getByRole('group', { name: 'System' })).toBeInTheDocument()
    fireEvent.click(within(nav).getByRole('button', { name: 'About' }))
    expect(onValueChange).toHaveBeenCalledWith('about')
  })
})

describe('SubNav below lg', () => {
  it('is a select with the groups as option groups, which changes the value', () => {
    const onValueChange = vi.fn()
    render(<SubNav kind="nav" groups={GROUPS} value="general" onValueChange={onValueChange} ariaLabel="Mod views" />)
    const select = screen.getByRole('combobox', { name: 'Mod views' })
    expect(select).toHaveValue('general')
    expect(select.querySelectorAll('optgroup')).toHaveLength(2)
    expect(within(select).getByRole('option', { name: 'Users (unsaved changes)' })).toBeInTheDocument()
    expect(within(select).getByRole('option', { name: 'Locked' })).toBeDisabled()
    fireEvent.change(select, { target: { value: 'about' } })
    expect(onValueChange).toHaveBeenCalledWith('about')
  })

  it('mobile="scroll" draws a chip strip instead of the select', () => {
    render(<SubNav kind="nav" mobile="scroll" groups={GROUPS} value="general" onValueChange={vi.fn()} ariaLabel="Tabs" />)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Tabs' }).className).toMatch(/overflow-x-auto/)
  })
})

describe('useUrlParamState + SubNav: the selection lives in the URL', () => {
  const VIEWS = ['general', 'users', 'about'] as const

  function Probe() {
    const location = useLocation()
    const type = useNavigationType()
    return <output data-testid="url">{`${type} ${location.pathname}${location.search}`}</output>
  }

  function Page() {
    const [view, setView] = useUrlParamState('view', VIEWS, 'general')
    return (
      <>
        <SubNav kind="nav" groups={GROUPS} value={view} onValueChange={(id) => setView(id as (typeof VIEWS)[number])} ariaLabel="Views" />
        <Probe />
      </>
    )
  }

  function renderAt(url: string) {
    return render(
      <MemoryRouter initialEntries={[url]}>
        <Page />
      </MemoryRouter>,
    )
  }

  it('opens on the view a reload or a link carries', () => {
    renderAt('/mods?view=users')
    const nav = screen.getByRole('navigation', { name: 'Views' })
    expect(within(nav).getByRole('button', { name: /Users/ })).toHaveAttribute('aria-current', 'true')
  })

  it('reads an unknown value as the fallback', () => {
    renderAt('/mods?view=nope')
    const nav = screen.getByRole('navigation', { name: 'Views' })
    expect(within(nav).getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'true')
  })

  it('writes the choice with replace and keeps the other parameters', () => {
    renderAt('/mods?review=unresolved&view=general')
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Views' })).getByRole('button', { name: 'About' }))
    const url = screen.getByTestId('url').textContent ?? ''
    expect(url.startsWith('REPLACE /mods?')).toBe(true)
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('view')).toBe('about')
    expect(params.get('review')).toBe('unresolved')
    expect(within(screen.getByRole('navigation', { name: 'Views' })).getByRole('button', { name: 'About' })).toHaveAttribute('aria-current', 'true')
  })
})
