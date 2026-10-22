import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Mods from '../Mods'
import { modsApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import { openModsView } from './modsNav'

// "Active on server" flagged a multi-ID Workshop item as "Two variants of
// this mod are enabled and share files ... disable one" whenever two of its
// mods shared a file, including a base and its add-on (seen live on
// 2757712197 Vehicle Repair Overhaul + VehicleSalvageOverhaulB42, which
// require=s it, and on 3699104148 Spongie's Character Customisation). An
// add-on overriding its base is the point; disabling the base then showed
// "Missing required ID". True variants (Tomb's body textures) still warn.

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
    serversApi: { ...actual.serversApi, getActive: vi.fn() },
  }
})

const m = vi.mocked(modsApi)

const MAP = {
  // Vehicle Repair Overhaul: the B42 salvage add-on require=s the base.
  '2757712197': [
    { id: 'VehicleRepairOverhaul', name: 'Vehicle Repair Overhaul', enabled: true },
    { id: 'VehicleSalvageOverhaulB42', name: 'Vehicle Salvage Overhaul', enabled: true, require: ['VehicleRepairOverhaul'] },
  ],
  // Spongie's: HD needs Details, Details and Faces need SPNCC.
  '3699104148': [
    { id: 'SPNCC', name: 'Spongies Character Customisation FIX', enabled: true },
    { id: 'SPNCCDetails', name: 'Details Pack', enabled: true, require: ['SPNCC'] },
    { id: 'SPNCCDetailsHD', name: 'Details Pack HD', enabled: true, require: ['SPNCCDetails'] },
    { id: 'SPNCCFaces', name: 'Vanilla Faces Pack', enabled: true, require: ['SPNCC'] },
  ],
  // An add-on that only declares loadModAfter= its base.
  '3772269882': [
    { id: 'KnoxBuildworks', name: 'Knox Buildworks', enabled: true },
    { id: 'KnoxBuildworksVanillaExpanded', name: 'Knox Vanilla Expanded', enabled: true, loadAfter: ['KnoxBuildworks'] },
  ],
  // Real variants: alternative texture sets, neither needs the other.
  '3429790870': [
    { id: 'TombBodyTexDOLL', name: 'Textures DOLL', enabled: true },
    { id: 'TombBodyTexNUDE', name: 'Textures NUDE', enabled: true },
  ],
}

const ref = (ws: string, modId: string) => ({ workshopId: ws, modId, modName: modId })
const file = (path: string, extra: Record<string, unknown>) => ({ file: path, category: 'textures', severity: 'low', winner: null, ...extra })
const pair = (ws: string, a: string, b: string, files: ReturnType<typeof file>[]) => ({
  modA: ref(ws, a), modB: ref(ws, b), files,
  highCount: files.filter((f) => f.severity === 'high').length,
  mediumCount: 0,
  lowCount: files.filter((f) => f.severity === 'low').length,
  infoCount: files.filter((f) => f.severity === 'info').length,
})
const lua = (path: string) => file(path, { category: 'lua', severity: 'high', kind: 'lua-override', reason: 'luaFileOverride' })

const SCAN = {
  totalConflicts: 7,
  identicalSkipped: 0,
  totalPairs: 7,
  modsScanned: 10,
  missingDeps: [],
  modLoadOrder: Object.values(MAP).flat().map((x) => x.id),
  pairs: [
    pair('2757712197', 'VehicleRepairOverhaul', 'VehicleSalvageOverhaulB42', [
      file('lua/shared/translate/en/sandbox.json', { category: 'translate', severity: 'info', kind: 'translation-override', reason: 'intendedPatch', intended: true }),
      // A copy the add-on overrides, rated before the order was known.
      lua('lua/client/vro_salvage.lua'),
    ]),
    pair('3699104148', 'SPNCCDetails', 'SPNCCDetailsHD', [file('textures/body/details01.png', { kind: 'file-override', reason: 'assetOverride' })]),
    pair('3699104148', 'SPNCC', 'SPNCCDetailsHD', [lua('lua/shared/spncc_registry.lua')]),
    pair('3699104148', 'SPNCCDetails', 'SPNCCFaces', [file('lua/shared/translate/en/mod.json', { category: 'translate', kind: 'translation-override', reason: 'translationKeyOverride' })]),
    pair('3772269882', 'KnoxBuildworks', 'KnoxBuildworksVanillaExpanded', [lua('lua/client/knox_menu.lua')]),
    pair('3429790870', 'TombBodyTexDOLL', 'TombBodyTexNUDE', [file('textures/body/femalebody01.png', { kind: 'file-override', reason: 'assetOverride' })]),
  ],
}

function prime() {
  const ids = Object.values(MAP).flat()
  m.getTrackedMods.mockResolvedValue({ mods: [] } as never)
  m.getStatus.mockResolvedValue({ totalModsTracked: ids.length, workshopAcfConfigured: false, autoRestartEnabled: false } as never)
  m.getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds: ids.map((i) => i.id),
    workshopIds: Object.keys(MAP),
    maps: [],
    totalMods: ids.length,
    workshopModMap: MAP,
  } as never)
  m.getIgnoredMods.mockResolvedValue([] as never)
  m.getIgnoredModPairs.mockResolvedValue([] as never)
  m.collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  m.getPresets.mockResolvedValue([] as never)
  m.getCachedConflicts.mockResolvedValue(SCAN as never)
  m.listDiskOnly.mockResolvedValue({ mods: [] } as never)
  vi.mocked(serversApi.getActive).mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as never)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

const CLASH = 'Two variants of this mod are enabled and share files. One will overwrite the other — disable one.'

describe('Active on server: a base and its add-on are not variants', () => {
  it('warns only for the true variants, never for require= / loadModAfter= add-ons or translation-only overlaps', async () => {
    prime()
    render(<MemoryRouter><TooltipProvider><Mods /></TooltipProvider></MemoryRouter>)
    await waitFor(() => expect(m.getCachedConflicts).toHaveBeenCalled())
    await openModsView('Active on server')
    // Every row renders from the same scan, so once one warning shows all do.
    await screen.findAllByText(CLASH)
    expect(screen.getAllByText(CLASH)).toHaveLength(1)
  })
})
