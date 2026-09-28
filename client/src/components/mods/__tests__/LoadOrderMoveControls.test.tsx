import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LoadOrderMoveControls } from '../LoadOrderMoveControls'

// Discord request: "When you add a new mod which should be loaded first ...
// you need to drag the mod all the way up and scroll and drag... Would be
// nice to have a button to at least move it top or bottom." These controls
// sit on every Load Order row; the page-level save path is covered in
// pages/__tests__/Mods.loadOrderMoveControls.test.tsx.

afterEach(() => {
  cleanup()
})

function renderControls(index: number, total: number, onMove = vi.fn()) {
  render(
    <TooltipProvider>
      <LoadOrderMoveControls index={index} total={total} modId="NewMod" onMove={onMove} />
    </TooltipProvider>,
  )
  return onMove
}

const control = (name: string) => screen.getByRole('button', { name })

describe('LoadOrderMoveControls', () => {
  it('names the mod in every control and reports which move was asked for', () => {
    const onMove = renderControls(5, 10)

    fireEvent.click(control('Move NewMod to the top'))
    fireEvent.click(control('Move NewMod up'))
    fireEvent.click(control('Move NewMod down'))
    fireEvent.click(control('Move NewMod to the bottom'))

    // The row's index comes back with the move so the page can pass one
    // stable callback to every (memoized) row.
    expect(onMove.mock.calls).toEqual([[5, 'top'], [5, 'up'], [5, 'down'], [5, 'bottom']])
  })

  it('gives each enabled icon button a short hover hint', () => {
    renderControls(5, 10)

    expect(control('Move NewMod to the top')).toHaveAttribute('title', 'Move to top')
    expect(control('Move NewMod up')).toHaveAttribute('title', 'Move up one place')
    expect(control('Move NewMod down')).toHaveAttribute('title', 'Move down one place')
    expect(control('Move NewMod to the bottom')).toHaveAttribute('title', 'Move to bottom')
  })

  it('disables top/up on the first row and says why instead of no-opping', async () => {
    const onMove = renderControls(0, 10)

    expect(control('Move NewMod to the top')).toBeDisabled()
    expect(control('Move NewMod up')).toBeDisabled()
    expect(control('Move NewMod down')).toBeEnabled()
    expect(control('Move NewMod to the bottom')).toBeEnabled()

    fireEvent.click(control('Move NewMod to the top'))
    expect(onMove).not.toHaveBeenCalled()

    // DisabledReason: the focusable wrapper span is the tooltip trigger, since
    // a disabled button fires no hover/focus events of its own -- which is
    // also why the disabled button carries no (dead) title.
    expect(control('Move NewMod to the top')).not.toHaveAttribute('title')
    const wrapper = control('Move NewMod to the top').parentElement!
    expect(wrapper).toHaveAttribute('tabindex', '0')
    fireEvent.focus(wrapper)
    expect((await screen.findAllByText('Already first in the load order')).length).toBeGreaterThan(0)
  })

  it('disables down/bottom on the last row with the matching reason', async () => {
    const onMove = renderControls(9, 10)

    expect(control('Move NewMod to the top')).toBeEnabled()
    expect(control('Move NewMod up')).toBeEnabled()
    expect(control('Move NewMod down')).toBeDisabled()
    expect(control('Move NewMod to the bottom')).toBeDisabled()

    fireEvent.click(control('Move NewMod to the bottom'))
    expect(onMove).not.toHaveBeenCalled()

    fireEvent.focus(control('Move NewMod to the bottom').parentElement!)
    expect((await screen.findAllByText('Already last in the load order')).length).toBeGreaterThan(0)
  })

  it('has every control disabled when the mod is the only one in the list', () => {
    renderControls(0, 1)

    for (const name of ['Move NewMod to the top', 'Move NewMod up', 'Move NewMod down', 'Move NewMod to the bottom']) {
      expect(control(name)).toBeDisabled()
    }
  })

  it('tags each control with its move so the page can re-focus it after the row jumps', () => {
    renderControls(5, 10)

    expect(control('Move NewMod to the top')).toHaveAttribute('data-move-action', 'top')
    expect(control('Move NewMod up')).toHaveAttribute('data-move-action', 'up')
    expect(control('Move NewMod down')).toHaveAttribute('data-move-action', 'down')
    expect(control('Move NewMod to the bottom')).toHaveAttribute('data-move-action', 'bottom')
  })
})
