import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { modsApi, type LoadOrderPlan, type ModHealth, type ModInsight } from '@/lib/api'
import { WhyHerePopover, type WhyHereProps } from '../WhyHerePopover'
import { ItemInsights } from '../ItemInsights'
import { missingRequirementFix } from '../smartText'
import { useModInsights } from '../useModInsights'
import { useGroupSuggestions } from '../useGroupSuggestions'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, modsApi: { ...actual.modsApi, getModInsights: vi.fn(), getGroupSuggestions: vi.fn() } }
})

afterEach(() => {
  cleanup()
  vi.mocked(modsApi.getModInsights).mockReset()
  vi.mocked(modsApi.getGroupSuggestions).mockReset()
})

const LIB: ModInsight = {
  workshopId: '1',
  source: 'workshop',
  name: 'KI5 Library',
  enabled: true,
  kind: 'library',
  kindConfidence: 'high',
  kindReasons: [{ code: 'manyDependents', params: { count: 4 } }],
  tier: 0,
  patchOf: [],
  dependents: 4,
  requires: [],
  requiredBy: ['KI5Car', 'KI5Truck'],
  steamTags: [],
}

function plan(extra: Partial<LoadOrderPlan> = {}): LoadOrderPlan {
  return {
    order: ['KI5Lib', 'KI5Car'],
    changed: true,
    moves: [{ modId: 'KI5Lib', from: 1, to: 0, confidence: 'high', reasons: [{ code: 'require', params: { relation: 'before', other: 'KI5Car' } }] }],
    explanations: { KI5Lib: [{ code: 'require', params: { relation: 'before', other: 'KI5Car' } }, { code: 'rule', params: { relation: 'after', other: 'Base' } }] },
    satisfied: 1,
    unsatisfied: [],
    cycles: [],
    winnersChanged: [],
    implicit: [],
    warnings: [],
    stats: { constraints: 1, hard: 1, strong: 0, soft: 0, ms: 1 },
    steamStatus: { source: 'none', fetchedAt: null, stale: false, failed: false, pending: false, known: 0, total: 0 },
    ...extra,
  }
}

function renderWhy(overrides: Partial<WhyHereProps> = {}) {
  const anchor = document.createElement('button')
  document.body.appendChild(anchor)
  const props: WhyHereProps = {
    modId: 'KI5Lib',
    anchor,
    onClose: vi.fn(),
    order: ['KI5Car', 'KI5Lib'],
    plan: plan(),
    fresh: true,
    loading: false,
    insight: LIB,
    modNames: new Map([['KI5Lib', 'KI5 Library'], ['KI5Car', 'KI5 Blazer']]),
    groupsById: new Map(),
    groups: [{ id: 'g1', name: 'KI5 Vehicles', description: '', modIds: ['KI5Lib', 'KI5Car'], createdAt: '', updatedAt: '', placement: 'first' }],
    rules: [{ id: 'r1', before: 'Base', after: 'KI5Lib', note: '', source: 'manual', createdBy: null, createdAt: null }],
    canManage: true,
    onPin: vi.fn(),
    onSortNow: vi.fn(),
    ...overrides,
  }
  render(<TooltipProvider><WhyHerePopover {...props} /></TooltipProvider>)
  return props
}

describe('WhyHerePopover', () => {
  it('explains the place in words, where smart sort would move it, what needs it, rules and groups', () => {
    const props = renderWhy()
    expect(screen.getByText('Why is KI5 Library here?')).toBeInTheDocument()
    expect(screen.getByText('#2 of 2')).toBeInTheDocument()
    expect(screen.getByText('Smart sort would move it to #1')).toBeInTheDocument()
    expect(screen.getByText('Loads before KI5 Blazer, which requires it')).toBeInTheDocument()
    expect(screen.getByText('Pinned to load after Base')).toBeInTheDocument()
    expect(screen.getByText('Needed by 2 mods')).toBeInTheDocument()
    expect(screen.getByText('Always loads after Base')).toBeInTheDocument()
    expect(screen.getByText('In the group KI5 Vehicles')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sort now' }))
    expect(props.onSortNow).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Always load before…' }))
    expect(props.onPin).toHaveBeenCalledWith('KI5Lib', 'before')
  })

  it('says nothing ties a mod with no reasons, and hides pins without permission', () => {
    renderWhy({ plan: plan({ moves: [], explanations: {} }), rules: [], groups: [], canManage: false })
    expect(screen.getByText('Nothing ties it to a place: it stays where you put it.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Always load after…' })).toBeNull()
  })
})

describe('ItemInsights', () => {
  const HEALTH: ModHealth = {
    checkedAt: '',
    counts: { critical: 0, warning: 1, info: 0 },
    steamStatus: { source: 'api', fetchedAt: null, stale: false, failed: false, pending: false, known: 1, total: 1 },
    issues: [{
      id: 'requiredWorkshopItemMissing-0123456789abcdef',
      kind: 'requiredWorkshopItemMissing',
      severity: 'warning',
      modIds: [],
      workshopIds: ['222'],
      params: { workshopId: '222' },
      fixes: [{ action: 'addWorkshopItems', params: { workshopIds: ['222'] }, label: 'Add 222' }],
    }],
  }

  it('finds the health fix for a missing required item', () => {
    expect(missingRequirementFix(HEALTH, '222')?.fix.action).toBe('addWorkshopItems')
    expect(missingRequirementFix(HEALTH, '333')).toBeNull()
  })

  it('adds a missing required item through the health fix, else opens the Add dialog', async () => {
    const onApplyFix = vi.fn().mockResolvedValue(undefined)
    const onAddItem = vi.fn()
    render(
      <TooltipProvider>
        <ItemInsights
          modIds={['KI5Lib']}
          insightOf={(id) => (id === 'KI5Lib' ? LIB : undefined)}
          requires={[
            { workshopId: '111', title: 'Present', installed: true, enabled: true },
            { workshopId: '222', title: 'Has a fix', installed: false, enabled: false },
            { workshopId: '333', title: 'No fix', installed: false, enabled: false },
          ]}
          health={HEALTH}
          canManage
          onApplyFix={onApplyFix}
          onAddItem={onAddItem}
        />
      </TooltipProvider>,
    )
    expect(screen.getByText('Library')).toBeInTheDocument()
    expect(screen.getByText('Needed by 4 mods')).toBeInTheDocument()
    expect(screen.getByText('On the server and enabled')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add Has a fix to the server' }))
    await waitFor(() => expect(onApplyFix).toHaveBeenCalledWith(HEALTH.issues[0], HEALTH.issues[0].fixes[0]))
    fireEvent.click(screen.getByRole('button', { name: 'Add No fix to the server' }))
    expect(onAddItem).toHaveBeenCalledWith('333')
  })
})

describe('useModInsights', () => {
  it('reads once per saved list, own keys only, and refreshes Steam on demand', async () => {
    vi.mocked(modsApi.getModInsights).mockResolvedValue({
      generatedAt: '',
      steamStatus: { source: 'api', fetchedAt: null, stale: false, failed: false, pending: false, known: 1, total: 1 },
      mods: { KI5Lib: LIB },
      workshopRequirements: [{ workshopId: '1', title: null, requires: [{ workshopId: '2', title: null, installed: false, enabled: false }] }],
      constraints: [],
    })
    const { result, rerender } = renderHook((props: { key: string }) => useModInsights({ enabled: true, refreshKey: props.key }), { initialProps: { key: 'a' } })
    await waitFor(() => expect(result.current.loadState).toBe('ready'))
    expect(result.current.insightOf('KI5Lib')?.kind).toBe('library')
    expect(result.current.insightOf('constructor')).toBeUndefined()
    expect(result.current.requirementsOf('1')).toHaveLength(1)
    rerender({ key: 'a' })
    expect(modsApi.getModInsights).toHaveBeenCalledTimes(1)
    rerender({ key: 'b' })
    await waitFor(() => expect(modsApi.getModInsights).toHaveBeenCalledTimes(2))
    await act(async () => { await result.current.refreshSteam() })
    expect(vi.mocked(modsApi.getModInsights).mock.calls.at(-1)).toEqual([true])
  })
})

describe('useGroupSuggestions', () => {
  it('reads the suggestions again when the active server (refresh key) changes', async () => {
    vi.mocked(modsApi.getGroupSuggestions).mockResolvedValue({ suggestions: [] })
    const { rerender } = renderHook((props: { key: string }) => useGroupSuggestions(true, props.key), { initialProps: { key: 'server-a.ini|a;b' } })
    await waitFor(() => expect(modsApi.getGroupSuggestions).toHaveBeenCalledTimes(1))
    rerender({ key: 'server-a.ini|a;b' })
    expect(modsApi.getGroupSuggestions).toHaveBeenCalledTimes(1)
    rerender({ key: 'server-b.ini|c' })
    await waitFor(() => expect(modsApi.getGroupSuggestions).toHaveBeenCalledTimes(2))
  })
})
