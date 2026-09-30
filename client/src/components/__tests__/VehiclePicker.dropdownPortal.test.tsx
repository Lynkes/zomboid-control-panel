import { useState, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { VehiclePicker, type CatalogVehicle } from '../VehiclePicker'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { panelBridgeApi } from '@/lib/api'

// Same class of bug as ItemPicker's (see ItemPicker.dropdownPortal.test.tsx):
// VehiclePicker's dropdown was a plain `absolute top-full`/`bottom-full`
// panel about 400px tall that flipped up whenever less than 340px was left
// below, with no check that the space above was any bigger. In World Map's
// ~200px Spawn Vehicle dialog it either got clipped by DialogContent's
// scroll box or, with the dialog opted out to overflow-visible, ran off the
// top or bottom of a short window (v1.4.0 shipped that as a known
// limitation). It now uses the same <body>-level, window-bounded popover.
// jsdom does no layout: these tests pin the structure that bounds it.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getCatalogVehicles: vi.fn(),
      scanCatalogVehicles: vi.fn(),
    },
  }
})

const getCatalogVehicles = vi.mocked(panelBridgeApi.getCatalogVehicles)

// jsdom has no scrollIntoView; the highlighted-row effect calls it.
Element.prototype.scrollIntoView = vi.fn()

// Shown grouped by type: Sedan (Sedans) first, then Pickup (Trucks) -- the
// reverse of their name order.
const VEHICLES: CatalogVehicle[] = [
  { id: 'Base.CarNormal', name: 'Sedan', mass: 1200, seats: 4 },
  { id: 'Base.PickUpTruck', name: 'Pickup', mass: 1800, seats: 2 },
]

beforeEach(() => {
  getCatalogVehicles.mockReset()
  getCatalogVehicles.mockResolvedValue({ vehicles: VEHICLES, count: VEHICLES.length, scannedAt: null })
})

// A controlled host Dialog, like WorldMap's Spawn Vehicle dialog: it really
// closes when Radix asks it to, and onOpenChange records every request. A
// bare `<Dialog open>` can't close, so "still there" would prove nothing.
function HostDialog({ onOpenChange, children }: { onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <Dialog open={open} onOpenChange={next => { onOpenChange(next); setOpen(next) }}>
      {children}
    </Dialog>
  )
}

async function openInDialog() {
  const onChange = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <HostDialog onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Spawn Vehicle</DialogTitle>
          <DialogDescription>Pick one</DialogDescription>
        </DialogHeader>
        <VehiclePicker value="" onChange={onChange} />
      </DialogContent>
    </HostDialog>,
  )
  const hostDialog = screen.getByRole('dialog', { name: 'Spawn Vehicle' })
  fireEvent.click(await screen.findByRole('combobox', { name: 'Select vehicle' }))
  const listbox = await screen.findByRole('listbox')
  const popover = screen.getByRole('dialog', { name: 'Select vehicle' })
  const search = screen.getByRole('combobox', { name: 'Filter vehicles' })
  await waitFor(() => expect(document.activeElement).toBe(search))
  return { hostDialog, listbox, popover, search, onChange, onOpenChange }
}

describe('VehiclePicker: the dropdown always fits the window', () => {
  it('renders in a <body>-level, fixed-position popover outside the host Dialog', async () => {
    const { hostDialog, listbox, popover } = await openInDialog()
    expect(popover.contains(listbox)).toBe(true)
    expect(hostDialog.contains(popover)).toBe(false)
    const wrapper = popover.parentElement!
    expect(wrapper).toHaveAttribute('data-radix-popper-content-wrapper')
    expect(wrapper.parentElement).toBe(document.body)
    expect(wrapper.style.position).toBe('fixed')
  })

  it('has one bounded height with the search pinned and only the list scrolling', async () => {
    const { listbox, popover } = await openInDialog()
    expect(popover.className).toContain('h-[25rem]')
    expect(popover.className).toContain('max-h-[var(--radix-popover-content-available-height)]')
    expect(popover.className).toContain('flex-col')
    expect(popover.className).toContain('overflow-hidden')

    const searchRow = screen.getByRole('combobox', { name: 'Filter vehicles' }).parentElement!
    expect(searchRow.parentElement).toBe(popover)
    expect(searchRow.className).toContain('shrink-0')

    expect(listbox.parentElement).toBe(popover)
    expect(listbox.className).toContain('flex-1')
    expect(listbox.className).toContain('min-h-0')
    expect(listbox.className).toContain('overflow-y-auto')
    // The old fixed list cap is gone; the window decides.
    expect(listbox.className).not.toContain('max-h-[320px]')
  })

  it('picking a vehicle selects it, closes the list and leaves the host Dialog open', async () => {
    const { hostDialog, onChange, onOpenChange } = await openInDialog()
    fireEvent.click(screen.getByRole('option', { name: /pickup/i }))
    expect(onChange).toHaveBeenCalledWith('Base.PickUpTruck')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(hostDialog).toBeInTheDocument()
  })

  it('Escape closes only the picker and returns focus to its trigger', async () => {
    const { hostDialog, popover, search, onOpenChange } = await openInDialog()
    fireEvent.keyDown(search, { key: 'Escape' })
    await waitFor(() => expect(popover).not.toBeInTheDocument())
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(hostDialog).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Select vehicle' })))
  })

  it('a press outside the picker, in the Dialog or past it, closes only the picker', async () => {
    const { hostDialog, popover, onOpenChange } = await openInDialog()
    await new Promise(resolve => setTimeout(resolve, 0))
    fireEvent.pointerDown(screen.getByText('Spawn Vehicle'))
    fireEvent.click(screen.getByText('Spawn Vehicle'))
    await waitFor(() => expect(popover).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('combobox', { name: 'Select vehicle' }))
    const reopened = await screen.findByRole('dialog', { name: 'Select vehicle' })
    await new Promise(resolve => setTimeout(resolve, 0))
    fireEvent.pointerDown(document.body)
    fireEvent.click(document.body)
    await waitFor(() => expect(reopened).not.toBeInTheDocument())

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(hostDialog).toBeInTheDocument()
  })

  // The arrow and Enter keys are handled next to the trigger, and reach it
  // from the <body>-level portal only because React bubbles key events to a
  // portal's React parent. This pins that path.
  it('selects from the portaled search box with the keyboard, inside the Dialog', async () => {
    const { hostDialog, search, onChange, onOpenChange } = await openInDialog()

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(search).toHaveAttribute('aria-activedescendant', 'vehpicker-opt-1')
    fireEvent.keyDown(search, { key: 'Enter' })

    // The second row shown (Trucks come after Sedans), not the second name.
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('Base.PickUpTruck')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Select vehicle' })))
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(hostDialog).toBeInTheDocument()
  })

  it('the arrows walk the rows in the order they are shown, across type groups', async () => {
    const { search } = await openInDialog()
    const rows = screen.getAllByRole('option')
    expect(rows.map(r => r.textContent)).toEqual([expect.stringContaining('Sedan'), expect.stringContaining('Pickup')])

    for (const row of rows) {
      fireEvent.keyDown(search, { key: 'ArrowDown' })
      expect(document.getElementById(search.getAttribute('aria-activedescendant')!)).toBe(row)
    }
  })

  it("leaves Enter alone on the popover's own buttons, so Enter presses them", async () => {
    const { listbox, search, onChange } = await openInDialog()
    fireEvent.change(search, { target: { value: 'pick' } })
    for (const name of ['Clear search', 'Re-scan server vehicles']) {
      const button = screen.getByRole('button', { name })
      // fireEvent returns false when the handler called preventDefault.
      expect(fireEvent.keyDown(button, { key: 'ArrowDown' })).toBe(true)
      expect(fireEvent.keyDown(button, { key: 'Enter' })).toBe(true)
    }
    expect(search).not.toHaveAttribute('aria-activedescendant')
    expect(onChange).not.toHaveBeenCalled()
    expect(listbox).toBeInTheDocument()
  })

  it('compiles its size classes to real CSS', async () => {
    const { popover } = await openInDialog()
    const { css } = await postcss([
      tailwindcss({ content: [{ raw: popover.className }], corePlugins: { preflight: false } }),
    ]).process('@tailwind utilities;', { from: undefined })
    const compact = css.replace(/\s+/g, ' ')
    expect(compact).toMatch(/height: 25rem/)
    expect(compact).toMatch(/width: max\(var\(--radix-popover-trigger-width\), ?25rem\)/)
    expect(compact).toMatch(/max-height: var\(--radix-popover-content-available-height\)/)
  })
})
