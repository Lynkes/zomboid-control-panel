import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Mods from '../Mods'
import { modsApi, serversApi, type ModHealth, type ModHealthIssue } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import { openModsView } from './modsNav'

// The live case on a 150-mod server: Workshop 3414634809 (Spongie's ...
// Details Pack HD Textures) and its fork 3699104148 ([TWIST]) both ship
// SPNCCDetails, SPNCCDetailsHD, SPNCCFaces and SPNCC, and Mods= lists
// SPNCCDetails twice. The banner used to say "Duplicate Mods: Duplicate mod
// IDs found: SPNCCDetails" with a vague Fix; it now names both items in one
// sentence and offers Keep <item> through the health check's fix.

const confirmSpy = vi.hoisted(() => vi.fn())
vi.mock('@/contexts/ConfirmContext', () => ({
  useConfirm: () => confirmSpy,
  ConfirmProvider: ({ children }: { children: unknown }) => children,
}))

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    modsApi: {
      ...actual.modsApi,
      getTrackedMods: vi.fn(),
      getStatus: vi.fn(),
      getCurrentConfig: vi.fn(),
      getIgnoredMods: vi.fn(),
      getIgnoredModPairs: vi.fn(),
      collectionDiff: vi.fn(),
      getPresets: vi.fn(),
      getCachedConflicts: vi.fn(),
      listDiskOnly: vi.fn(),
      getModHealth: vi.fn(),
      applyModHealthFix: vi.fn(),
      deduplicateModIds: vi.fn(),
    },
    serversApi: {
      ...actual.serversApi,
      getActive: vi.fn(),
    },
  }
})

const m = vi.mocked(modsApi)

const ORIGINAL = '3414634809'
const FORK = '3699104148'
const SHARED = ['SPNCCDetails', 'SPNCCDetailsHD', 'SPNCCFaces', 'SPNCC']
const TITLE_ORIGINAL = "Spongie's Character Customisation - Details Pack HD Textures"
const TITLE_FORK = 'Spongies Character Customisation [TWIST] - Details Pack HD Textures'

const ISSUE: ModHealthIssue = {
  id: 'duplicateModId-0123456789abcdef',
  kind: 'duplicateModId',
  severity: 'warning',
  modIds: SHARED,
  workshopIds: [ORIGINAL, FORK],
  params: { modId: SHARED[0], modIds: SHARED, workshopIds: [ORIGINAL, FORK], loads: null, titles: { [ORIGINAL]: TITLE_ORIGINAL, [FORK]: TITLE_FORK } },
  fixes: [
    { action: 'removeWorkshopItems', params: { workshopIds: [FORK], keep: ORIGINAL, dedupeModIds: ['SPNCCDetails'] }, label: 'Keep' },
    { action: 'removeWorkshopItems', params: { workshopIds: [ORIGINAL], keep: FORK, dedupeModIds: ['SPNCCDetails'] }, label: 'Keep' },
  ],
}
const HEALTH: ModHealth = {
  checkedAt: '2026-10-20T10:00:00.000Z',
  counts: { critical: 0, warning: 1, info: 0 },
  issues: [ISSUE],
  steamStatus: { source: 'api', fetchedAt: null, stale: false, failed: false, pending: false, known: 0, total: 0 },
}

function prime() {
  const workshopModMap = Object.fromEntries([ORIGINAL, FORK].map((ws) => [ws, SHARED.map((id) => ({ id, name: id, enabled: true }))]))
  m.getTrackedMods.mockResolvedValue({ mods: [] } as never)
  m.getStatus.mockResolvedValue({ totalModsTracked: 2, workshopAcfConfigured: false, autoRestartEnabled: false } as never)
  m.getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds: [...SHARED, 'SPNCCDetails'],
    workshopIds: [ORIGINAL, FORK],
    maps: [],
    totalMods: 5,
    workshopModMap,
  } as never)
  m.getIgnoredMods.mockResolvedValue([] as never)
  m.getIgnoredModPairs.mockResolvedValue([] as never)
  m.collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  m.getPresets.mockResolvedValue([] as never)
  m.getCachedConflicts.mockResolvedValue(null as never)
  m.listDiskOnly.mockResolvedValue({ mods: [] } as never)
  m.getModHealth.mockResolvedValue(HEALTH)
  m.applyModHealthFix.mockResolvedValue({ applied: true, health: { ...HEALTH, counts: { critical: 0, warning: 0, info: 0 }, issues: [] } } as never)
  vi.mocked(serversApi.getActive).mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as never)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

describe('Active on server: two Workshop items shipping the same mods', () => {
  it('says it in one sentence naming both items, and Keep <item> removes the other through the health fix', async () => {
    prime()
    confirmSpy.mockResolvedValue(true)
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Mods />
        </TooltipProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
    await openModsView('Active on server')

    const sentence =
      `2 Workshop items ship the same mods (SPNCCDetails, SPNCCDetailsHD, SPNCCFaces, and SPNCC): ${TITLE_ORIGINAL} and ${TITLE_FORK}. ` +
      "The server loads only one copy of each, and which one isn't defined. Keep one of the two items."
    expect((await screen.findAllByText(sentence)).length).toBeGreaterThan(0)
    // The repeated SPNCCDetails entry is part of the pair's Keep, not a second vague banner.
    expect(screen.queryByText(/Listed more than once in Mods=/)).toBeNull()
    expect(screen.queryByText(/Duplicate mod IDs found/)).toBeNull()
    // The row badge and the chips say the same thing.
    expect(screen.getByText('4 duplicate IDs').closest('[title]')).toHaveAttribute('title', sentence)

    fireEvent.click(screen.getAllByRole('button', { name: `Keep ${TITLE_ORIGINAL}` })[0])

    await waitFor(() => expect(m.applyModHealthFix).toHaveBeenCalledWith(ISSUE.id, 'removeWorkshopItems', ISSUE.fixes[0].params))
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({
      items: [`From WorkshopItems=: ${TITLE_FORK} (${FORK})`, 'From Mods=: the extra entry of SPNCCDetails'],
    }))
    expect(m.deduplicateModIds).not.toHaveBeenCalled()
  })

  it('a repeated Mods= entry no Workshop pair explains keeps its own plain line', async () => {
    prime()
    m.getCurrentConfig.mockResolvedValue({
      configured: true,
      modIds: ['Solo', 'Solo'],
      workshopIds: ['100'],
      maps: [],
      totalMods: 1,
      workshopModMap: { 100: [{ id: 'Solo', name: 'Solo', enabled: true }] },
    } as never)
    m.getModHealth.mockResolvedValue({ ...HEALTH, counts: { critical: 0, warning: 0, info: 0 }, issues: [] })
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Mods />
        </TooltipProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
    await openModsView('Active on server')
    expect(await screen.findByText('Listed more than once in Mods=: Solo. The server loads each mod once, so the extra entries do nothing.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove the extra entries' })).toBeInTheDocument()
  })
})
