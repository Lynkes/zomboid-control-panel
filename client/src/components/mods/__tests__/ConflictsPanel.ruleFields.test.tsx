import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConflictsPanel } from '../ConflictsPanel'
import type { DepSearchState } from '@/lib/modsShared'
import type { ConflictScanResult } from '@/types'

// The Build 42 conflict rules give each entry a kind, a reason, an "info"
// severity for a declared patch's intended override, and conflicts across
// two files (definitions or Lua names) or declared in mod.info. The panel
// offered a file diff for every entry: for those it always failed with
// "Could not find both mod files on disk -- they may have been removed or
// updated since the last scan", and it never said why an entry was a
// conflict or that one was intended. Entries without those fields (an older
// scan) still work as before.

const PATCH = { workshopId: '1', modId: 'Patch', modName: 'Patch Mod' }
const BASE = { workshopId: '2', modId: 'Base', modName: 'Base Mod' }

const SCAN: ConflictScanResult = {
  totalConflicts: 3,
  identicalSkipped: 0,
  pairs: [
    {
      modA: BASE,
      modB: PATCH,
      files: [
        {
          file: 'scripts/base_items.txt ↔ scripts/patch_items.txt',
          category: 'scripts-cross-file',
          severity: 'medium',
          kind: 'script-override',
          reason: 'scriptDefinitionOverride',
          files: [
            { modId: 'Base', file: 'scripts/base_items.txt' },
            { modId: 'Patch', file: 'scripts/patch_items.txt' },
          ],
        },
        { file: 'lua/client/hooks.lua', category: 'lua', severity: 'info', kind: 'lua-override', reason: 'intendedPatch', intended: true },
        { file: 'textures/old_shape.png', category: 'textures', severity: 'low' },
      ],
      highCount: 0,
      mediumCount: 1,
      lowCount: 1,
      infoCount: 1,
    },
  ],
  totalPairs: 1,
  modsScanned: 2,
  missingDeps: [],
  modLoadOrder: ['Base', 'Patch'],
}

function Harness() {
  const [depSearchOpen, setDepSearchOpen] = useState(new Set<string>())
  const [depSearchData, setDepSearchData] = useState<Record<string, DepSearchState>>({})
  const [depAdding, setDepAdding] = useState<string[]>([])
  const [depAddResults, setDepAddResults] = useState<Record<string, 'added' | 'error'>>({})
  return (
    <TooltipProvider>
      <ConflictsPanel
        conflicts={SCAN}
        conflictsLoading={false}
        conflictsError={null}
        conflictsStale={false}
        lastScanTime={null}
        scanConflicts={vi.fn()}
        scanProgress={0}
        scanCurrentMod={null}
        scanModsScanned={0}
        scanTotalMods={0}
        streamConflicts={[]}
        fetchData={vi.fn()}
        busyRef={{ current: false }}
        savingModOrder={false}
        promoteModOverOpponent={async () => {}}
        toast={vi.fn()}
        depSearchOpen={depSearchOpen}
        setDepSearchOpen={setDepSearchOpen}
        depSearchData={depSearchData}
        setDepSearchData={setDepSearchData}
        depAdding={depAdding}
        setDepAdding={setDepAdding}
        depAddResults={depAddResults}
        setDepAddResults={setDepAddResults}
      />
    </TooltipProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('zcp:mods:conflicts:severity', JSON.stringify('all'))
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ type: 'binary', ext: '.png', modA: { size: 1, hash: null }, modB: { size: 2, hash: null } }), { status: 200, headers: { 'content-type': 'application/json' } })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function openPair() {
  const trigger = screen.getAllByText('Patch Mod')
    .map((el) => el.closest('button[data-state]'))
    .find((el): el is HTMLButtonElement => el != null)
  fireEvent.click(trigger!)
}

describe('ConflictsPanel entries with the Build 42 rule fields', () => {
  it('opens a conflict across two files to each mod\'s file and the reason, without asking for a diff', () => {
    render(<Harness />)
    openPair()

    fireEvent.click(screen.getByRole('button', { name: /base_items\.txt ↔/ }))

    expect(fetch).not.toHaveBeenCalled()
    expect(screen.getByText('scripts/base_items.txt')).toBeInTheDocument()
    expect(screen.getByText('scripts/patch_items.txt')).toBeInTheDocument()
    expect(screen.getByText('Both mods define these entries; the definition loaded last replaces the other.')).toBeInTheDocument()
  })

  it('marks a declared patch\'s override as intended and says why', () => {
    render(<Harness />)
    openPair()

    const row = screen.getByRole('button', { name: /hooks\.lua/ })
    expect(row).toHaveTextContent('Intended')
    fireEvent.click(row)
    expect(screen.getByText('Intended: this mod declares it builds on the other and loads after it.')).toBeInTheDocument()
  })

  it('still diffs an entry from an older scan, which has none of those fields', () => {
    render(<Harness />)
    openPair()

    fireEvent.click(screen.getByRole('button', { name: /old_shape\.png/ }))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('file=textures%2Fold_shape.png')
  })
})
