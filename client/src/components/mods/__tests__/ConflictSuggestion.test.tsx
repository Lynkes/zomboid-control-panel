import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiError, type ConflictWinnerSuggestion, type ModOrderRule } from '@/lib/api'
import type { ConflictPair } from '@/types'
import { ConflictSuggestion, ConflictSuggestionChip } from '../ConflictSuggestion'
import { highConfidenceSuggestions, type ConflictsSmart } from '../conflictSuggestions'
import { ConflictSuggestionsBar } from '../ConflictSuggestionsBar'
import type { OrderRulesStore } from '../useOrderRules'

// Suggested conflict winners: the reason in words and how sure, "Already the
// winner", one click to pin it (the loser always loads before the winner),
// then "Sort now"; and "Apply all high-confidence suggestions" above the list.

const toastSpy = vi.hoisted(() => vi.fn())
const confirmSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))
vi.mock('@/contexts/ConfirmContext', () => ({
  useConfirm: () => confirmSpy,
  ConfirmProvider: ({ children }: { children: unknown }) => children,
}))

function pair(a: string, b: string, suggestion?: ConflictWinnerSuggestion, names: Record<string, string> = {}): ConflictPair {
  return {
    modA: { workshopId: 'wsA', modId: a, modName: names[a] ?? a },
    modB: { workshopId: 'wsB', modId: b, modName: names[b] ?? b },
    files: [{ file: 'media/lua/shared/x.lua', category: 'lua', severity: 'high' }],
    highCount: 1,
    mediumCount: 0,
    lowCount: 0,
    ...(suggestion ? { suggestion } : {}),
  }
}

const rule = (id: string, before: string, after: string): ModOrderRule => ({
  id, before, after, note: '', source: 'conflictResolve', createdBy: null, createdAt: null,
})

function makeSmart(rules: ModOrderRule[] = [], add = vi.fn().mockResolvedValue({ rule: rule('n', 'x', 'y'), existing: false, replaced: [] }), canManage = true) {
  const store: OrderRulesStore = { rules, max: 2000, loadState: 'ready', reload: vi.fn(), add, remove: vi.fn(), rulesFor: () => [] }
  const smart: ConflictsSmart = { rules: store, canManage, onRuleAdded: vi.fn(), onSortNow: vi.fn() }
  return smart
}

const NAMES = { KI5_M35A2: '[KI5] M35A2 Truck', KI5Fixes: '[KI5] Vehicle Fixes' }
const FIXES_WIN: ConflictWinnerSuggestion = { winner: 'KI5Fixes', confidence: 'high', reason: 'requiresOther', alreadyWinning: false }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ConflictSuggestion', () => {
  it('says who should win, how sure and why, and pins loser-before-winner as a conflict rule', async () => {
    const smart = makeSmart()
    render(<TooltipProvider><ConflictSuggestion pair={pair('KI5_M35A2', 'KI5Fixes', FIXES_WIN, NAMES)} smart={smart} /></TooltipProvider>)

    expect(screen.getByText('Suggested: [KI5] Vehicle Fixes should load last and win')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'High confidence' })).toBeInTheDocument()
    expect(screen.getByText('[KI5] Vehicle Fixes requires [KI5] M35A2 Truck, so it is meant to override it.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Pin [KI5] Vehicle Fixes to load after [KI5] M35A2 Truck' }))
    await waitFor(() => expect(smart.rules.add).toHaveBeenCalledWith({ before: 'KI5_M35A2', after: 'KI5Fixes', source: 'conflictResolve' }))
    expect(smart.onRuleAdded).toHaveBeenCalledTimes(1)

    // The toast offers "Sort now", which opens the smart sort preview.
    const toastArgs = toastSpy.mock.calls[0][0]
    expect(toastArgs.title).toBe('Order pinned')
    render(toastArgs.action)
    fireEvent.click(screen.getAllByText('Sort now').at(-1)!)
    expect(smart.onSortNow).toHaveBeenCalledTimes(1)
  })

  it('shows "Already the winner" and offers nothing to apply', () => {
    render(<TooltipProvider><ConflictSuggestion pair={pair('KI5_M35A2', 'KI5Fixes', { ...FIXES_WIN, alreadyWinning: true }, NAMES)} smart={makeSmart()} /></TooltipProvider>)
    expect(screen.getByText('Already the winner')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Pin/ })).toBeNull()
  })

  it('never offers to store a rule that exists: it offers to sort instead', () => {
    const smart = makeSmart([rule('r1', 'KI5_M35A2', 'KI5Fixes')])
    render(<TooltipProvider><ConflictSuggestion pair={pair('KI5_M35A2', 'KI5Fixes', { ...FIXES_WIN, reason: 'rule' }, NAMES)} smart={smart} /></TooltipProvider>)
    expect(screen.getByText('Pinned. Sort the load order to apply it.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Pin / })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sort now' }))
    expect(smart.onSortNow).toHaveBeenCalled()
  })

  it('asks before replacing the opposite rule, then sends replaceOpposite', async () => {
    const smart = makeSmart([rule('r1', 'KI5Fixes', 'KI5_M35A2')])
    render(<TooltipProvider><ConflictSuggestion pair={pair('KI5_M35A2', 'KI5Fixes', FIXES_WIN, NAMES)} smart={smart} /></TooltipProvider>)
    confirmSpy.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: /^Pin / }))
    await waitFor(() => expect(smart.rules.add).toHaveBeenCalledWith({ before: 'KI5_M35A2', after: 'KI5Fixes', source: 'conflictResolve', replaceOpposite: true }))
    expect(confirmSpy.mock.calls[0][0]).toMatchObject({
      description: 'A pinned rule keeps [KI5] M35A2 Truck after [KI5] Vehicle Fixes. Pinning this order replaces that rule.',
      variant: 'warning',
    })
  })

  it('explains a loop inline instead of pinning', async () => {
    const add = vi.fn().mockRejectedValue(new ApiError('loop', {
      status: 409,
      code: 'MODS_ORDER_RULE_CYCLE',
      data: {
        code: 'MODS_ORDER_RULE_CYCLE',
        details: {
          cycle: ['KI5_M35A2', 'KI5Fixes', 'KI5_M35A2'],
          edges: [
            { before: 'KI5_M35A2', after: 'KI5Fixes', reason: 'new' },
            { before: 'KI5Fixes', after: 'KI5_M35A2', reason: 'require' },
          ],
        },
      },
    }))
    const smart = makeSmart([], add)
    render(<TooltipProvider><ConflictSuggestion pair={pair('KI5_M35A2', 'KI5Fixes', FIXES_WIN, NAMES)} smart={smart} /></TooltipProvider>)
    fireEvent.click(screen.getByRole('button', { name: /^Pin / }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('[KI5] M35A2 Truck requires [KI5] Vehicle Fixes')
    expect(smart.onRuleAdded).not.toHaveBeenCalled()
  })

  it('words the small-override reason with its file counts', () => {
    render(
      <TooltipProvider>
        <ConflictSuggestion
          pair={pair('BigPack', 'TinyFix', { winner: 'TinyFix', confidence: 'medium', reason: 'smallOverride', alreadyWinning: false, params: { files: 4, conflicting: 3, otherFiles: 900 } })}
          smart={makeSmart()}
        />
      </TooltipProvider>,
    )
    expect(screen.getByText('TinyFix is a small mod (4 files) and 3 of its files replace files of BigPack (900 files): a deliberate override.')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Medium confidence' })).toBeInTheDocument()
  })
})

describe('ConflictSuggestionChip', () => {
  it('names the suggested winner, or says the order is already as suggested', () => {
    const { rerender } = render(<ConflictSuggestionChip pair={pair('KI5_M35A2', 'KI5Fixes', FIXES_WIN, NAMES)} />)
    expect(screen.getByText('Suggest: [KI5] Vehicle Fixes')).toBeInTheDocument()
    rerender(<ConflictSuggestionChip pair={pair('KI5_M35A2', 'KI5Fixes', { ...FIXES_WIN, alreadyWinning: true }, NAMES)} />)
    expect(screen.getByText('As suggested')).toBeInTheDocument()
    rerender(<ConflictSuggestionChip pair={pair('KI5_M35A2', 'KI5Fixes')} />)
    expect(screen.queryByText(/Suggest/)).toBeNull()
  })
})

describe('ConflictSuggestionsBar', () => {
  const PAIRS = [
    pair('KI5_M35A2', 'KI5Fixes', FIXES_WIN, NAMES),
    pair('Brita', 'AuthenticZLite', { winner: 'Brita', confidence: 'high', reason: 'declaresLoadAfter', alreadyWinning: false }),
    pair('TchernoLib', 'Brita', { winner: 'Brita', confidence: 'high', reason: 'requiresOther', alreadyWinning: true }),
    pair('BetterSorting', 'Compat', { winner: 'Compat', confidence: 'medium', reason: 'patchOfOther', alreadyWinning: false }),
    pair('X', 'Y', { winner: 'Y', confidence: 'high', reason: 'requiresOther', alreadyWinning: false }),
  ]

  it('offers only high-confidence suggestions that are not winning and not pinned either way', () => {
    const smart = makeSmart([rule('r1', 'X', 'Y')])
    expect(highConfidenceSuggestions(PAIRS, smart).map((s) => s.winner)).toEqual(['KI5Fixes', 'Brita'])
    // A stored rule the other way round (Brita before AuthenticZLite) is the operator's call: not in bulk.
    const opposite = makeSmart([rule('r1', 'Brita', 'AuthenticZLite')])
    expect(highConfidenceSuggestions(PAIRS, opposite).map((s) => `${s.loser}>${s.winner}`)).toEqual(['KI5_M35A2>KI5Fixes', 'X>Y'])
  })

  it('confirms once with the list, applies them one by one and offers Sort now', async () => {
    const smart = makeSmart([rule('r1', 'X', 'Y')])
    render(<TooltipProvider><ConflictSuggestionsBar pairs={PAIRS} smart={smart} /></TooltipProvider>)
    expect(screen.getByText('2 suggested winners are high confidence and not applied yet.')).toBeInTheDocument()

    confirmSpy.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: 'Apply all high-confidence suggestions (2)' }))
    await waitFor(() => expect(smart.rules.add).toHaveBeenCalledTimes(2))
    expect(confirmSpy.mock.calls[0][0]).toMatchObject({
      title: 'Pin these winners?',
      items: ['[KI5] Vehicle Fixes after [KI5] M35A2 Truck', 'Brita after AuthenticZLite'],
      confirmLabel: 'Pin 2 rules',
    })
    expect(vi.mocked(smart.rules.add).mock.calls.map((call) => call[0])).toEqual([
      { before: 'KI5_M35A2', after: 'KI5Fixes', source: 'conflictResolve' },
      { before: 'AuthenticZLite', after: 'Brita', source: 'conflictResolve' },
    ])
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: '2 rules pinned' })))
    expect(toastSpy.mock.calls[0][0].action).toBeTruthy()
    expect(smart.onRuleAdded).toHaveBeenCalledTimes(1)
  })

  it('stops at the first refusal and says which one', async () => {
    const add = vi.fn()
      .mockResolvedValueOnce({ rule: rule('n1', 'KI5_M35A2', 'KI5Fixes'), existing: false, replaced: [] })
      .mockRejectedValueOnce(new ApiError('cap', { status: 409, code: 'MODS_ORDER_RULE_LIMIT', data: { code: 'MODS_ORDER_RULE_LIMIT', params: { max: 1 } } }))
    const smart = makeSmart([], add)
    render(<TooltipProvider><ConflictSuggestionsBar pairs={PAIRS} smart={smart} /></TooltipProvider>)
    confirmSpy.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: 'Apply all high-confidence suggestions (3)' }))

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Stopped after 1 rule',
      description: 'Brita after AuthenticZLite: You can keep at most 1 pinned rules. Delete one first.',
      variant: 'destructive',
    })))
    expect(add).toHaveBeenCalledTimes(2)
    expect(smart.onRuleAdded).toHaveBeenCalledTimes(1)
  })

  it('applies nothing when the confirm is declined, and is hidden with nothing to offer', async () => {
    const smart = makeSmart()
    const { unmount } = render(<TooltipProvider><ConflictSuggestionsBar pairs={PAIRS} smart={smart} /></TooltipProvider>)
    confirmSpy.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: /Apply all/ }))
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(smart.rules.add).not.toHaveBeenCalled()
    unmount()

    render(<TooltipProvider><ConflictSuggestionsBar pairs={[PAIRS[2]]} smart={smart} /></TooltipProvider>)
    expect(screen.queryByRole('button', { name: /Apply all/ })).toBeNull()
  })
})
