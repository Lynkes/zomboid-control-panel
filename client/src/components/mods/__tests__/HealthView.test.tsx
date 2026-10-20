import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiError, type ModHealth, type ModHealthFixResult, type ModHealthIssue } from '@/lib/api'
import { HealthView, type HealthViewProps } from '../HealthView'
import type { ModHealthStore } from '../useModHealth'

// The Health view of the Mods page: every issue kind in plain words, its fix
// buttons, the confirm before a removal, and "Fix all safe issues" applying
// the add-only fixes one by one and stopping at the first error.

const toastSpy = vi.hoisted(() => vi.fn())
const confirmSpy = vi.hoisted(() => vi.fn())

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))
vi.mock('@/contexts/ConfirmContext', () => ({
  useConfirm: () => confirmSpy,
  ConfirmProvider: ({ children }: { children: unknown }) => children,
}))

const STEAM = { source: 'api' as const, fetchedAt: null, stale: false, failed: false, pending: false, known: 0, total: 0 }

function issue(overrides: Partial<ModHealthIssue> & Pick<ModHealthIssue, 'id' | 'kind' | 'severity'>): ModHealthIssue {
  return { modIds: [], workshopIds: [], params: {}, fixes: [], ...overrides }
}

function healthOf(issues: ModHealthIssue[]): ModHealth {
  const counts = { critical: 0, warning: 0, info: 0 }
  for (const entry of issues) counts[entry.severity]++
  return { checkedAt: '2026-10-20T10:00:00.000Z', counts, issues, steamStatus: STEAM }
}

const NAMES: Record<string, string> = { Brita: "Brita's Weapon Pack", Brita_2: "Brita's Armor Pack", OldMod: 'Old Mod', KI5Library: 'KI5 Library' }

function renderView(health: ModHealth | null, overrides: Partial<HealthViewProps> = {}, storeOverrides: Partial<ModHealthStore> = {}) {
  const store: ModHealthStore = {
    health,
    loadState: health ? 'ready' : 'loading',
    error: null,
    reload: vi.fn().mockResolvedValue(undefined),
    applyFix: vi.fn(),
    ...storeOverrides,
  }
  const props: HealthViewProps = {
    store,
    canManage: true,
    modName: (id) => NAMES[id],
    itemTitle: () => undefined,
    onShowMod: vi.fn(),
    onShowWorkshopItem: vi.fn(),
    onFixed: vi.fn(),
    ...overrides,
  }
  render(
    <MemoryRouter>
      <TooltipProvider>
        <HealthView {...props} />
      </TooltipProvider>
    </MemoryRouter>,
  )
  return { store, props }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('HealthView: wording', () => {
  it('explains a broken require= entry and a required mod that is not installed, and links the mods', () => {
    const { props } = renderView(healthOf([
      issue({
        id: 'modInfoBroken-0000000000000001',
        kind: 'modInfoBroken',
        severity: 'critical',
        modIds: ['Brita'],
        params: { modId: 'Brita', field: 'require', entry: 'Tcherno Lib', issue: 'whitespace', affected: ['Brita', 'Brita_2'] },
      }),
      issue({
        id: 'requiredNotInstalled-0000000000000002',
        kind: 'requiredNotInstalled',
        severity: 'critical',
        modIds: ['Brita'],
        params: { missing: 'Arsenal(26)GunFighter', requiredBy: ['Brita'], affected: ['Brita', 'Brita_2'], caseMatch: 'arsenal(26)gunfighter' },
        fixes: [{ action: 'addWorkshopItems', params: { workshopIds: ['2297098490'], modIds: ['Arsenal(26)GunFighter'], before: 'Brita' }, label: 'Add Workshop item 2297098490' }],
      }),
    ]))

    expect(screen.getByRole('heading', { name: 'A broken require= line in mod.info' })).toBeInTheDocument()
    expect(screen.getByText(/the require= entry “Tcherno Lib” is padded with spaces, which the game does not trim/)).toBeInTheDocument()
    expect(screen.getByText("Also skipped, because they need it: Brita's Armor Pack.")).toBeInTheDocument()

    expect(screen.getByRole('heading', { name: 'A required mod is not installed' })).toBeInTheDocument()
    expect(screen.getByText(/Arsenal\(26\)GunFighter is required by Brita's Weapon Pack, but no installed Workshop item ships it/)).toBeInTheDocument()
    expect(screen.getByText(/An installed mod is called arsenal\(26\)gunfighter/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add Workshop item 2297098490 and enable Arsenal(26)GunFighter' })).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: "Show Brita's Weapon Pack" })[0])
    expect(props.onShowMod).toHaveBeenCalledWith('Brita')
  })

  it('keeps the "good to know" group closed until opened', () => {
    renderView(healthOf([
      issue({ id: 'updatesAvailable-0000000000000003', kind: 'updatesAvailable', severity: 'info', workshopIds: ['1', '2'], params: { count: 2, items: [] } }),
    ]))
    expect(screen.queryByText(/2 Workshop items have updates/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Good to know' }))
    expect(screen.getByText(/2 Workshop items have updates/)).toBeInTheDocument()
  })

  it('says so calmly when nothing is wrong', () => {
    renderView(healthOf([]))
    expect(screen.getByText('No problems found')).toBeInTheDocument()
  })
})

describe('HealthView: fixes', () => {
  const b41 = issue({
    id: 'b41Only-0000000000000004',
    kind: 'b41Only',
    severity: 'warning',
    modIds: ['OldMod'],
    workshopIds: ['3000000004'],
    params: { modId: 'OldMod', workshopId: '3000000004' },
    fixes: [{ action: 'removeMods', params: { modIds: ['OldMod'] }, label: 'Remove OldMod from Mods=' }],
  })

  it('asks before removing, naming exactly what goes', async () => {
    const health = healthOf([b41])
    const result: ModHealthFixResult = { applied: true, health: healthOf([]) }
    const { store, props } = renderView(health)
    vi.mocked(store.applyFix).mockResolvedValue(result)

    confirmSpy.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Old Mod from the mod list' }))
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1))
    expect(confirmSpy.mock.calls[0][0]).toMatchObject({ title: 'Are you absolutely sure?', items: ['Old Mod (OldMod)'], destructive: true })
    expect(store.applyFix).not.toHaveBeenCalled()

    confirmSpy.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Old Mod from the mod list' }))
    await waitFor(() => expect(store.applyFix).toHaveBeenCalledWith(b41, b41.fixes[0]))
    await waitFor(() => expect(props.onFixed).toHaveBeenCalledWith(result))
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Mod list updated', description: 'Remove Old Mod from the mod list' }))
  })

  it('disables every fix with the reason it is blocked', () => {
    renderView(healthOf([b41]), { blockedReason: 'Save or discard your load order changes first.' })
    expect(screen.getByRole('button', { name: 'Remove Old Mod from the mod list' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Fix all safe issues/ })).toBeDisabled()
  })

  it('reloads when the problem is gone', async () => {
    const { store } = renderView(healthOf([b41]))
    confirmSpy.mockResolvedValue(true)
    vi.mocked(store.applyFix).mockRejectedValue(new ApiError('gone', { status: 404, code: 'MODS_HEALTH_ISSUE_GONE' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Old Mod from the mod list' }))
    await waitFor(() => expect(store.reload).toHaveBeenCalled())
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'This problem has changed' }))
  })
})

describe('HealthView: Fix all safe issues', () => {
  const mapIssue = issue({
    id: 'mapNotInMapLine-0000000000000005',
    kind: 'mapNotInMapLine',
    severity: 'warning',
    modIds: ['RavenCreek'],
    params: { modId: 'RavenCreek', folders: ['RavenCreek'] },
    fixes: [{ action: 'addMapFolders', params: { folders: ['RavenCreek'] }, label: 'Add RavenCreek to Map=' }],
  })
  const implicitIssue = issue({
    id: 'requiredLoadedImplicitly-0000000000000006',
    kind: 'requiredLoadedImplicitly',
    severity: 'info',
    modIds: ['KI5Library'],
    params: { modId: 'KI5Library', requiredBy: ['KI5_93Blazer'] },
    fixes: [{ action: 'addMods', params: { modIds: ['KI5Library'], before: 'KI5_93Blazer' }, label: 'Add KI5Library to Mods=' }],
  })
  const orderIssue = issue({
    id: 'orderProblems-0000000000000007',
    kind: 'orderProblems',
    severity: 'warning',
    modIds: ['truemusic'],
    params: { moves: 1, changesLoading: true, sample: [{ modId: 'truemusic', from: 18, to: 17, reasons: ['require'] }] },
    fixes: [{ action: 'applyPlan', params: {}, label: 'Apply the suggested load order' }],
  })
  const unusedIssue = issue({
    id: 'unusedWorkshopItem-0000000000000008',
    kind: 'unusedWorkshopItem',
    severity: 'info',
    workshopIds: ['3000000003'],
    params: { workshopId: '3000000003', title: 'Expanded Helicopter Events', modIds: ['ExpandedHelicopterEvents'] },
    fixes: [{ action: 'removeWorkshopItems', params: { workshopIds: ['3000000003'] }, label: 'Remove Workshop item 3000000003' }],
  })

  it('confirms once, lists only the add-only fixes, applies them in order and stops at the first error', async () => {
    const health = healthOf([mapIssue, orderIssue, implicitIssue, unusedIssue])
    const first: ModHealthFixResult = { applied: true, health: healthOf([orderIssue, implicitIssue, unusedIssue]) }
    const { store, props } = renderView(health)
    confirmSpy.mockResolvedValue(true)
    vi.mocked(store.applyFix)
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new ApiError('Disk full', { status: 500 }))

    fireEvent.click(screen.getByRole('button', { name: /Fix all safe issues/ }))
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1))
    expect(confirmSpy.mock.calls[0][0]).toMatchObject({
      title: 'Apply 3 safe fixes?',
      destructive: false,
      items: ['Add RavenCreek to Map=', 'Apply the suggested load order', 'Add KI5 Library to the mod list'],
    })

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Stopped at a fix that failed', variant: 'destructive' })))
    expect(store.applyFix).toHaveBeenCalledTimes(2)
    expect(vi.mocked(store.applyFix).mock.calls.map(([entry]) => entry.id)).toEqual([mapIssue.id, orderIssue.id])
    // The page reloads its config once, for the fix that did land.
    expect(props.onFixed).toHaveBeenCalledTimes(1)
    expect(props.onFixed).toHaveBeenCalledWith(first)
  })

  it('skips a problem an earlier fix already solved', async () => {
    const health = healthOf([mapIssue, implicitIssue])
    const { store } = renderView(health)
    confirmSpy.mockResolvedValue(true)
    vi.mocked(store.applyFix).mockResolvedValueOnce({ applied: true, health: healthOf([]) })

    fireEvent.click(screen.getByRole('button', { name: /Fix all safe issues/ }))
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Safe fixes applied' })))
    expect(store.applyFix).toHaveBeenCalledTimes(1)
    expect(toastSpy.mock.calls.at(-1)?.[0].description).toBe('1 fix applied. 1 problem was already gone.')
  })

  it('shows progress while it works', async () => {
    const health = healthOf([mapIssue])
    const { store } = renderView(health)
    confirmSpy.mockResolvedValue(true)
    let finish!: (value: ModHealthFixResult) => void
    vi.mocked(store.applyFix).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: /Fix all safe issues/ }))
    const status = await screen.findByText('Fixing 1 of 1: Add RavenCreek to Map=')
    expect(within(status.closest('[role="status"]') as HTMLElement).getByText(/Fixing 1 of 1/)).toBeInTheDocument()
    finish({ applied: true, health: healthOf([]) })
    await waitFor(() => expect(screen.queryByText('Fixing 1 of 1: Add RavenCreek to Map=')).toBeNull())
  })
})
