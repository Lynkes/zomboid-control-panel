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

const VEHICLES: CatalogVehicle[] = [
  { id: 'Base.CarNormal', name: 'Sedan', mass: 1200, seats: 4 },
  { id: 'Base.PickUpTruck', name: 'Pickup', mass: 1800, seats: 2 },
]

beforeEach(() => {
  getCatalogVehicles.mockReset()
  getCatalogVehicles.mockResolvedValue({ vehicles: VEHICLES, count: VEHICLES.length, scannedAt: null })
})

async function openInDialog() {
  const onChange = vi.fn()
  render(
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Spawn Vehicle</DialogTitle>
          <DialogDescription>Pick one</DialogDescription>
        </DialogHeader>
        <VehiclePicker value="" onChange={onChange} />
      </DialogContent>
    </Dialog>,
  )
  const hostDialog = screen.getByRole('dialog', { name: 'Spawn Vehicle' })
  fireEvent.click(await screen.findByRole('combobox', { name: 'Select vehicle' }))
  const listbox = await screen.findByRole('listbox')
  const popover = screen.getByRole('dialog', { name: 'Select vehicle' })
  return { hostDialog, listbox, popover, onChange }
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

    const searchRow = screen.getByRole('textbox', { name: 'Filter vehicles' }).parentElement!
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
    const { hostDialog, onChange } = await openInDialog()
    fireEvent.click(screen.getByRole('option', { name: /pickup/i }))
    expect(onChange).toHaveBeenCalledWith('Base.PickUpTruck')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(hostDialog).toBeInTheDocument()
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
