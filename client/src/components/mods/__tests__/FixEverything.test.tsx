import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { modsApi } from '@/lib/api'
import type { ConflictScanResult } from '@/types'
import { FixEverythingButton } from '../FixEverythingButton'
import { useFixEverything, type FixEverythingDeps } from '../useFixEverything'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    modsApi: {
      ...actual.modsApi,
      getModHealth: vi.fn(),
      getOrderRules: vi.fn(),
      planLoadOrder: vi.fn(),
      autofixSnapshot: vi.fn(),
      autofixRestore: vi.fn(),
      applyModHealthFix: vi.fn(),
      addOrderRule: vi.fn(),
      deleteOrderRule: vi.fn(),
      saveModOrder: vi.fn(),
      toggleModId: vi.fn(),
    },
  }
})
const m = vi.mocked(modsApi)

const HEALTH = {
  checkedAt: '', counts: { critical: 0, warning: 1, info: 0 },
  steamStatus: { source: 'none', fetchedAt: null, stale: false, failed: false, pending: false, known: 0, total: 0 },
  issues: [{ id: 'map1', kind: 'mapNotInMapLine', severity: 'warning', modIds: ['Bunker'], workshopIds: [], params: { modId: 'Bunker', folders: ['Bunker'] }, fixes: [{ action: 'addMapFolders', params: { folders: ['Bunker'] }, label: '' }] }],
}
const SCAN = {
  totalConflicts: 1, identicalSkipped: 0, totalPairs: 1, modsScanned: 2, missingDeps: [], modLoadOrder: ['Small', 'Big'],
  pairs: [{
    modA: { workshopId: '1', modId: 'Big', modName: 'Big Pack' },
    modB: { workshopId: '2', modId: 'Small', modName: 'Small Fix' },
    files: [{ file: 'lua/client/a.lua', category: 'lua', severity: 'high' }],
    highCount: 1, mediumCount: 0, lowCount: 0,
    suggestion: { winner: 'Small', confidence: 'medium', reason: 'smallOverride', alreadyWinning: false, params: { files: 2, conflicting: 2, otherFiles: 300 } },
  }],
} as unknown as ConflictScanResult

function Harness(props: Partial<FixEverythingDeps>) {
  const deps: FixEverythingDeps = {
    canManage: true, blockedReason: null, conflicts: SCAN, conflictsLoading: false, conflictsStale: false, conflictsError: null,
    scanConflicts: vi.fn(), groups: [], isPairIgnored: () => false, modName: () => undefined, itemTitle: () => undefined, onChanged: vi.fn(),
    ...props,
  }
  const fix = useFixEverything(deps)
  return (
    <>
      <FixEverythingButton onClick={fix.openDialog} disabledReason={deps.blockedReason} busy={fix.busy} />
      {fix.dialog}
    </>
  )
}

function prime() {
  m.getModHealth.mockResolvedValue(HEALTH as never)
  m.getOrderRules.mockResolvedValue({ rules: [], max: 2000 } as never)
  m.planLoadOrder.mockResolvedValue({ order: ['Big', 'Small'], changed: true, moves: [{ modId: 'Small', from: 0, to: 1, reasons: [], confidence: 'high' }] } as never)
  m.autofixSnapshot.mockResolvedValue({ snapshotId: 's1' })
  m.applyModHealthFix.mockResolvedValue({ applied: true, health: HEALTH } as never)
  m.addOrderRule.mockResolvedValue({ rule: { id: 'r-new' }, existing: false, replaced: [] } as never)
  m.saveModOrder.mockResolvedValue({} as never)
  m.autofixRestore.mockResolvedValue({ restored: true })
  m.deleteOrderRule.mockResolvedValue({ success: true })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Fix everything', () => {
  it('previews the fixes, the suggested winner and the plan with the end result, applies them in order, and undoes the whole run', async () => {
    prime()
    const onChanged = vi.fn()
    const scanConflicts = vi.fn()
    render(<TooltipProvider><Harness onChanged={onChanged} scanConflicts={scanConflicts} /></TooltipProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Fix everything/ }))

    expect(await screen.findByText('Higher-impact conflicts still open: 1 → 0')).toBeInTheDocument()
    expect(m.planLoadOrder).toHaveBeenCalledWith({ rules: [['Big', 'Small']] })
    expect(screen.getByText('Add Bunker to Map=')).toBeInTheDocument()
    expect(screen.getByText('Small Fix wins over Big Pack')).toBeInTheDocument()
    expect(screen.getByText('Mods that move: 1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Apply selected (3)' }))
    expect(await screen.findByText(/Applied: 3\. Already solved: 0\. Mods moved: 1\./)).toBeInTheDocument()
    expect(m.autofixSnapshot).toHaveBeenCalledTimes(1)
    expect(m.applyModHealthFix).toHaveBeenCalledWith('map1', 'addMapFolders', { folders: ['Bunker'] })
    expect(m.addOrderRule).toHaveBeenCalledWith({ before: 'Big', after: 'Small', source: 'conflictResolve' })
    expect(m.planLoadOrder).toHaveBeenLastCalledWith({})
    expect(m.saveModOrder).toHaveBeenCalledWith(['Big', 'Small'])
    expect(m.applyModHealthFix.mock.invocationCallOrder[0]).toBeLessThan(m.addOrderRule.mock.invocationCallOrder[0])
    expect(m.addOrderRule.mock.invocationCallOrder[0]).toBeLessThan(m.saveModOrder.mock.invocationCallOrder[0])
    expect(onChanged).toHaveBeenCalled()
    expect(scanConflicts).toHaveBeenCalled()

    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' })[0])
    await waitFor(() => expect(m.autofixRestore).toHaveBeenCalledWith('s1'))
    await waitFor(() => expect(m.deleteOrderRule).toHaveBeenCalledWith('r-new'))
  })

  it('scans first when the cached scan is stale', async () => {
    prime()
    const scanConflicts = vi.fn()
    render(<TooltipProvider><Harness conflictsStale scanConflicts={scanConflicts} /></TooltipProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Fix everything/ }))
    expect(scanConflicts).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/scanning again first/)).toBeInTheDocument()
    expect(m.getModHealth).not.toHaveBeenCalled()
  })

  it('is disabled without mods.manage', () => {
    render(<TooltipProvider><Harness canManage={false} blockedReason="Your role does not have permission to manage mods." /></TooltipProvider>)
    expect(screen.getByRole('button', { name: /Fix everything/ })).toBeDisabled()
  })
})
