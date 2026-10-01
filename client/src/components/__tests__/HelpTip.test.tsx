import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { HelpTip } from '../HelpTip'

function renderTip(children = 'Explains the thing.') {
  return render(
    <TooltipProvider>
      <HelpTip label="Widget Name">{children}</HelpTip>
    </TooltipProvider>,
  )
}

describe('HelpTip', () => {
  it('has a distinguishing accessible name naming the field it explains, not a bare icon', () => {
    renderTip()
    expect(screen.getByRole('button', { name: 'Help: Widget Name' })).toBeInTheDocument()
  })

  it('is reachable and toggleable by keyboard, not just a mouse hover target', async () => {
    renderTip()
    const trigger = screen.getByRole('button', { name: 'Help: Widget Name' })
    expect(document.body).not.toHaveTextContent('Explains the thing.')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.getByText('Explains the thing.')).toBeInTheDocument())
  })

  it('opens on a plain click — the touch path, which has no hover state to fall back on', async () => {
    renderTip('Tap-to-open content.')
    const trigger = screen.getByRole('button', { name: 'Help: Widget Name' })
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.getByText('Tap-to-open content.')).toBeInTheDocument())
  })

  it('renders nothing extra until opened', () => {
    renderTip('Hidden until opened.')
    expect(screen.queryByText('Hidden until opened.')).not.toBeInTheDocument()
  })
})

// 2026-09 dialog sweep: a dialog moves focus to its first tabbable element
// on open. When that was a HelpTip (Saved Configs' title, Delete role's "Move
// members to", the mount-discovery Connect dialog), Radix Tooltip's
// open-on-focus popped the tip over the dialog's title and description on
// every open. That focus no longer opens it; a user's own focus still does.
describe('HelpTip as the first thing in a dialog', () => {
  function renderDialog() {
    return render(
      <TooltipProvider>
        <Dialog open>
          <DialogContent>
            <DialogTitle>
              Saved configs <HelpTip label="Saved configs">Applying replaces everything.</HelpTip>
            </DialogTitle>
            <DialogDescription>Pick one.</DialogDescription>
            <button type="button">Save current</button>
          </DialogContent>
        </Dialog>
      </TooltipProvider>,
    )
  }

  it("takes the dialog's opening focus without opening its tooltip", async () => {
    renderDialog()
    const trigger = screen.getByRole('button', { name: 'Help: Saved configs' })
    await waitFor(() => expect(trigger).toHaveFocus())
    // Let any open the focus might have scheduled happen.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('still opens when the user moves focus onto it', async () => {
    renderDialog()
    const trigger = screen.getByRole('button', { name: 'Help: Saved configs' })
    await waitFor(() => expect(trigger).toHaveFocus())
    screen.getByRole('button', { name: 'Save current' }).focus()
    trigger.focus()
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Applying replaces everything.'))
  })
})
