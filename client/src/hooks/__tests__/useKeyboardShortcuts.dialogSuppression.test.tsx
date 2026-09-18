import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { useKeyboardShortcuts, usePageShortcut } from '../useKeyboardShortcuts'

// bug-hunt-2026-09-18 (dashboard keyboard use): a Radix Dialog/AlertDialog
// (e.g. Dashboard's Force-Stop/Wipe-Server confirmations) traps Tab-cycling
// inside itself but does not stop other keys from bubbling to these
// window-level listeners, and moves focus onto a non-input element inside
// the dialog -- so isInputFocused() alone never saw it open. Before this
// fix, pressing a digit while a destructive-action confirmation was open
// navigated the whole app out from under it instead of the keystroke
// reaching the dialog.

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="path">{location.pathname}</div>
}

function GlobalShortcutHarness() {
  useKeyboardShortcuts()
  return null
}

function PageShortcutHarness({ onTrigger }: { onTrigger: () => void }) {
  usePageShortcut('r', onTrigger)
  return null
}

function renderAt(path: string, children: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <LocationProbe />
              {children}
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('keyboard shortcuts suppress while a modal dialog is open', () => {
  afterEach(() => {
    cleanup()
    document.querySelectorAll('[role="dialog"], [role="alertdialog"]').forEach(el => el.remove())
  })

  it('does not navigate on a digit-key shortcut while an alertdialog is open', () => {
    const { getByTestId } = renderAt('/console', <GlobalShortcutHarness />)
    expect(getByTestId('path').textContent).toBe('/console')

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'alertdialog')
    document.body.appendChild(dialog)

    fireEvent.keyDown(window, { key: '1' })
    expect(getByTestId('path').textContent).toBe('/console')

    dialog.remove()
    fireEvent.keyDown(window, { key: '1' })
    expect(getByTestId('path').textContent).toBe('/')
  })

  it('does not fire a page shortcut while a dialog is open, even without a focused input', () => {
    const onTrigger = vi.fn()
    renderAt('/', <PageShortcutHarness onTrigger={onTrigger} />)

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)

    fireEvent.keyDown(window, { key: 'r' })
    expect(onTrigger).not.toHaveBeenCalled()

    dialog.remove()
    fireEvent.keyDown(window, { key: 'r' })
    expect(onTrigger).toHaveBeenCalledTimes(1)
  })
})
