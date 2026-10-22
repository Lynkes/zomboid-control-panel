import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Mods from '../Mods'
import { modsApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import { openModsView } from './modsNav'

// An enabled mod ID that no Workshop item on disk ships never loads: the
// "Needs attention" filter lists it, as it did in v1.4.17 (the redesigned
// filter chips hid it as soon as any chip was on).

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
    },
    serversApi: {
      ...actual.serversApi,
      getActive: vi.fn(),
    },
  }
})

const m = vi.mocked(modsApi)

type ModMap = Record<string, Array<{ id: string; name: string; enabled: boolean }>>

// A: fully enabled. B: its only ID is not enabled. C: two IDs, one enabled.
const MIXED: ModMap = {
  '100': [{ id: 'ModA', name: 'Alpha Mod', enabled: true }],
  '200': [{ id: 'ModB', name: 'Bravo Mod', enabled: false }],
  '300': [
    { id: 'ModC1', name: 'Charlie One', enabled: true },
    { id: 'ModC2', name: 'Charlie Two', enabled: false },
  ],
}

function prime(workshopModMap: ModMap) {
  const ids = Object.values(workshopModMap).flat()
  m.getTrackedMods.mockResolvedValue({ mods: [] } as never)
  m.getStatus.mockResolvedValue({ totalModsTracked: 3, workshopAcfConfigured: false, autoRestartEnabled: false } as never)
  m.getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds: ids.filter((i) => i.enabled).map((i) => i.id),
    workshopIds: Object.keys(workshopModMap),
    maps: [],
    totalMods: ids.length,
    workshopModMap,
  } as never)
  m.getIgnoredMods.mockResolvedValue([] as never)
  m.getIgnoredModPairs.mockResolvedValue([] as never)
  m.collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  m.getPresets.mockResolvedValue([] as never)
  m.getCachedConflicts.mockResolvedValue(null as never)
  m.listDiskOnly.mockResolvedValue({ mods: [] } as never)
  vi.mocked(serversApi.getActive).mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as never)
}

async function openActive() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
  await openModsView('Active on server')
  await screen.findByText(/IDs enabled/)
}

// The Multi-ID chip starts on and hides single-ID items; turn it off so every item is listed.
function showAllItems() {
  // The chip itself, not the "Remove filter" button of its remembered-filter tag.
  const multi = screen.queryByRole('button', { name: /^Multi-ID/ })
  if (multi?.getAttribute('aria-pressed') === 'true') fireEvent.click(multi)
}

const shown = (text: string) => screen.queryAllByText(text).length > 0

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

describe('Active on server: Needs attention and IDs not on disk', () => {
  it('counts an enabled ID that is not on disk and keeps listing it under Needs attention', async () => {
    prime({ '100': [{ id: 'ModA', name: 'Alpha Mod', enabled: true }] })
    const config = await m.getCurrentConfig()
    m.getCurrentConfig.mockResolvedValue({ ...(config as object), modIds: ['ModA', 'GhostMod'] } as never)
    await openActive()
    showAllItems()
    expect(shown('GhostMod')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Needs attention (1)' }))
    expect(screen.getByRole('button', { name: 'Needs attention (1)' })).toHaveAttribute('aria-pressed', 'true')
    expect(shown('GhostMod')).toBe(true)
    expect(shown('Alpha Mod')).toBe(false)
  })
})
