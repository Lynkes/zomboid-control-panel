import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ModHealth, ModHealthIssue } from '@/lib/api'
import { DuplicateItemsNotice } from '../DuplicateItemsNotice'
import { HealthView } from '../HealthView'
import { duplicateItemSets, keepFixesFor } from '../duplicateItems'
import type { ModHealthStore } from '../useModHealth'

// Two Workshop items that ship the same mods (a fork next to its original,
// the real case: Spongie's Details Pack HD Textures and its [TWIST] fork both
// ship SPNCCDetails, SPNCCDetailsHD, SPNCCFaces and SPNCC): one sentence per
// pair of items, the same in the Health view, and "Keep <item>" through the
// health check's fix after a confirm naming exactly what is removed.

const toastSpy = vi.hoisted(() => vi.fn())
const confirmSpy = vi.hoisted(() => vi.fn())

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))
vi.mock('@/contexts/ConfirmContext', () => ({
  useConfirm: () => confirmSpy,
  ConfirmProvider: ({ children }: { children: unknown }) => children,
}))

const ORIGINAL = '3414634809'
const FORK = '3699104148'
const SHARED = ['SPNCCDetails', 'SPNCCDetailsHD', 'SPNCCFaces', 'SPNCC']
const TITLES: Record<string, string> = {
  [ORIGINAL]: "Spongie's Character Customisation - Details Pack HD Textures",
  [FORK]: 'Spongies Character Customisation [TWIST] - Details Pack HD Textures',
}
const SENTENCE =
  "2 Workshop items ship the same mods (SPNCCDetails, SPNCCDetailsHD, SPNCCFaces, and SPNCC): Spongie's Character Customisation - Details Pack HD Textures and Spongies Character Customisation [TWIST] - Details Pack HD Textures. " +
  "The server loads only one copy of each, and which one isn't defined. Keep one of the two items."

const ISSUE: ModHealthIssue = {
  id: 'duplicateModId-0123456789abcdef',
  kind: 'duplicateModId',
  severity: 'warning',
  modIds: SHARED,
  workshopIds: [ORIGINAL, FORK],
  params: { modId: SHARED[0], modIds: SHARED, workshopIds: [ORIGINAL, FORK], loads: null },
  fixes: [
    { action: 'removeWorkshopItems', params: { workshopIds: [FORK], keep: ORIGINAL, dedupeModIds: ['SPNCCDetails'] }, label: `Keep Workshop item ${ORIGINAL}: remove ${FORK}` },
    { action: 'removeWorkshopItems', params: { workshopIds: [ORIGINAL], keep: FORK, modIds: ['SPNCCOriginalOnly'] }, label: `Keep Workshop item ${FORK}: remove ${ORIGINAL}` },
  ],
}

const HEALTH: ModHealth = {
  checkedAt: '2026-10-20T10:00:00.000Z',
  counts: { critical: 0, warning: 1, info: 0 },
  issues: [ISSUE],
  steamStatus: { source: 'api', fetchedAt: null, stale: false, failed: false, pending: false, known: 0, total: 0 },
}

function storeOf(): ModHealthStore {
  return {
    health: HEALTH,
    loadState: 'ready',
    error: null,
    reload: vi.fn().mockResolvedValue(undefined),
    applyFix: vi.fn().mockResolvedValue({ applied: true, health: HEALTH }),
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('duplicateItemSets', () => {
  it('is one entry per set of Workshop items, not one per mod ID', () => {
    const providers = new Map<string, string[]>([
      ...SHARED.map((id) => [id, [ORIGINAL, FORK]] as [string, string[]]),
      ['Solo', [ORIGINAL]],
      ['Other', ['1', '2', '1']],
    ])
    const sets = duplicateItemSets(providers)
    expect(sets).toEqual([
      { key: `${ORIGINAL},${FORK}`, workshopIds: [ORIGINAL, FORK], modIds: SHARED },
      { key: '1,2', workshopIds: ['1', '2'], modIds: ['Other'] },
    ])
    expect(keepFixesFor(HEALTH, sets[0])?.fixes).toHaveLength(2)
    expect(keepFixesFor(HEALTH, sets[1])).toBeNull()
  })
})

describe('DuplicateItemsNotice', () => {
  function renderNotice(store = storeOf(), canManage = true) {
    const onFixed = vi.fn()
    const [set] = duplicateItemSets(new Map(SHARED.map((id) => [id, [ORIGINAL, FORK]])))
    render(
      <TooltipProvider>
        <DuplicateItemsNotice set={set} store={store} canManage={canManage} modName={() => undefined} itemTitle={(ws) => TITLES[ws]} onFixed={onFixed} />
      </TooltipProvider>,
    )
    return { store, onFixed }
  }

  it('says it in one sentence naming both items and the shared mods', () => {
    renderNotice()
    expect(screen.getByText(SENTENCE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `Keep ${TITLES[ORIGINAL]}` })).toBeEnabled()
    expect(screen.getByRole('button', { name: `Keep ${TITLES[FORK]}` })).toBeEnabled()
  })

  it('Keep asks first, naming exactly what is removed, then applies the health fix', async () => {
    confirmSpy.mockResolvedValue(true)
    const { store, onFixed } = renderNotice()

    fireEvent.click(screen.getByRole('button', { name: `Keep ${TITLES[ORIGINAL]}` }))

    await waitFor(() => expect(store.applyFix).toHaveBeenCalledWith(ISSUE, ISSUE.fixes[0]))
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Are you absolutely sure?',
      description: `${TITLES[ORIGINAL]} stays. A backup of the server ini is made, then this is removed from it:`,
      items: [`From WorkshopItems=: ${TITLES[FORK]} (${FORK})`, 'From Mods=: the extra entry of SPNCCDetails'],
      destructive: true,
    }))
    expect(onFixed).toHaveBeenCalledWith({ applied: true, health: HEALTH })
  })

  it('names the mods only the removed item ships', async () => {
    confirmSpy.mockResolvedValue(false)
    const { store } = renderNotice()

    fireEvent.click(screen.getByRole('button', { name: `Keep ${TITLES[FORK]}` }))

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(confirmSpy.mock.calls[0][0].items).toEqual([`From WorkshopItems=: ${TITLES[ORIGINAL]} (${ORIGINAL})`, 'From Mods=: SPNCCOriginalOnly'])
    expect(store.applyFix).not.toHaveBeenCalled()
  })

  it('without mods.manage the Keep buttons are disabled', () => {
    renderNotice(storeOf(), false)
    expect(screen.getByRole('button', { name: `Keep ${TITLES[ORIGINAL]}` })).toBeDisabled()
  })
})

describe('HealthView: the same wording for a duplicate', () => {
  it('words the issue with the same sentence and offers Keep <item>', () => {
    render(
      <MemoryRouter>
        <TooltipProvider>
          <HealthView
            store={storeOf()}
            canManage
            modName={() => undefined}
            itemTitle={(ws) => TITLES[ws]}
            onShowMod={vi.fn()}
            onShowWorkshopItem={vi.fn()}
            onFixed={vi.fn()}
          />
        </TooltipProvider>
      </MemoryRouter>,
    )
    expect(screen.getByText('The same mods are installed twice')).toBeInTheDocument()
    expect(screen.getByText(SENTENCE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `Keep ${TITLES[FORK]}` })).toBeInTheDocument()
  })
})
