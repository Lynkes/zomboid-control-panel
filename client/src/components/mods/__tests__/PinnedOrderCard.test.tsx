import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ModOrderRule } from '@/lib/api'
import { PinnedOrderCard } from '../PinnedOrderCard'
import type { OrderRulesStore } from '../useOrderRules'

// The "Pinned order" card: every rule in words, its note, where it came from,
// who set it and when; a rule naming a mod that is not enabled reads as
// inactive; delete asks first, naming the rule.

const toastSpy = vi.hoisted(() => vi.fn())
const confirmSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))
vi.mock('@/contexts/ConfirmContext', () => ({
  useConfirm: () => confirmSpy,
  ConfirmProvider: ({ children }: { children: unknown }) => children,
}))

const NAMES = new Map([['TchernoLib', "Tsar's Common Library"], ['Brita', "Brita's Weapon Pack"]])
const RULES: ModOrderRule[] = [
  { id: 'r1', before: 'TchernoLib', after: 'Brita', note: 'Brita overrides the library tables.', source: 'manual', createdBy: 'rowan', createdAt: '2026-10-18T09:00:00.000Z' },
  { id: 'r2', before: 'KI5_M35A2', after: 'KI5Fixes', note: '', source: 'conflictResolve', createdBy: null, createdAt: null },
]

function makeStore(overrides: Partial<OrderRulesStore> = {}): OrderRulesStore {
  return { rules: RULES, max: 2000, loadState: 'ready', reload: vi.fn(), add: vi.fn(), remove: vi.fn().mockResolvedValue(undefined), rulesFor: () => [], ...overrides }
}

function renderCard(props: Partial<Parameters<typeof PinnedOrderCard>[0]> = {}) {
  const onChanged = vi.fn()
  const store = props.store ?? makeStore()
  render(
    <TooltipProvider>
      <PinnedOrderCard
        store={store}
        enabledModIds={new Set(['TchernoLib', 'Brita', 'KI5Fixes'])}
        modNames={NAMES}
        canManage
        onChanged={onChanged}
        {...props}
      />
    </TooltipProvider>,
  )
  return { onChanged, store }
}

const row = (id: string) => document.querySelector(`[data-rule-id="${id}"]`) as HTMLElement

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

describe('PinnedOrderCard', () => {
  it('lists each rule in words with its note, source, author and the count', () => {
    renderCard()
    expect(screen.getByText('2 of 2000')).toBeInTheDocument()
    const first = row('r1')
    expect(within(first).getByText("Brita's Weapon Pack always loads after Tsar's Common Library")).toBeInTheDocument()
    expect(within(first).getByText('Brita after TchernoLib')).toBeInTheDocument()
    expect(within(first).getByText('Brita overrides the library tables.')).toBeInTheDocument()
    expect(within(first).getByText('Set by hand')).toBeInTheDocument()
    expect(within(first).getByText(/by rowan/)).toBeInTheDocument()
    expect(within(first).queryByText('Inactive')).toBeNull()

    expect(within(row('r2')).getByText('KI5Fixes always loads after KI5_M35A2')).toBeInTheDocument()
    expect(within(row('r2')).getByText('From a conflict')).toBeInTheDocument()
  })

  it('marks a rule naming a mod that is not enabled as inactive, and says which', () => {
    renderCard()
    const badge = within(row('r2')).getByText('Inactive')
    expect(badge).toHaveAttribute('title', expect.stringContaining('Not enabled on this server: KI5_M35A2.'))
  })

  it('deletes a rule only after a confirm that names it', async () => {
    const { store, onChanged } = renderCard()
    confirmSpy.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: "Delete the rule: Brita's Weapon Pack after Tsar's Common Library" }))
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1))
    expect(confirmSpy.mock.calls[0][0]).toMatchObject({
      title: 'Are you absolutely sure?',
      description: expect.stringContaining("“Brita's Weapon Pack always loads after Tsar's Common Library”"),
      destructive: true,
    })
    expect(store.remove).not.toHaveBeenCalled()

    confirmSpy.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: "Delete the rule: Brita's Weapon Pack after Tsar's Common Library" }))
    await waitFor(() => expect(store.remove).toHaveBeenCalledWith('r1'))
    expect(onChanged).toHaveBeenCalled()
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Rule deleted' }))
  })

  it('toasts a failed delete', async () => {
    const store = makeStore({ remove: vi.fn().mockRejectedValue(new Error('disk full')) })
    const { onChanged } = renderCard({ store })
    confirmSpy.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: /Delete the rule: KI5Fixes after KI5_M35A2/ }))
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'The rule could not be deleted', variant: 'destructive' })))
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('without mods.manage the delete buttons are disabled', () => {
    renderCard({ canManage: false })
    for (const button of screen.getAllByRole('button', { name: /Delete the rule/ })) expect(button).toBeDisabled()
  })

  it('says how to add a rule when there is none', () => {
    renderCard({ store: makeStore({ rules: [] }) })
    expect(screen.getByText('No pinned order yet')).toBeInTheDocument()
    expect(screen.getByText(/pick “Always load after…” or “Always load before…”/)).toBeInTheDocument()
  })
})
