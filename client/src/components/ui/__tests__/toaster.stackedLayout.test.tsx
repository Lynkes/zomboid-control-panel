import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Toaster } from '../toaster'
import { ToastAction } from '../toast'
import { toast } from '../use-toast'

// 2026-10-01 review finding: Settings › Updates' "Update Not Applied" toast
// put its "Open Dashboard" button beside a 300-460 character message, and the
// toast's flex row squeezed the text into a column ~13 characters wide in
// Ukrainian (694 px tall at 1280x800) -- unreadable in its 15 s. A toast can
// now ask for its action under the message instead.

function renderToast(options: Parameters<typeof toast>[0]) {
  render(<Toaster />)
  act(() => {
    toast(options)
  })
  return screen.getByText(String(options.title)).closest('li') as HTMLElement
}

afterEach(() => {
  cleanup()
})

describe('Toaster layout', () => {
  it('"stacked" puts the action under the message, full width', () => {
    const root = renderToast({
      title: 'Update Not Applied',
      description: 'A long message that needs the whole width of the toast to stay readable.',
      variant: 'destructive',
      layout: 'stacked',
      action: <ToastAction altText="Open the Dashboard">Open Dashboard</ToastAction>,
    })

    expect(root).toHaveAttribute('data-layout', 'stacked')
    expect(root.className).toContain('flex-col')
    expect(root.className).toContain('items-stretch')
    expect(root.className).not.toContain('items-center')
    // The action sits after the message, in its own row.
    const action = screen.getByRole('button', { name: 'Open Dashboard' })
    const message = screen.getByText(/A long message/)
    expect(message.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(action.parentElement?.className).toContain('justify-end')
  })

  it('every other toast keeps the action beside the message', () => {
    const root = renderToast({
      title: 'Saved',
      description: 'Short.',
      action: <ToastAction altText="Undo">Undo</ToastAction>,
    })

    expect(root).not.toHaveAttribute('data-layout')
    expect(root.className).not.toContain('flex-col')
    expect(root.className).toContain('items-center')
  })
})
