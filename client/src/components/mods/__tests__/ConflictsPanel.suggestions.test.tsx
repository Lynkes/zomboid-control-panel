import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConflictsPanel } from '../ConflictsPanel'
import type { ConflictsSmart } from '../conflictSuggestions'
import type { DepSearchState } from '@/lib/modsShared'
import type { ConflictPair, ConflictScanResult } from '@/types'

// The Conflicts view with smart sort's suggested winners: a marker on each
// collapsed pair, the suggestion inside an open one, and the bulk bar above
// the list. Without the `smart` prop the panel looks as it always did.

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))
vi.mock('@/contexts/ConfirmContext', () => ({
  useConfirm: () => vi.fn(),
  ConfirmProvider: ({ children }: { children: unknown }) => children,
}))

const ref = (modId: string, modName: string) => ({ workshopId: `ws-${modId}`, modId, modName })
const TRUCK = ref('KI5_M35A2', '[KI5] M35A2 Truck')
const FIXES = ref('KI5Fixes', '[KI5] Vehicle Fixes')
const BRITA = ref('Brita', "Brita's Weapon Pack")
const LIB = ref('TchernoLib', "Tsar's Common Library")

const PAIRS: ConflictPair[] = [
  {
    modA: TRUCK, modB: FIXES, files: [], highCount: 1, mediumCount: 0, lowCount: 0,
    suggestion: { winner: 'KI5Fixes', confidence: 'high', reason: 'requiresOther', alreadyWinning: false },
  },
  {
    modA: LIB, modB: BRITA, files: [], highCount: 0, mediumCount: 1, lowCount: 0,
    suggestion: { winner: 'Brita', confidence: 'high', reason: 'requiresOther', alreadyWinning: true },
  },
]

const SCAN: ConflictScanResult = {
  totalConflicts: 2,
  identicalSkipped: 0,
  pairs: PAIRS,
  totalPairs: 2,
  modsScanned: 4,
  missingDeps: [],
  modLoadOrder: ['TchernoLib', 'Brita', 'KI5Fixes', 'KI5_M35A2'],
}

function Harness({ smart }: { smart?: ConflictsSmart }) {
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
        smart={smart}
      />
    </TooltipProvider>
  )
}

const smart = (): ConflictsSmart => ({
  rules: { rules: [], max: 2000, loadState: 'ready', reload: vi.fn(), add: vi.fn(), remove: vi.fn(), rulesFor: () => [] },
  canManage: true,
  onRuleAdded: vi.fn(),
  onSortNow: vi.fn(),
})

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ConflictsPanel: suggested winners', () => {
  it('marks each pair, opens the suggestion inside it, and offers the bulk apply', () => {
    render(<Harness smart={smart()} />)
    expect(screen.getByText('Suggest: [KI5] Vehicle Fixes')).toBeInTheDocument()
    expect(screen.getByText('As suggested')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply all high-confidence suggestions (1)' })).toBeInTheDocument()

    // The pair's own row (the mod is named in the top-mods strip too).
    const trigger = screen.getAllByText('[KI5] M35A2 Truck').map((el) => el.closest('button[aria-expanded]')).find(Boolean)!
    fireEvent.click(trigger)
    expect(screen.getByText('Suggested: [KI5] Vehicle Fixes should load last and win')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pin [KI5] Vehicle Fixes to load after [KI5] M35A2 Truck' })).toBeInTheDocument()
  })

  it('shows none of it without the smart prop', () => {
    render(<Harness />)
    expect(screen.queryByText('Suggest: [KI5] Vehicle Fixes')).toBeNull()
    expect(screen.queryByRole('button', { name: /Apply all high-confidence/ })).toBeNull()
  })
})
