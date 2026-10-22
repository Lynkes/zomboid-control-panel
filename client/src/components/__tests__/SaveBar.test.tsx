import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SaveBar } from '../SaveBar'

// The one save affordance of a form (UX plan §2.4.6): a sticky bar that
// shows only with unsaved edits, saves on Ctrl/Cmd+S, says why Save can't
// run, and keeps the page's own Save wording so page tests keep their names.

afterEach(() => cleanup())

describe('SaveBar', () => {
  it('renders nothing while the form is clean', () => {
    const { container } = render(<SaveBar dirty={false} saving={false} onSave={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says there are unsaved changes, with the count when the page knows it', () => {
    const { rerender } = render(<SaveBar dirty saving={false} onSave={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes')
    rerender(<SaveBar dirty saving={false} onSave={vi.fn()} changeCount={3} />)
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes: 3')
  })

  it('saves from the button and from Ctrl+S or Cmd+S', () => {
    const onSave = vi.fn()
    render(<SaveBar dirty saving={false} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    expect(onSave).toHaveBeenCalledTimes(3)
  })

  it('keeps the page\'s own Save wording as the accessible name', () => {
    render(<SaveBar dirty saving={false} onSave={vi.fn()} saveLabel="Save Settings" />)
    expect(screen.getByRole('button', { name: 'Save Settings' })).toBeInTheDocument()
  })

  it('offers Discard only when the page can discard', () => {
    const onDiscard = vi.fn()
    const { rerender } = render(<SaveBar dirty saving={false} onSave={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
    rerender(<SaveBar dirty saving={false} onSave={vi.fn()} onDiscard={onDiscard} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onDiscard).toHaveBeenCalledOnce()
  })

  it('disables Save with the reason, and Ctrl+S does nothing then', () => {
    const onSave = vi.fn()
    render(<SaveBar dirty saving={false} onSave={onSave} disabledReason="Fix the 2 invalid values first" />)
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect(onSave).not.toHaveBeenCalled()
    // DisabledReason's focusable wrapper carries the tooltip trigger.
    expect(screen.getByRole('button', { name: 'Save changes' }).parentElement).toHaveAttribute('tabindex', '0')
  })

  it('shows progress while saving and does not save twice', () => {
    const onSave = vi.fn()
    render(<SaveBar dirty saving onSave={onSave} />)
    expect(screen.getByRole('status')).toHaveTextContent('Saving…')
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('guards the tab against closing while dirty (beforeunload), and stops once clean', () => {
    const { rerender } = render(<SaveBar dirty saving={false} onSave={vi.fn()} />)
    const dirtyEvent = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirtyEvent)
    expect(dirtyEvent.defaultPrevented).toBe(true)

    rerender(<SaveBar dirty={false} saving={false} onSave={vi.fn()} />)
    const cleanEvent = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(cleanEvent)
    expect(cleanEvent.defaultPrevented).toBe(false)
  })
})
