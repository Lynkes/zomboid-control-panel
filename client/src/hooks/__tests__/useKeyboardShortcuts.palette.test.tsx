import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { useKeyboardShortcuts } from '../useKeyboardShortcuts'

// Ctrl/Cmd+K opens the command palette from anywhere, even a focused field,
// but never on top of another dialog (UX plan §2.7). The `?` list names the
// palette and the "/" search key, and the digits by their sidebar names.

const wrapper = ({ children }: { children: React.ReactNode }) => createElement(MemoryRouter, null, children)

afterEach(() => {
  cleanup()
  document.querySelectorAll('[role="dialog"], [role="alertdialog"], input').forEach((el) => el.remove())
})

describe('useKeyboardShortcuts: command palette', () => {
  it('toggles the palette with Ctrl+K and Cmd+K', () => {
    const { result } = renderHook(() => useKeyboardShortcuts(), { wrapper })
    expect(result.current.paletteOpen).toBe(false)
    act(() => { fireEvent.keyDown(window, { key: 'k', ctrlKey: true }) })
    expect(result.current.paletteOpen).toBe(true)
    act(() => { fireEvent.keyDown(window, { key: 'K', metaKey: true }) })
    expect(result.current.paletteOpen).toBe(false)
  })

  it('opens from inside a text field too', () => {
    const { result } = renderHook(() => useKeyboardShortcuts(), { wrapper })
    const { getByRole } = render(createElement('input', { 'aria-label': 'field' }))
    getByRole('textbox').focus()
    act(() => { fireEvent.keyDown(getByRole('textbox'), { key: 'k', ctrlKey: true }) })
    expect(result.current.paletteOpen).toBe(true)
  })

  it('does not open over another open dialog', () => {
    const { result } = renderHook(() => useKeyboardShortcuts(), { wrapper })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'alertdialog')
    document.body.appendChild(dialog)
    act(() => { fireEvent.keyDown(window, { key: 'k', ctrlKey: true }) })
    expect(result.current.paletteOpen).toBe(false)
  })

  it('lists the palette, "/" search and the pages by their sidebar names', () => {
    const { result } = renderHook(() => useKeyboardShortcuts(), { wrapper })
    const byKey = Object.fromEntries(result.current.shortcuts.map((s) => [s.key, s.label]))
    expect(byKey['Ctrl+K']).toBe('Open the command palette')
    expect(byKey['/']).toBe('Focus search')
    expect(byKey['2']).toBe('Console')
    expect(byKey['8']).toBe('Configuration')
    expect(byKey['9']).toBe('Settings')
  })
})
