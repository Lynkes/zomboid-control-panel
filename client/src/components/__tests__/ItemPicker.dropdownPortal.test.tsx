import { useState, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { ItemPicker, type CatalogItem } from '../ItemPicker'
import {
  Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/dialog'
import { panelBridgeApi } from '@/lib/api'

// 2026-09 community report (v1.4.0, World Map > Custom item drop: "the panel
// does not appear in full when searching for items"). Root cause: the
// dropdown was portaled INTO the host Dialog (to stay inside its focus trap)
// and placed with hand-computed `position: fixed` coordinates. DialogContent
// is translate-centered and overflow-y-auto, which makes it both the
// containing block and the clip for that panel: whatever reached past the
// dialog's box was cut off (in the report, the bottom of the list, and the
// right edge of a 760px panel in a 576px dialog), and scrolling the dialog
// to reach it moved the panel away from its field. The height budget also
// ignored the room actually left: a 200px floor, a flip only below 280px,
// and a fixed min(520px, 60vh) list inside a panel that scrolled as a whole,
// taking the search box with it.
//
// Now the dropdown is a modal Radix popover (ui/popover.tsx) portaled to
// <body>: Radix's popper flips it to the roomier side, keeps it 8px inside
// the window and reports the room left, which bounds its height; the search
// bar is pinned and the sidebar and list scroll inside. jsdom does no
// layout, so these tests pin that structure (where it renders, which
// classes bound it and scroll it, that Tailwind compiles them, and how it
// behaves inside a Dialog); the pixels were checked in a real browser.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getCatalogItems: vi.fn(),
      scanCatalogItems: vi.fn(),
    },
  }
})

const getCatalogItems = vi.mocked(panelBridgeApi.getCatalogItems)

// jsdom has no scrollIntoView; the highlighted-row effect calls it.
Element.prototype.scrollIntoView = vi.fn()

// Sorted by name in the list: Axe, Bandage, Crowbar.
const ITEMS: CatalogItem[] = [
  { id: 'Base.Crowbar', name: 'Crowbar', category: 'WeaponPrimitive', weight: 2 },
  { id: 'Base.Axe', name: 'Axe', category: 'WeaponPrimitive', weight: 3 },
  { id: 'Base.Bandage', name: 'Bandage', category: 'Bandage', weight: 0.1 },
]

beforeEach(() => {
  getCatalogItems.mockReset()
  getCatalogItems.mockResolvedValue({ items: ITEMS, count: ITEMS.length, scannedAt: '2026-09-20T00:00:00.000Z' })
})

// A controlled host Dialog, like WorldMap's: it really closes when Radix asks
// it to, and onOpenChange records every request. A bare `<Dialog open>`
// can't close at all, so "the host Dialog is still there" proves nothing on
// it.
function HostDialog({ onOpenChange, children }: { onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <Dialog open={open} onOpenChange={next => { onOpenChange(next); setOpen(next) }}>
      {children}
    </Dialog>
  )
}

// The Custom item drop dialog's shape: the picker sits in a capped,
// scrolling rows list inside a DialogBody inside DialogContent -- three
// clipping boxes deep.
function renderInDialog(onChange = vi.fn(), value = '') {
  const onOpenChange = vi.fn()
  render(
    <HostDialog onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Custom item drop</DialogTitle>
          <DialogDescription>Drop items here</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div data-testid="rows" className="max-h-72 overflow-y-auto">
            <ItemPicker value={value} onChange={onChange} />
          </div>
        </DialogBody>
        <DialogFooter>
          <button type="button">Drop</button>
        </DialogFooter>
      </DialogContent>
    </HostDialog>,
  )
  return { onChange, onOpenChange, hostDialog: screen.getByRole('dialog', { name: 'Custom item drop' }) }
}

async function openPicker() {
  fireEvent.click(await screen.findByRole('combobox', { name: 'Select item' }))
  const listbox = await screen.findByRole('listbox')
  const popover = screen.getByRole('dialog', { name: 'Select item' })
  return { listbox, popover }
}

describe('ItemPicker: the dropdown always fits the window', () => {
  it('renders in a <body>-level, fixed-position popover, outside the host Dialog and every scroll box around the trigger', async () => {
    const { hostDialog } = renderInDialog()
    const { listbox, popover } = await openPicker()

    expect(popover.contains(listbox)).toBe(true)
    expect(hostDialog.contains(popover)).toBe(false)
    expect(screen.getByTestId('rows').contains(popover)).toBe(false)

    const wrapper = popover.parentElement!
    expect(wrapper).toHaveAttribute('data-radix-popper-content-wrapper')
    expect(wrapper.parentElement).toBe(document.body)
    expect(wrapper.style.position).toBe('fixed')
    // Collision-aware placement is live: Radix placed it on a side and wired
    // the available-room variables its bound reads.
    expect(popover).toHaveAttribute('data-side')
    expect(popover.style.getPropertyValue('--radix-popover-content-available-height')).not.toBe('')
  })

  it('has one bounded height with the search bar pinned, and the sidebar and the list scrolling inside it', async () => {
    renderInDialog()
    const { listbox, popover } = await openPicker()

    // Bounded: its own height, capped by the room left in the window.
    expect(popover.className).toContain('h-[34rem]')
    expect(popover.className).toContain('max-h-[var(--radix-popover-content-available-height)]')
    // A flex column that doesn't scroll as a whole (that took the search box
    // with it)...
    expect(popover.className).toMatch(/(^|\s)flex(\s|$)/)
    expect(popover.className).toContain('flex-col')
    expect(popover.className).toContain('overflow-hidden')
    expect(popover.className).not.toContain('overflow-y-auto')
    // ...and nothing inside sets its own fixed height cap any more (the old
    // inline min(520px, 60vh)).
    expect(popover.querySelector('[style*="max-height"]')).toBeNull()

    // The search bar is a fixed row of the column, not inside any scroller.
    const search = screen.getByRole('combobox', { name: 'Filter items' })
    const searchRow = search.parentElement!
    expect(searchRow.parentElement).toBe(popover)
    expect(searchRow.className).toContain('shrink-0')

    // The sidebar + list row takes the rest and may shrink below its content.
    const bodyRow = listbox.parentElement!
    expect(bodyRow.parentElement).toBe(popover)
    expect(bodyRow.className).toContain('flex-1')
    expect(bodyRow.className).toContain('min-h-0')
    // Both columns scroll on their own.
    expect(listbox.className).toContain('overflow-y-auto')
    const sidebar = screen.getByRole('button', { name: /all items/i }).parentElement!
    expect(sidebar.parentElement).toBe(bodyRow)
    expect(sidebar.className).toContain('overflow-y-auto')
  })

  it('works as a modal inside the Dialog: focus goes to the search box, Escape closes only the picker and returns focus', async () => {
    const { hostDialog, onOpenChange } = renderInDialog()
    const { popover } = await openPicker()
    const search = screen.getByRole('combobox', { name: 'Filter items' })

    // The Dialog's focus trap doesn't pull focus back out of the portaled
    // search box, and the Dialog's scroll lock is handed to the popover (a
    // modal popover takes it over and hides the rest from assistive tech).
    await waitFor(() => expect(document.activeElement).toBe(search))
    expect(hostDialog).toHaveAttribute('aria-hidden', 'true')

    fireEvent.keyDown(search, { key: 'Escape' })
    await waitFor(() => expect(popover).not.toBeInTheDocument())
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(hostDialog).toBeInTheDocument()
    expect(hostDialog).not.toHaveAttribute('aria-hidden')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Select item' })))
  })

  it('picking an item in the portaled list selects it and leaves the host Dialog open', async () => {
    const { onChange, onOpenChange, hostDialog } = renderInDialog()
    await openPicker()

    fireEvent.click(screen.getByRole('option', { name: /bandage/i }))

    expect(onChange).toHaveBeenCalledWith('Base.Bandage')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(hostDialog).toBeInTheDocument()
  })

  it('a click inside the panel keeps it open; a click outside closes it', async () => {
    render(<ItemPicker value="" onChange={vi.fn()} />)
    const { popover } = await openPicker()
    // Radix starts listening for outside presses a tick after opening.
    await new Promise(resolve => setTimeout(resolve, 0))

    const search = screen.getByRole('combobox', { name: 'Filter items' })
    fireEvent.pointerDown(search)
    fireEvent.click(search)
    expect(popover).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    fireEvent.click(document.body)
    await waitFor(() => expect(popover).not.toBeInTheDocument())
  })

  it('a press outside the picker, in the Dialog or past it, closes only the picker', async () => {
    const { hostDialog, onOpenChange } = renderInDialog()

    for (const outside of [() => screen.getByText('Custom item drop'), () => document.body]) {
      const { popover } = await openPicker()
      await new Promise(resolve => setTimeout(resolve, 0))
      const target = outside()
      fireEvent.pointerDown(target)
      fireEvent.click(target)
      await waitFor(() => expect(popover).not.toBeInTheDocument())
      expect(onOpenChange).not.toHaveBeenCalled()
      expect(hostDialog).toBeInTheDocument()
    }
  })

  // The listbox and its search box live in a <body>-level portal, but the
  // arrow and Enter keys are handled by the wrapper next to the trigger:
  // React bubbles key events out of a portal to its React parent. This pins
  // that path; Escape alone would not, since Radix handles it itself.
  it('selects from the portaled search box with the keyboard, inside the Dialog', async () => {
    const { onChange, onOpenChange, hostDialog } = renderInDialog()
    await openPicker()
    const search = screen.getByRole('combobox', { name: 'Filter items' })
    await waitFor(() => expect(document.activeElement).toBe(search))

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    // The focused search box carries the highlighted option (the trigger is
    // hidden behind the modal popover).
    expect(search).toHaveAttribute('aria-activedescendant', 'itempicker-opt-1')
    expect(document.getElementById('itempicker-opt-1')).toHaveTextContent('Bandage')

    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('Base.Bandage')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Select item' })))
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(hostDialog).toBeInTheDocument()
  })

  it('Home and End move the text cursor until the arrows pick a row, then jump in the list', async () => {
    renderInDialog()
    await openPicker()
    const search = screen.getByRole('combobox', { name: 'Filter items' })

    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.keyDown(search, { key: 'End' })).toBe(true)
    expect(fireEvent.keyDown(search, { key: 'Home' })).toBe(true)
    expect(search).not.toHaveAttribute('aria-activedescendant')

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(fireEvent.keyDown(search, { key: 'End' })).toBe(false)
    expect(search).toHaveAttribute('aria-activedescendant', 'itempicker-opt-2')
    expect(fireEvent.keyDown(search, { key: 'Home' })).toBe(false)
    expect(search).toHaveAttribute('aria-activedescendant', 'itempicker-opt-0')
  })

  it("leaves Enter and the arrows alone on the popover's own buttons, so Enter presses them", async () => {
    const { onChange } = renderInDialog()
    const { listbox } = await openPicker()
    const search = screen.getByRole('combobox', { name: 'Filter items' })

    for (const name of [/^weapons/i, 'Re-scan server items']) {
      const button = screen.getByRole('button', { name })
      expect(fireEvent.keyDown(button, { key: 'ArrowDown' })).toBe(true)
      expect(fireEvent.keyDown(button, { key: 'Enter' })).toBe(true)
    }
    expect(search).not.toHaveAttribute('aria-activedescendant')
    expect(onChange).not.toHaveBeenCalled()
    expect(listbox).toBeInTheDocument()
  })

  it('Enter on the closed trigger opens the picker, but Enter on its clear button does not', async () => {
    renderInDialog(vi.fn(), 'Base.Axe')
    const trigger = await screen.findByRole('combobox', { name: 'Select item' })

    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'Clear selection' }), { key: 'Enter' })).toBe(true)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    expect(fireEvent.keyDown(trigger, { key: 'Enter' })).toBe(false)
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
  })

  it('compiles its size, scroll and short-window classes to real CSS', async () => {
    renderInDialog()
    const { popover } = await openPicker()
    const classes = Array.from(popover.querySelectorAll<HTMLElement>('[class]'))
      .map(el => el.className)
      .concat(popover.className)
      .join(' ')
    const { css } = await postcss([
      tailwindcss({ content: [{ raw: classes }], corePlugins: { preflight: false } }),
    ]).process('@tailwind utilities;', { from: undefined })
    const compact = css.replace(/\s+/g, ' ')

    expect(compact).toMatch(/height: 34rem/)
    expect(compact).toMatch(/max-height: var\(--radix-popover-content-available-height\)/)
    expect(compact).toMatch(/width: min\(47\.5rem, calc\(100vw - 1rem\)\)/)
    expect(compact).toMatch(/min-width: var\(--radix-popover-trigger-width\)/)
    expect(compact).toMatch(/width: min\(210px, 40%\)/)
    // The footer (count and key hints) gives its room to the list on a very
    // short window.
    expect(compact).toMatch(/@media ?\(max-height: ?30rem\) \{ [^{}]*max-height\\:30rem[^{}]*:hidden \{ display: none/)
  })
})
