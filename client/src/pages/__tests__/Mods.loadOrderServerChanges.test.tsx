import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Mods from '../Mods'
import { modsApi, serversApi } from '@/lib/api'
import type { ConflictScanResult } from '@/types'

// Unsaved Load order moves against the server's Mods= changing underneath:
// - every reload of the page's data (update check and restart events, a mod
//   removed, a dependency added) replaced the list with the server's, so the
//   unsaved moves were gone without a word;
// - Save wrote the list as it was on screen, undoing mods another admin (or
//   tab) had enabled or disabled since the page loaded;
// - "Make X win" saved from the saved order, writing over unsaved moves;
// - an Auto-sort proposal and the conflict scan outlived a switch of the
//   active server: applied and saved, the proposal wrote the old server's
//   whole Mods= into the new one.

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
      saveModOrder: vi.fn(),
      planLoadOrder: vi.fn(),
      getGroups: vi.fn(),
      getGroupsStatus: vi.fn(),
      getNotes: vi.fn(),
      getGroupSuggestions: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getActive: vi.fn() },
  }
})

const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: () => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: () => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))
function emit(event: string) {
  socketHandlers.get(event)?.forEach((h) => h())
}

Element.prototype.scrollIntoView = vi.fn()

const m = vi.mocked(modsApi)
const getActive = vi.mocked(serversApi.getActive)

const config = (modIds: string[], extra: Record<string, unknown> = {}) => ({
  configured: true,
  modIds,
  workshopIds: [],
  maps: [],
  totalMods: modIds.length,
  ...extra,
})

function prime(modIds = ['modA', 'modB'], extra: Record<string, unknown> = {}) {
  m.getTrackedMods.mockResolvedValue({ mods: [] } as never)
  m.getStatus.mockResolvedValue({ totalModsTracked: 2, workshopAcfConfigured: false, autoRestartEnabled: false } as never)
  m.getCurrentConfig.mockResolvedValue(config(modIds, extra) as never)
  m.getIgnoredMods.mockResolvedValue([] as never)
  m.getIgnoredModPairs.mockResolvedValue([] as never)
  m.collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as never)
  m.getPresets.mockResolvedValue([] as never)
  m.getCachedConflicts.mockResolvedValue(null as never)
  m.listDiskOnly.mockResolvedValue({ mods: [] } as never)
  m.saveModOrder.mockResolvedValue({ message: 'ok', modCount: modIds.length, groupsAdjusted: [], groupConflicts: [] } as never)
  m.getGroups.mockResolvedValue({ groups: [], enforce: false } as never)
  m.getGroupsStatus.mockResolvedValue({ groups: [], inOrder: true, conflicts: [] } as never)
  m.getNotes.mockResolvedValue({ notes: {} } as never)
  m.getGroupSuggestions.mockResolvedValue({ suggestions: [] } as never)
  getActive.mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as never)
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  socketHandlers.clear()
})

function renderMods() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

const rowOrder = () =>
  Array.from(document.querySelectorAll('[data-load-order-index] .font-mono')).map((el) => el.textContent)

async function openLoadOrderAndMoveModADown() {
  await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
  fireEvent.click(await screen.findByRole('button', { name: /load order/i }))
  fireEvent.click(await screen.findByRole('button', { name: 'Move modA down' }))
  await waitFor(() => expect(rowOrder()).toEqual(['modB', 'modA']))
}

describe('Mods.tsx: unsaved Load order moves and the server changing Mods=', () => {
  it('keeps unsaved moves when an update-check event reloads the page', async () => {
    prime()
    renderMods()
    await openLoadOrderAndMoveModADown()

    act(() => { emit('mods:updates_available') })
    await waitFor(() => expect(m.getCurrentConfig).toHaveBeenCalledTimes(2))

    await waitFor(() => expect(rowOrder()).toEqual(['modB', 'modA']))
    expect(screen.getByRole('button', { name: /save order/i })).not.toBeDisabled()
  })

  it('merges a mod enabled elsewhere into the unsaved order on a reload', async () => {
    prime()
    renderMods()
    await openLoadOrderAndMoveModADown()

    m.getCurrentConfig.mockResolvedValue(config(['modA', 'modB', 'modC']) as never)
    act(() => { emit('mods:restart_complete') })

    await waitFor(() => expect(rowOrder()).toEqual(['modB', 'modA', 'modC']))
  })

  it('does not save over mods enabled elsewhere since the page loaded; merges them and saves on the next try', async () => {
    prime()
    renderMods()
    await openLoadOrderAndMoveModADown()

    // Another admin enabled modC meanwhile; the page has not reloaded.
    m.getCurrentConfig.mockResolvedValue(config(['modA', 'modB', 'modC']) as never)
    fireEvent.click(screen.getByRole('button', { name: /save order/i }))

    await waitFor(() => expect(rowOrder()).toEqual(['modB', 'modA', 'modC']))
    expect(m.saveModOrder).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /save order/i }))
    await waitFor(() => expect(m.saveModOrder).toHaveBeenCalledWith(['modB', 'modA', 'modC']))
  })

  it('takes the order the server wrote after a save', async () => {
    prime()
    renderMods()
    await openLoadOrderAndMoveModADown()

    // The save goes through; the server kept a group's order (modA first).
    m.getCurrentConfig
      .mockResolvedValueOnce(config(['modA', 'modB']) as never)
      .mockResolvedValue(config(['modA', 'modB']) as never)
    m.saveModOrder.mockResolvedValue({ message: 'ok', modCount: 2, groupsAdjusted: ['modA'], groupConflicts: [] } as never)
    fireEvent.click(screen.getByRole('button', { name: /save order/i }))

    await waitFor(() => expect(m.saveModOrder).toHaveBeenCalledWith(['modB', 'modA']))
    await waitFor(() => expect(rowOrder()).toEqual(['modA', 'modB']))
    await waitFor(() => expect(screen.queryByRole('button', { name: /save order/i })).toBeNull())
  })
})

describe('Mods.tsx: a switch of the active server', () => {
  it('closes an open Auto-sort proposal, so the old server\'s order cannot be applied and saved', async () => {
    // modB requires modA but loads first: Auto-sort proposes a move.
    prime(['modB', 'modA'], {
      workshopIds: ['111'],
      workshopModMap: {
        '111': [
          { id: 'modA', name: 'Mod A', enabled: true },
          { id: 'modB', name: 'Mod B', enabled: true, require: ['modA'] },
        ],
      },
    })
    renderMods()
    await waitFor(() => expect(m.getTrackedMods).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: /load order/i }))
    // The server's planner answers with modA first.
    m.planLoadOrder.mockResolvedValue({
      order: ['modA', 'modB'], changed: true,
      moves: [{ modId: 'modA', from: 1, to: 0, confidence: 'high', reasons: [{ code: 'require', params: { relation: 'before', other: 'modB' } }] }],
      explanations: {}, satisfied: 1, unsatisfied: [], cycles: [], winnersChanged: [], implicit: [], warnings: [],
      stats: { constraints: 1, hard: 1, strong: 0, soft: 0, ms: 1 },
      steamStatus: { source: 'none', fetchedAt: null, stale: false, failed: false, pending: false, known: 0, total: 0 },
    } as never)
    fireEvent.click(await screen.findByRole('button', { name: /auto-sort/i }))
    expect(await screen.findByRole('button', { name: /^apply$/i })).toBeInTheDocument()

    m.getCurrentConfig.mockResolvedValue(config(['other1', 'other2']) as never)
    act(() => { emit('activeServerChanged') })

    await waitFor(() => expect(screen.queryByRole('button', { name: /^apply$/i })).toBeNull())
    await waitFor(() => expect(rowOrder()).toEqual(['other1', 'other2']))
  })

  it('drops the old server\'s conflict scan', async () => {
    const scan: ConflictScanResult = {
      totalConflicts: 1,
      identicalSkipped: 0,
      pairs: [
        {
          modA: { workshopId: 'ws1', modId: 'modA', modName: 'Mod Alpha' },
          modB: { workshopId: 'ws2', modId: 'modB', modName: 'Mod Beta' },
          files: [{ file: 'lua/shared/Conflict.lua', category: 'lua', severity: 'high' }],
          highCount: 1,
          mediumCount: 0,
          lowCount: 0,
        },
      ],
      totalPairs: 1,
      modsScanned: 2,
      missingDeps: [],
      steamDeps: [],
      modLoadOrder: ['modA', 'modB'],
    }
    prime()
    m.getCachedConflicts.mockResolvedValue(scan as never)
    renderMods()
    await waitFor(() => expect(m.getCachedConflicts).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: /^conflicts/i }))
    expect((await screen.findAllByText('Mod Alpha')).length).toBeGreaterThan(0)

    act(() => { emit('activeServerChanged') })

    await waitFor(() => expect(screen.queryAllByText('Mod Alpha')).toHaveLength(0))
    expect(screen.getByText('Ready to scan your mods')).toBeInTheDocument()
  })
})
