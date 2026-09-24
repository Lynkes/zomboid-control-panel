import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ChunkCleaner from '../ChunkCleaner'
import { chunksApi, serversApi, mapApi, ApiError } from '@/lib/api'

// pz-mapcleanup-templates-hunt-2026-09-18: fetchSaves()'s and
// persistCurrentPath()'s catch blocks built their toast description from a
// raw `error instanceof Error && error.message` fallback instead of
// getUserErrorMessage() -- the one place (two places) in this file that
// skipped it, unlike loadChunks/handleDelete which already call it
// correctly. getUserErrorMessage() checks the ApiError's `code` against the
// registered errors.json translation FIRST, before ever looking at
// `.message` -- the raw fallback used here never did that lookup at all, so
// any coded error from these two routes (POST /chunks/save-path emits
// CHUNKS_SAVE_PATH_MISSING/_EMPTY/_CAPABILITY_REQUIRED, all translated in
// every locale) always rendered whatever raw string sat in
// ApiError.message, silently bypassing the registered translation. Proven
// here by constructing an ApiError whose raw `.message` is deliberately
// UNRELATED to the code's registered text: the fixed code must show the
// registered translation regardless of what `.message` says; the buggy
// code shows the raw message verbatim.
const RAW_MESSAGE_UNRELATED_TO_CODE = 'zzz-raw-unrelated-server-text-zzz'
const REGISTERED_TRANSLATION_FOR_CODE =
  "Repointing the server's data path also requires server.configure."

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
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
    mapApi: { ...actual.mapApi, resolve: vi.fn() },
    chunksApi: {
      ...actual.chunksApi,
      getSaves: vi.fn(),
      suggestedPaths: vi.fn(),
      getChunks: vi.fn(),
      getStats: vi.fn(),
      savePath: vi.fn(),
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const mapResolve = vi.mocked(mapApi.resolve)
const getSaves = vi.mocked(chunksApi.getSaves)
const suggestedPaths = vi.mocked(chunksApi.suggestedPaths)
const getChunks = vi.mocked(chunksApi.getChunks)
const getStats = vi.mocked(chunksApi.getStats)
const savePath = vi.mocked(chunksApi.savePath)

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = () => true
})

function renderChunkCleaner() {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  getResolvedActive.mockResolvedValue({ server: null })
  suggestedPaths.mockResolvedValue({ candidates: [] })
  mapResolve.mockResolvedValue({
    root: '/tiles', b42Dir: 'test-build', b41Path: '/tiles/b41',
    tileSize: 1024, width: 1, height: 1, maxLevel: 1, renderedMaxLevel: 1,
  })
  getSaves.mockResolvedValue({
    saves: [{ name: 'Ashenwood', modified: '2026-08-20T00:00:00.000Z', chunkCount: 1, size: 1024, sizeFormatted: '1.0 KB' }],
    debug: null,
  })
  getChunks.mockResolvedValue({ chunks: [], bounds: null, isB42: false })
  getStats.mockResolvedValue({ saveName: 'Ashenwood', totalSize: 0, totalSizeFormatted: '0 B', folders: {} })
  return render(<ChunkCleaner />)
}

describe('ChunkCleaner.tsx: coded errors go through getUserErrorMessage(), not a raw error.message fallback', () => {
  it('persistCurrentPath shows the registered code translation, not the raw ApiError.message', async () => {
    renderChunkCleaner()
    await screen.findByRole('combobox')

    fireEvent.click(screen.getByText(/custom path/i))
    const input = await screen.findByLabelText(/custom.*path/i)
    fireEvent.change(input, { target: { value: '/some/custom/path' } })

    getSaves.mockResolvedValueOnce({
      saves: [{ name: 'Ashenwood', modified: '2026-08-20T00:00:00.000Z', chunkCount: 1, size: 1024, sizeFormatted: '1.0 KB' }],
      debug: null,
    })
    fireEvent.click(screen.getByText(/^load$/i))
    await waitFor(() => expect(getSaves).toHaveBeenCalledTimes(2))

    savePath.mockRejectedValue(
      new ApiError(RAW_MESSAGE_UNRELATED_TO_CODE, {
        status: 403,
        code: 'CHUNKS_SAVE_PATH_CAPABILITY_REQUIRED',
      }),
    )
    const saveDefaultButton = await screen.findByText(/save as default/i)
    fireEvent.click(saveDefaultButton)

    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    const call = toastSpy.mock.calls.find(
      (c) => c[0]?.title === 'Could Not Save Path',
    )
    expect(call).toBeTruthy()
    expect(call![0].description).toBe(REGISTERED_TRANSLATION_FOR_CODE)
    expect(call![0].description).not.toBe(RAW_MESSAGE_UNRELATED_TO_CODE)
  })
})
