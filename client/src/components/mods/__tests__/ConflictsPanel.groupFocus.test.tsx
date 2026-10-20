import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConflictsPanel, type ConflictsFocus } from '../ConflictsPanel'
import type { DepSearchState } from '@/lib/modsShared'
import type { ConflictPair, ConflictScanResult } from '@/types'

// A mod group's conflict badge opens Conflicts filtered to the pairs touching
// the group's mods: every count and list below follows the filter, the
// severity filter opens on "All", and the chip clears it.

const ref = (modId: string, modName: string) => ({ workshopId: `ws-${modId}`, modId, modName })
const pair = (a: ReturnType<typeof ref>, b: ReturnType<typeof ref>, high: number, medium: number, low: number): ConflictPair => ({
  modA: a,
  modB: b,
  files: [],
  highCount: high,
  mediumCount: medium,
  lowCount: low,
})

const CAR = ref('Car', 'Car Pack')
const LIB = ref('Lib', 'Lib Core')
const OTHER = ref('X', 'Other Weapons')
const Y = ref('Y', 'Mod Yankee')
const Z = ref('Z', 'Mod Zulu')

const SCAN: ConflictScanResult = {
  totalConflicts: 9,
  identicalSkipped: 0,
  pairs: [pair(CAR, OTHER, 1, 0, 0), pair(LIB, CAR, 0, 0, 2), pair(Y, Z, 0, 3, 0)],
  totalPairs: 3,
  modsScanned: 5,
  missingDeps: [],
  modLoadOrder: ['Lib', 'Car', 'X', 'Y', 'Z'],
}

function Harness({ initialFocus }: { initialFocus: ConflictsFocus | null }) {
  const [focus, setFocus] = useState(initialFocus)
  const [depSearchOpen, setDepSearchOpen] = useState(new Set<string>())
  const [depSearchData, setDepSearchData] = useState<Record<string, DepSearchState>>({})
  const [depAdding, setDepAdding] = useState<string[]>([])
  const [depAddResults, setDepAddResults] = useState<Record<string, 'added' | 'error'>>({})
  return (
    <TooltipProvider>
      <ConflictsPanel
        focus={focus}
        onClearFocus={() => setFocus(null)}
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
})

afterEach(() => {
  cleanup()
})

describe('ConflictsPanel focused on a mod group', () => {
  it('shows only the pairs touching the group, on every severity, until the chip clears it', () => {
    // A remembered "Critical only" filter would hide the group's low pair.
    localStorage.setItem('zcp:mods:conflicts:severity', JSON.stringify('high'))
    render(<Harness initialFocus={{ label: 'Vehicles', modIds: ['Car', 'Lib', 'X'] }} />)

    expect(screen.getByText('Mods of Vehicles')).toBeInTheDocument()
    expect(screen.getAllByText('Car Pack').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Lib Core').length).toBeGreaterThan(0)
    expect(screen.queryByText('Mod Yankee')).toBeNull()
    expect(screen.getByRole('radio', { name: /File conflicts/i })).toHaveTextContent('2')

    fireEvent.click(screen.getByRole('button', { name: 'Show every conflict again (stop filtering on Vehicles)' }))

    expect(screen.queryByText('Mods of Vehicles')).toBeNull()
    expect(screen.getAllByText('Mod Yankee').length).toBeGreaterThan(0)
    expect(screen.getByRole('radio', { name: /File conflicts/i })).toHaveTextContent('3')
  })

  it('shows every pair without a focus', () => {
    render(<Harness initialFocus={null} />)

    expect(screen.queryByText(/^Mods of /)).toBeNull()
    expect(screen.getByRole('radio', { name: /File conflicts/i })).toHaveTextContent('3')
  })
})
