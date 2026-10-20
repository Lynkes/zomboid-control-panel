import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { LoadOrderPlan, ModGroup } from '@/lib/api'
import { SmartSortPreview, type SmartSortPreviewProps } from '../SmartSortPreview'

afterEach(cleanup)

const KI5: ModGroup = { id: 'g1', name: 'KI5 Vehicles', description: '', modIds: ['KI5Lib', 'KI5Car'], createdAt: '', updatedAt: '', color: 'amber' }

function plan(extra: Partial<LoadOrderPlan> = {}): LoadOrderPlan {
  return {
    order: ['KI5Lib', 'KI5Car', 'Other'],
    changed: true,
    moves: [
      {
        modId: 'KI5Lib',
        from: 1,
        to: 0,
        confidence: 'high',
        reasons: [
          { code: 'require', params: { relation: 'before', other: 'KI5Car' } },
          { code: 'groupOrder', params: { relation: 'before', other: 'KI5Car', group: 'g1', groupName: 'KI5 Vehicles' } },
        ],
      },
      { modId: 'Other', from: 0, to: 2, confidence: 'low', reasons: [{ code: 'displaced', params: {} }] },
    ],
    explanations: {},
    satisfied: 3,
    unsatisfied: [
      { before: 'Arsenal', after: 'Brita', reason: 'require', why: 'missingMod' },
      { before: 'A', after: 'B', reason: 'patch', why: 'conflictsWithHarder', by: 'rule' },
    ],
    cycles: [{ mods: ['X', 'Y', 'X'], droppedEdge: { before: 'Y', after: 'X', reason: 'loadAfter' } }],
    winnersChanged: [],
    implicit: [{ modId: 'tsarlib', requiredBy: ['Trailers'] }],
    warnings: [{ code: 'keepTogetherBroken', params: { group: 'g1', groupName: 'KI5 Vehicles', mods: ['Other'] } }],
    stats: { constraints: 4, hard: 3, strong: 1, soft: 0, ms: 12.4 },
    steamStatus: { source: 'api', fetchedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), stale: false, failed: false, pending: false, known: 3, total: 3 },
    ...extra,
  }
}

function renderPreview(overrides: Partial<SmartSortPreviewProps> = {}) {
  const props: SmartSortPreviewProps = {
    state: { plan: plan(), mode: 'minimal', input: ['Other', 'KI5Lib', 'KI5Car'] },
    busy: false,
    modNames: new Map([['KI5Lib', '[KI5] Vehicle Library'], ['KI5Car', '[KI5] Blazer'], ['Brita', "Brita's Weapon Pack"]]),
    groupsById: new Map([[KI5.id, KI5]]),
    membership: new Map([['KI5Lib', [KI5]], ['KI5Car', [KI5]]]),
    tiered: false,
    onTieredChange: vi.fn(),
    onApply: vi.fn(),
    onCancel: vi.fn(),
    onRefreshSteam: vi.fn(),
    ...overrides,
  }
  render(<TooltipProvider><SmartSortPreview {...props} /></TooltipProvider>)
  return props
}

describe('SmartSortPreview', () => {
  it('lists each move under its group with every reason in words and a confidence marker', () => {
    renderPreview()
    expect(screen.getByRole('heading', { name: '2 mods move' })).toBeInTheDocument()
    const groupHeading = screen.getByText('KI5 Vehicles', { selector: 'p' })
    expect(groupHeading).toHaveTextContent('1 move')
    expect(screen.getByText('Loads before [KI5] Blazer, which requires it')).toBeInTheDocument()
    expect(screen.getByText('Comes before [KI5] Blazer in the group KI5 Vehicles')).toBeInTheDocument()
    expect(screen.getByText('Moved aside to make room for mods that had to move')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'High confidence' })).toBeInTheDocument()
    expect(screen.getByText('moves from position 2 to 1')).toBeInTheDocument()
    expect(screen.getByText('Other mods')).toBeInTheDocument()
  })

  it('explains loops, unmet rules, broken blocks, implicit and missing mods in plain words', () => {
    renderPreview()
    const problems = screen.getByRole('status')
    expect(within(problems).getByText('3 things could not be met')).toBeInTheDocument()
    expect(within(problems).getByText(/X, Y, X go round in a loop; the order between Y and X \(mod\.info's load order\) was dropped/)).toBeInTheDocument()
    expect(within(problems).getByText('B should load after A (a patch), but a pinned order says otherwise')).toBeInTheDocument()
    expect(within(problems).getByText('KI5 Vehicles cannot stay together: Other must load between its members')).toBeInTheDocument()
    expect(screen.getByText('The game loads tsarlib first anyway: Trailers requires it, but it is not in your list')).toBeInTheDocument()
    expect(screen.getByText("Brita's Weapon Pack requires Arsenal, which is not installed")).toBeInTheDocument()
  })

  it('shows the Steam data age with a Refresh, and switches to the tiered mode', () => {
    const props = renderPreview()
    expect(screen.getByText(/^Steam data from .*3/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(props.onRefreshSteam).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: 'Libraries first, patches and translations last' }))
    expect(props.onTieredChange).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(props.onApply).toHaveBeenCalled()
  })

  it('says "Already in a good order" with only a Close when nothing moves', () => {
    const props = renderPreview({ state: { plan: plan({ changed: false, moves: [], unsatisfied: [], cycles: [], warnings: [], implicit: [] }), mode: 'minimal', input: [] } })
    expect(screen.getByRole('heading', { name: 'Already in a good order' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(props.onCancel).toHaveBeenCalled()
  })
})
