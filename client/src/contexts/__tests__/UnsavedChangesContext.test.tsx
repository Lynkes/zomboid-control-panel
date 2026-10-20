import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Link, MemoryRouter, useLocation } from 'react-router-dom'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { UnsavedChangesProvider, useGuardedNavigate, useUnsavedChangesGuard } from '../UnsavedChangesContext'

// The unsaved-changes guard (UX plan §1 D9, §2.7): a sidebar click used to
// drop a dirty Settings, ServerConfig or Discord form without a word, and
// BrowserRouter rules out useBlocker. Every in-app link and every guarded
// navigate must now ask first while a page holds unsaved edits.

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

function DirtyForm({ dirty, message }: { dirty: boolean; message?: string }) {
  useUnsavedChangesGuard(dirty, { message })
  return null
}

function GuardedButton({ to }: { to: string }) {
  const navigate = useGuardedNavigate()
  return <button type="button" onClick={() => void navigate(to)}>go {to}</button>
}

function renderApp({ dirty, message, at = '/settings' }: { dirty: boolean; message?: string; at?: string }) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <ConfirmProvider>
        <UnsavedChangesProvider>
          <DirtyForm dirty={dirty} message={message} />
          <Link to="/servers">Servers</Link>
          <Link to="/settings?tab=roles">Roles tab</Link>
          <GuardedButton to="/mods" />
          <Where />
        </UnsavedChangesProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  )
}

const where = () => screen.getByTestId('where').textContent

afterEach(() => cleanup())

describe('UnsavedChangesProvider: links', () => {
  it('lets a link through at once when nothing is dirty', () => {
    renderApp({ dirty: false })
    fireEvent.click(screen.getByRole('link', { name: 'Servers' }))
    expect(where()).toBe('/servers')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('stops a link to another page while dirty and stays when the operator keeps editing', async () => {
    renderApp({ dirty: true })
    fireEvent.click(screen.getByRole('link', { name: 'Servers' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Leave without saving?')).toBeInTheDocument()
    expect(where()).toBe('/settings')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    await act(async () => {})
    expect(where()).toBe('/settings')
  })

  it('follows the same link once the operator chooses to discard', async () => {
    renderApp({ dirty: true })
    fireEvent.click(screen.getByRole('link', { name: 'Servers' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard and leave' }))
    await act(async () => {})
    expect(where()).toBe('/servers')
  })

  it('shows the page\'s own message when it gave one', async () => {
    renderApp({ dirty: true, message: 'The INI edits for Alpha are not saved.' })
    fireEvent.click(screen.getByRole('link', { name: 'Servers' }))
    expect(await screen.findByText('The INI edits for Alpha are not saved.')).toBeInTheDocument()
  })

  it('does not ask for a link that stays on the same page (another ?tab=)', () => {
    renderApp({ dirty: true })
    fireEvent.click(screen.getByRole('link', { name: 'Roles tab' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(where()).toBe('/settings?tab=roles')
  })

  it('leaves a modified click (new tab) to the browser', () => {
    renderApp({ dirty: true })
    fireEvent.click(screen.getByRole('link', { name: 'Servers' }), { ctrlKey: true })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})

describe('useGuardedNavigate', () => {
  it('asks before navigating away while dirty', async () => {
    renderApp({ dirty: true })
    fireEvent.click(screen.getByRole('button', { name: 'go /mods' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(where()).toBe('/settings')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard and leave' }))
    await act(async () => {})
    expect(where()).toBe('/mods')
  })

  it('navigates straight away when clean', async () => {
    renderApp({ dirty: false })
    fireEvent.click(screen.getByRole('button', { name: 'go /mods' }))
    await act(async () => {})
    expect(where()).toBe('/mods')
  })

  it('works without the provider (pages rendered alone in tests)', () => {
    render(
      <MemoryRouter initialEntries={['/a']}>
        <DirtyForm dirty />
        <GuardedButton to="/b" />
        <Where />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'go /b' }))
    expect(where()).toBe('/b')
  })
})

describe('useUnsavedChangesGuard: closing the tab', () => {
  it('asks the browser to confirm only while dirty', () => {
    const { rerender } = render(
      <MemoryRouter>
        <DirtyForm dirty />
      </MemoryRouter>,
    )
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)

    rerender(
      <MemoryRouter>
        <DirtyForm dirty={false} />
      </MemoryRouter>,
    )
    const after = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })
})
