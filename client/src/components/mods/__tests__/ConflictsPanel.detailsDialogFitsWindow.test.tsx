import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConflictsPanel } from '../ConflictsPanel'
import type { ConflictScanResult } from '@/types'

// 2026-09 dialog sweep: the per-mod "Details A/B" dialog scrolled as a whole
// under its own 85vh cap, so with many pairs the mod name, the win/lose
// summary and Close scrolled away; and long Workshop titles (truncate next
// to a shrink-0 action group) widened it past a phone screen, pushing
// "Win it"/"View" off the edge. Measured in Chromium; jsdom does no layout,
// so this pins the structure (the width half is DialogContent's own
// one-column template, covered in dialog.test.tsx).

const HUB = { workshopId: '1', modId: 'BritaWeapons', modName: "Brita's Weapon Pack [B42] - Complete Arsenal Edition with Attachments" }
const opponents = Array.from({ length: 4 }, (_, i) => ({
  workshopId: String(100 + i), modId: `Opp${i}`, modName: `Filibuster Rhymes' Used Cars! (Build 42) Expanded Community Edition ${i}`,
}))

const conflicts: ConflictScanResult = {
  totalConflicts: 4,
  identicalSkipped: 0,
  pairs: opponents.map((o) => ({
    modA: HUB, modB: o,
    files: [{ file: 'media/lua/shared/Items.lua', category: 'lua', severity: 'high' as const }],
    highCount: 1, mediumCount: 0, lowCount: 0,
  })),
  totalPairs: 4,
  modsScanned: 5,
  missingDeps: [],
  modLoadOrder: ['BritaWeapons', ...opponents.map((o) => o.modId)],
}

function noop() {}

function renderPanel() {
  return render(
    <TooltipProvider>
      <ConflictsPanel
        conflicts={conflicts}
        conflictsLoading={false}
        conflictsError={null}
        conflictsStale={false}
        lastScanTime={null}
        scanConflicts={noop}
        scanProgress={0}
        scanCurrentMod={null}
        scanModsScanned={0}
        scanTotalMods={0}
        streamConflicts={[]}
        fetchData={noop}
        busyRef={{ current: false }}
        savingModOrder={false}
        promoteModOverOpponent={async () => {}}
        toast={noop}
        depSearchOpen={new Set()}
        setDepSearchOpen={noop}
        depSearchData={{}}
        setDepSearchData={noop}
        depAdding={[]}
        setDepAdding={noop}
        depAddResults={{}}
        setDepAddResults={noop}
      />
    </TooltipProvider>,
  )
}

afterEach(cleanup)

describe('ConflictsPanel per-mod details dialog', () => {
  it('scrolls only the pair list; the mod name and Close stay put, and long names carry a title', async () => {
    renderPanel()
    // The first pair's accordion trigger (Radix wraps it in an <h3>).
    await screen.findAllByText(opponents[0].modName)
    fireEvent.click(document.querySelector<HTMLElement>('h3 > button[aria-expanded]')!)
    const detailsA = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Details A')!
    fireEvent.click(detailsA)

    const dialog = await screen.findByRole('dialog')
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]')
    expect(dialog.className).not.toContain('max-h-[85vh]')
    const body = dialog.querySelector<HTMLElement>(':scope > [data-dialog-body]')
    expect(body).not.toBeNull()

    const title = within(dialog).getByRole('heading')
    expect(body!.contains(title)).toBe(false)
    expect(within(title).getByText(HUB.modName)).toHaveAttribute('title', HUB.modName)
    // The footer Close and the corner X.
    for (const close of within(dialog).getAllByRole('button', { name: 'Close' })) expect(body!.contains(close)).toBe(false)

    const pairs = within(body!).getAllByRole('listitem')
    expect(pairs).toHaveLength(4)
    expect(within(pairs[0]).getByTitle(/Filibuster Rhymes/)).toBeInTheDocument()
  })
})
