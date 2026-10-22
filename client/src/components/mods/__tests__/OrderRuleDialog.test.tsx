import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError, type ModOrderRule } from '@/lib/api'
import { OrderRuleDialog, PICKER_MAX_ROWS } from '../OrderRuleDialog'
import type { OrderRulesStore } from '../useOrderRules'

// "Always load X after… / before…": a searchable picker over the enabled mods
// (in load order), an optional note, then the rule. A rule the other way round
// is replaced only after asking; a loop is explained inline.

const toastSpy = vi.hoisted(() => vi.fn())
const confirmSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))
vi.mock('@/contexts/ConfirmContext', () => ({
  useConfirm: () => confirmSpy,
  ConfirmProvider: ({ children }: { children: unknown }) => children,
}))

// jsdom has no scrollIntoView; the picker keeps the active option in view.
Element.prototype.scrollIntoView = vi.fn()

const ORDER = ['TchernoLib', 'Brita', 'Brita_2', 'AuthenticZLite', 'KI5Library']
const NAMES = new Map([
  ['TchernoLib', "Tsar's Common Library"],
  ['Brita', "Brita's Weapon Pack"],
  ['AuthenticZLite', 'Authentic Z Lite'],
])

const rule = (id: string, before: string, after: string): ModOrderRule => ({
  id, before, after, note: '', source: 'manual', createdBy: null, createdAt: null,
})

function makeStore(rules: ModOrderRule[] = [], add = vi.fn()): OrderRulesStore {
  return { rules, max: 2000, loadState: 'ready', reload: vi.fn(), add, remove: vi.fn(), rulesFor: () => [] }
}

function renderDialog(props: Partial<Parameters<typeof OrderRuleDialog>[0]> = {}) {
  const onOpenChange = vi.fn()
  const onAdded = vi.fn()
  const store = props.store ?? makeStore()
  render(
    <OrderRuleDialog
      open
      onOpenChange={onOpenChange}
      modId="Brita_2"
      direction="after"
      candidates={ORDER}
      modNames={NAMES}
      store={store}
      onAdded={onAdded}
      {...props}
    />,
  )
  return { onOpenChange, onAdded, store }
}

const options = () => screen.getAllByRole('option')
const search = () => screen.getByRole('combobox')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('OrderRuleDialog', () => {
  it('lists the other enabled mods in load order and narrows them by name or ID', () => {
    renderDialog()
    expect(screen.getByRole('heading', { name: 'Always load Brita_2 after…' })).toBeInTheDocument()
    // The mod itself is not offered.
    expect(options().map((o) => o.textContent)).toEqual([
      "#1Tsar's Common LibraryTchernoLib",
      "#2Brita's Weapon PackBrita",
      '#4Authentic Z LiteAuthenticZLite',
      '#5KI5Library',
    ])

    fireEvent.change(search(), { target: { value: 'weapon' } })
    expect(options()).toHaveLength(1)
    fireEvent.change(search(), { target: { value: 'ki5' } })
    expect(options().map((o) => o.textContent)).toEqual(['#5KI5Library'])
    fireEvent.change(search(), { target: { value: 'nothing like it' } })
    expect(screen.getByText('No enabled mod matches “nothing like it”.')).toBeInTheDocument()
  })

  it('picks with the arrow keys and Enter, and pins "picked before the mod" with the note', async () => {
    const stored = rule('r1', 'Brita', 'Brita_2')
    const add = vi.fn().mockResolvedValue({ rule: stored, existing: false, replaced: [] })
    const { onAdded, onOpenChange } = renderDialog({ store: makeStore([], add) })
    const addButton = screen.getByRole('button', { name: 'Pin this order' })
    expect(addButton).toBeDisabled()

    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(options()[1]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText("Brita_2 will always load after Brita's Weapon Pack.")).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: '  The armor pack patches the weapons.  ' } })
    fireEvent.click(addButton)

    await waitFor(() => expect(add).toHaveBeenCalledWith({
      before: 'Brita',
      after: 'Brita_2',
      source: 'manual',
      note: 'The armor pack patches the weapons.',
    }))
    expect(onAdded).toHaveBeenCalledWith(stored)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Order pinned' }))
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('"before" stores the mod first, and a mod already pinned that way cannot be picked', async () => {
    const add = vi.fn().mockResolvedValue({ rule: rule('r2', 'Brita_2', 'KI5Library'), existing: false, replaced: [] })
    renderDialog({ direction: 'before', store: makeStore([rule('r0', 'Brita_2', 'AuthenticZLite')], add) })
    expect(screen.getByRole('heading', { name: 'Always load Brita_2 before…' })).toBeInTheDocument()

    const pinned = options().find((o) => o.textContent?.includes('AuthenticZLite'))!
    expect(within(pinned).getByText('Already pinned')).toBeInTheDocument()
    fireEvent.click(pinned)
    expect(pinned).toHaveAttribute('aria-selected', 'false')

    fireEvent.click(options().find((o) => o.textContent?.includes('KI5Library'))!)
    fireEvent.click(screen.getByRole('button', { name: 'Pin this order' }))
    await waitFor(() => expect(add).toHaveBeenCalledWith({ before: 'Brita_2', after: 'KI5Library', source: 'manual' }))
  })

  it('asks before replacing a rule the other way round, and sends replaceOpposite when told yes', async () => {
    const add = vi.fn().mockResolvedValue({ rule: rule('r3', 'Brita', 'Brita_2'), existing: false, replaced: ['r0'] })
    renderDialog({ store: makeStore([rule('r0', 'Brita_2', 'Brita')], add) })
    fireEvent.click(options()[1])

    confirmSpy.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: 'Pin this order' }))
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1))
    expect(confirmSpy.mock.calls[0][0]).toMatchObject({
      title: 'Replace the opposite rule?',
      description: "A pinned rule keeps Brita's Weapon Pack after Brita_2. Pinning this order replaces that rule.",
      variant: 'warning',
    })
    expect(add).not.toHaveBeenCalled()

    confirmSpy.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: 'Pin this order' }))
    await waitFor(() => expect(add).toHaveBeenCalledWith({ before: 'Brita', after: 'Brita_2', source: 'manual', replaceOpposite: true }))
  })

  it('explains a loop inline and stays open', async () => {
    const add = vi.fn().mockRejectedValue(new ApiError('loop', {
      status: 409,
      code: 'MODS_ORDER_RULE_CYCLE',
      data: {
        code: 'MODS_ORDER_RULE_CYCLE',
        details: {
          cycle: ['TchernoLib', 'Brita_2', 'Brita', 'TchernoLib'],
          edges: [
            { before: 'TchernoLib', after: 'Brita_2', reason: 'new' },
            { before: 'Brita_2', after: 'Brita', reason: 'rule', ruleId: 'r1' },
            { before: 'Brita', after: 'TchernoLib', reason: 'require' },
          ],
        },
      },
    }))
    const { onOpenChange } = renderDialog({ direction: 'before', modId: 'TchernoLib', store: makeStore([], add) })
    fireEvent.click(options().find((o) => o.textContent?.includes('Brita_2'))!)
    fireEvent.click(screen.getByRole('button', { name: 'Pin this order' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("This would make a loop of 3 mods: Tsar's Common Library → Brita_2 → Brita's Weapon Pack → Tsar's Common Library")
    expect(alert).toHaveTextContent("Tsar's Common Library requires Brita's Weapon Pack")
    expect(alert).toHaveTextContent("a pinned rule keeps Brita's Weapon Pack after Brita_2")
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('renders at most the picker cap and asks to type to narrow the rest', () => {
    const many = Array.from({ length: PICKER_MAX_ROWS + 50 }, (_, i) => `Mod${i}`)
    renderDialog({ modId: 'Mod0', candidates: many, modNames: new Map() })
    expect(options()).toHaveLength(PICKER_MAX_ROWS)
    expect(screen.getByText(`Showing ${PICKER_MAX_ROWS} of ${many.length - 1}. Type to narrow the list.`)).toBeInTheDocument()
  })
})
