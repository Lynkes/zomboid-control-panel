import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ChunkCleaner from '../ChunkCleaner'
import { chunksApi, serversApi, panelBridgeApi, mapApi, ApiError } from '@/lib/api'

// handleDelete's "remove already-loaded vehicles live" step used to run BEFORE
// the delete request. removeVehiclesInArea is permanent and keeps no backup, so
// cancelling the "server appears to be running" dialog, or any refusal of the
// delete (state unknown, active server changed), left the chunks on disk and
// the cars gone. The live removal now runs only after the delete went through
// with at least one chunk deleted.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
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

const testSave = {
  name: 'Ashenwood',
  modified: '2026-08-20T00:00:00.000Z',
  chunkCount: 1,
  size: 1024,
  sizeFormatted: '1.0 KB',
}

const chunkA = { file: 'chunk_0_0.bin', x: 0, y: 0, size: 1024, modified: '2026-08-20T00:00:00.000Z' }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function setUp() {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  resolveMap.mockRejectedValue(new Error('not needed for this test'))
  getResolvedActive.mockResolvedValue({ server: null })
  getSaves.mockResolvedValue({ saves: [testSave], debug: null })
  getChunks.mockResolvedValue({ chunks: [chunkA], bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, isB42: false })
  getStats.mockResolvedValue({ saveName: 'Ashenwood', totalSize: 1024, totalSizeFormatted: '1.0 KB', folders: {} })
  sendCommand.mockImplementation((action: string) => {
    if (action === 'getVehiclesDetailed') return Promise.resolve({ success: true, data: { vehicles: [] } })
    if (action === 'getSafehouses') return Promise.resolve({ success: true, data: { safehouses: [] } })
    return Promise.resolve({ success: true, data: {} })
  })
}

async function selectAllAndDelete() {
  render(<ChunkCleaner />)
  const allButton = await screen.findByRole('button', { name: /^all$/i })
  await waitFor(() => expect(allButton).not.toBeDisabled())
  fireEvent.click(allButton)
  fireEvent.click(await screen.findByRole('button', { name: /delete 1 chunk/i }))
  fireEvent.click(await screen.findByRole('button', { name: /delete selected chunks/i }))
}

const liveRemovalCalls = () => sendCommand.mock.calls.filter(([action]) => action === 'removeVehiclesInArea')

describe('ChunkCleaner.tsx: live vehicle removal waits for the delete', () => {
  it('removes live vehicles only after the delete succeeded', async () => {
    setUp()
    deleteChunks.mockResolvedValue({ deleted: 1, vehiclesDeleted: 0, errors: [] })

    await selectAllAndDelete()

    await waitFor(() => expect(liveRemovalCalls()).toHaveLength(1))
    expect(liveRemovalCalls()[0][1]).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 })
    const removalOrder = sendCommand.mock.invocationCallOrder[
      sendCommand.mock.calls.findIndex(([action]) => action === 'removeVehiclesInArea')
    ]
    expect(deleteChunks.mock.invocationCallOrder[0]).toBeLessThan(removalOrder)
  })

  it('leaves live vehicles alone when the delete is refused', async () => {
    setUp()
    deleteChunks.mockRejectedValue(
      new ApiError("Can't verify whether the server is actually stopped", {
        status: 503,
        code: 'SERVER_STATE_UNKNOWN',
      }),
    )

    await selectAllAndDelete()

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })))
    expect(deleteChunks).toHaveBeenCalledTimes(1)
    expect(liveRemovalCalls()).toHaveLength(0)
  })

  it('leaves live vehicles alone when the active server changed under the scan', async () => {
    setUp()
    deleteChunks.mockRejectedValue(
      new ApiError('The active server changed since these chunks were scanned.', {
        status: 409,
        code: 'CHUNKS_STALE_SERVER_SCAN',
      }),
    )

    await selectAllAndDelete()

    await waitFor(() => expect(deleteChunks).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 50))
    expect(liveRemovalCalls()).toHaveLength(0)
  })

  it('leaves live vehicles alone when the "server appears to be running" dialog is cancelled', async () => {
    setUp()
    deleteChunks.mockRejectedValue(
      new ApiError('Stop the server before deleting chunks.', {
        status: 400,
        code: 'server_running',
        data: { matched: [{ pid: '123', cmd: 'java ProjectZomboid' }] },
      }),
    )

    await selectAllAndDelete()

    const dialog = await screen.findByRole('alertdialog', { name: /server appears to be running/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }))

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })),
    )
    expect(deleteChunks).toHaveBeenCalledTimes(1)
    expect(liveRemovalCalls()).toHaveLength(0)
  })

  it('removes live vehicles after the forced retry succeeds', async () => {
    setUp()
    deleteChunks
      .mockRejectedValueOnce(
        new ApiError('Stop the server before deleting chunks.', {
          status: 400,
          code: 'server_running',
          data: { matched: [] },
        }),
      )
      .mockResolvedValueOnce({ deleted: 1, vehiclesDeleted: 0, errors: [] })

    await selectAllAndDelete()

    const dialog = await screen.findByRole('alertdialog', { name: /server appears to be running/i })
    expect(liveRemovalCalls()).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: /force delete/i }))

    await waitFor(() => expect(liveRemovalCalls()).toHaveLength(1))
    expect(deleteChunks).toHaveBeenCalledTimes(2)
    expect(deleteChunks.mock.calls[1][5]).toBe(true)
  })

  it('leaves live vehicles alone when the delete removed no chunk', async () => {
    setUp()
    deleteChunks.mockResolvedValue({ deleted: 0, vehiclesDeleted: 0, errors: [] })

    await selectAllAndDelete()

    await waitFor(() => expect(deleteChunks).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(liveRemovalCalls()).toHaveLength(0)
  })
})
