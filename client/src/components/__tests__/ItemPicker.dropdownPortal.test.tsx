import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ItemPicker, type CatalogItem } from '../ItemPicker'
import { panelBridgeApi } from '@/lib/api'

// bug-hunt-2026-09-18 (WorldMap Custom Drop dialog, round 4b): this
// dropdown used to render as a plain `position: absolute` sibling of its
// trigger. Any ancestor with `overflow` set (WorldMap.tsx's item-rows list,
// capped in round 4 to stop 50 rows pushing the dialog's own footer
// off-screen) clipped it -- confirmed live with an 80-item catalog: the
// dropdown was clipped in every row position tried against a 288px-capped
// ancestor. Fixed by portaling the panel out via @radix-ui/react-portal,
// into the nearest `[role="dialog"]`/`[role="alertdialog"]` ancestor (never
// document.body when one exists -- portaling past it would escape the host
// Dialog's own FocusScope containment too, confirmed by reading
// @radix-ui/react-focus-scope's source: `trapped` mode snaps focus back
// into the dialog the instant `container.contains(target)` is false on any
// focusin, which is every keystroke into a document.body-portaled input).
//
// jsdom does not compute real layout (getBoundingClientRect always returns
// zeros), so these tests assert the STRUCTURAL claim -- which DOM subtree
// the panel actually lands in -- not pixel positions. The real before/after
// pixel behavior (fits at 375x667 and 1280x800, first/middle/last row) was
// verified live with Playwright against a running instance, not simulated
// here.

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

const ITEMS: CatalogItem[] = [
  { id: 'Base.Axe', name: 'Axe', category: 'WeaponPrimitive', weight: 3 },
  { id: 'Base.Bandage', name: 'Bandage', category: 'Bandage', weight: 0.1 },
]

beforeEach(() => {
  getCatalogItems.mockReset()
  getCatalogItems.mockResolvedValue({ items: ITEMS, count: ITEMS.length, scannedAt: null })
})

async function openPicker() {
  render(<ItemPicker value="" onChange={vi.fn()} />)
  await waitFor(() => expect(getCatalogItems).toHaveBeenCalled())
  fireEvent.click(await screen.findByRole('combobox', { name: 'Select item' }))
  return screen.findByRole('listbox')
}

describe('ItemPicker: dropdown portals out of any clipping ancestor', () => {
  it('portals to document.body when there is no host Dialog', async () => {
    const listbox = await openPicker()
    // The panel is the listbox's nearest `position: fixed` ancestor (see
    // the component's own comment) -- walk up to it and confirm it landed
    // directly under <body>, not nested inside the trigger's own wrapper.
    let panel: HTMLElement | null = listbox
    while (panel && panel.parentElement !== document.body) panel = panel.parentElement
    expect(panel?.parentElement).toBe(document.body)
  })

  it('portals INTO the nearest [role="dialog"] ancestor instead of document.body, so the host Dialog\'s FocusScope still contains it', async () => {
    function Host() {
      return (
        <div role="dialog">
          <div className="overflow-y-auto" style={{ maxHeight: 100 }}>
            <ItemPicker value="" onChange={vi.fn()} />
          </div>
        </div>
      )
    }
    render(<Host />)
    await waitFor(() => expect(getCatalogItems).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('combobox', { name: 'Select item' }))
    const listbox = await screen.findByRole('listbox')

    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(listbox)).toBe(true)

    let panel: HTMLElement | null = listbox
    while (panel && panel.parentElement !== dialog) panel = panel.parentElement
    expect(panel?.parentElement).toBe(dialog)
    // And specifically NOT inside the capped overflow div the trigger sits
    // in -- that ancestor is exactly what used to clip it.
    const cappedAncestor = dialog.querySelector('.overflow-y-auto')
    expect(cappedAncestor?.contains(listbox)).toBe(false)
  })

  it('a click inside the portaled panel does not close the dropdown (only a real outside click does)', async () => {
    const listbox = await openPicker()
    const searchInput = screen.getByRole('textbox', { name: 'Filter items' })

    fireEvent.mouseDown(searchInput)
    expect(screen.queryByRole('listbox')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(listbox).toBeTruthy()
  })
})
