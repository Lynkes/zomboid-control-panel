import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ChunkCleaner from '../ChunkCleaner'
import { chunksApi, serversApi, panelBridgeApi, mapApi } from '@/lib/api'

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
  }),
}))

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn() },
    chunksApi: {
      ...actual.chunksApi,
      getSaves: vi.fn(),
      getChunks: vi.fn(),
      getStats: vi.fn(),
      deleteChunks: vi.fn(),
    },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      sendCommand: vi.fn(),
    },
    // Mounts unconditionally (ChunkCleaner.tsx's b42DirRef effect) and, left
    // real, hits fetchWithRetry's actual backoff schedule against a
    // nonexistent server in jsdom -- harmless in isolation but slow enough
    // (multiple real retries) to occasionally blow past this test's own
    // waitFor/assertions. Reject it instantly instead.
    mapApi: { ...actual.mapApi, resolve: vi.fn() },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getSaves = vi.mocked(chunksApi.getSaves)
const getChunks = vi.mocked(chunksApi.getChunks)
const getStats = vi.mocked(chunksApi.getStats)
const deleteChunks = vi.mocked(chunksApi.deleteChunks)
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)
const resolveMap = vi.mocked(mapApi.resolve)

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const SAFEHOUSES = ['Kate', 'Rick', 'Shaun', 'Negan', 'Daryl', 'Michonne', 'Carol'].map((owner, i) => ({
  id: String(i), title: `${owner}'s place`, owner, x: 0, y: 0, w: 10, h: 10,
}))

const testSave = {
  name: 'Ashenwood',
  modified: '2026-08-20T00:00:00.000Z',
  chunkCount: 2,
  size: 2048,
  sizeFormatted: '2.0 KB',
}

// Same row (y=0), nine chunks apart -- nothing selected in x=1..9. A B41
// save (tilesPerChunk=10), so the OLD single-bounding-box bug would have
// swept live vehicles from game-tiles x=10..100, y=0..10 -- chunks 1-9,
// none of which are selected or being deleted.
const chunkA = { file: 'chunk_0_0.bin', x: 0, y: 0, size: 1024, modified: '2026-08-20T00:00:00.000Z' }
const chunkB = { file: 'chunk_10_0.bin', x: 10, y: 0, size: 1024, modified: '2026-08-20T00:00:00.000Z' }

const testStats = {
  saveName: 'Ashenwood',
  totalSize: 2048,
  totalSizeFormatted: '2.0 KB',
  folders: {},
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderChunkCleaner() {
  return render(<ChunkCleaner />)
}

function setUp() {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  resolveMap.mockRejectedValue(new Error('not needed for this test'))
  getResolvedActive.mockResolvedValue({ server: null })
  getSaves.mockResolvedValue({ saves: [testSave], debug: null })
  getChunks.mockResolvedValue({ chunks: [chunkA, chunkB], bounds: { minX: 0, maxX: 10, minY: 0, maxY: 0 }, isB42: false })
  getStats.mockResolvedValue(testStats)
  deleteChunks.mockResolvedValue({ deleted: 2, vehiclesDeleted: 0, errors: [] })
  sendCommand.mockImplementation((action: string) => {
    if (action === 'getVehiclesDetailed') return Promise.resolve({ success: true, data: { vehicles: [] } })
    if (action === 'getSafehouses') return Promise.resolve({ success: true, data: { safehouses: SAFEHOUSES } })
    if (action === 'removeVehiclesInArea') return Promise.resolve({ success: true, data: {} })
    return Promise.resolve({ success: true, data: {} })
  })
}

async function mountWithBothSelected() {
  renderChunkCleaner()
  const allButton = await screen.findByRole('button', { name: /^all$/i })
  await waitFor(() => expect(allButton).not.toBeDisabled())
  fireEvent.click(allButton)
}

// 2026-09 dialog sweep: the Map Cleanup delete confirm scrolled as a whole,
// so on a landscape phone "Delete selected chunks" started below the fold;
// and its overlapping-safehouse line was `truncate`, which in the confirm's
// old auto-width grid never truncated -- a few owners widened the dialog
// and pushed the switches and the delete button off its edge. Measured in
// Chromium; jsdom does no layout, so this pins the structure.
describe('ChunkCleaner.tsx: the delete confirm fits a short window', () => {
  it('scrolls the backup, vehicle and safehouse rows in a body; Cancel and Delete stay put', async () => {
    mockCan = () => true
    setUp()
    await mountWithBothSelected()
    fireEvent.click(await screen.findByRole('button', { name: /delete 2 chunks/i }))
    const dialog = await screen.findByRole('alertdialog')

    const body = dialog.querySelector<HTMLElement>(':scope > [data-dialog-body]')
    expect(body).not.toBeNull()
    for (const name of [/delete selected chunks/i, /^cancel$/i]) {
      expect(body!.contains(within(dialog).getByRole('button', { name }))).toBe(false)
    }
    expect(body!.contains(within(dialog).getAllByRole('switch')[0])).toBe(true)
  })

  it('wraps the overlapping safehouse owners instead of a truncate line that widened the dialog', async () => {
    mockCan = () => true
    setUp()
    await mountWithBothSelected()
    fireEvent.click(await screen.findByRole('button', { name: /delete 2 chunks/i }))
    const dialog = await screen.findByRole('alertdialog')
    const owners = await within(dialog).findByText(/Kate, Rick, Shaun, Negan, Daryl/)
    expect(owners.className).not.toContain('truncate')
    expect(owners.className).toContain('[overflow-wrap:anywhere]')
  })
})
