import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Mods from '../Mods'
import { modsApi, serverApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import errorsEn from '../../locales/en/errors.json'

// bug-hunt-2026-09-18 (round 14, raw result.error sweep): handleCheckUpdates'
// `else if (result?.error)` branch used to show modChecker.js's
// checkForUpdates() result.error as raw, untranslated text
// (`String(result.error)`) regardless of whether a `code` was attached --
// today that branch is only ever reached by an uncoded catch-all (the
// ACF_NOT_FOUND case is filtered out by the branch above it), but nothing
// server-side prevents a future code being added to that catch, and
// getUserErrorMessage() is byte-identical to the old behavior when no code
// resolves. This proves both halves: a coded failure translates, an uncoded
// one is unchanged.

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
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
      checkUpdates: vi.fn(),
    },
    serversApi: {
      ...actual.serversApi,
      getActive: vi.fn(),
    },
    serverApi: {
      ...actual.serverApi,
      listDirectory: vi.fn(),
    },
  }
})

const getTrackedMods = vi.mocked(modsApi.getTrackedMods)
const getStatus = vi.mocked(modsApi.getStatus)
const getCurrentConfig = vi.mocked(modsApi.getCurrentConfig)
const getIgnoredMods = vi.mocked(modsApi.getIgnoredMods)
const getIgnoredModPairs = vi.mocked(modsApi.getIgnoredModPairs)
const collectionDiff = vi.mocked(modsApi.collectionDiff)
const getPresets = vi.mocked(modsApi.getPresets)
const getCachedConflicts = vi.mocked(modsApi.getCachedConflicts)
const listDiskOnly = vi.mocked(modsApi.listDiskOnly)
const getActive = vi.mocked(serversApi.getActive)
const checkUpdates = vi.mocked(modsApi.checkUpdates)

function renderMods() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Mods />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function waitForLoaded() {
  await waitFor(() => expect(getTrackedMods).toHaveBeenCalled())
}

function setUpCommon() {
  getTrackedMods.mockResolvedValue({ mods: [] } as any)
  getStatus.mockResolvedValue({
    totalModsTracked: 1,
    workshopAcfConfigured: true,
    autoRestartEnabled: false,
    pendingRestart: false,
  } as any)
  getCurrentConfig.mockResolvedValue({
    configured: true,
    modIds: [],
    workshopIds: [],
    maps: [],
    totalMods: 0,
  } as any)
  getIgnoredMods.mockResolvedValue([] as any)
  getIgnoredModPairs.mockResolvedValue([] as any)
  collectionDiff.mockResolvedValue({ ok: true, collectionId: null, toAdd: [], toRemove: [], autoSync: false } as any)
  getPresets.mockResolvedValue([] as any)
  getCachedConflicts.mockResolvedValue(null as any)
  listDiskOnly.mockResolvedValue({ mods: [] } as any)
  getActive.mockResolvedValue({ server: { id: 1, installPath: 'C:\\server', isRemote: false } } as any)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Mods.tsx: Check Updates translates a coded failure instead of showing its raw prose', () => {
  it('shows the translated locale string when checkForUpdates() returns a registered code', async () => {
    setUpCommon()
    // Stand-in for "a code gets added to the catch-all later" -- any
    // registered, static-text errors.json key works to prove the wiring.
    // MODS_START_ACF_PATH_NOT_SET is unrelated to this call path in
    // production; it's only borrowed here for its stable, param-free text.
    checkUpdates.mockResolvedValue({
      updated: false,
      mods: [],
      error: 'boom: something the operator never sees translated today',
      code: 'MODS_START_ACF_PATH_NOT_SET',
    } as any)

    renderMods()
    await waitForLoaded()

    const checkButton = await screen.findByRole('button', { name: /scan for updates/i })
    fireEvent.click(checkButton)

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          description: errorsEn.MODS_START_ACF_PATH_NOT_SET,
          variant: 'destructive',
        }),
      ),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: 'boom: something the operator never sees translated today' }),
    )
  })

  it('still shows the raw message unchanged when checkForUpdates() returns no code (the real uncoded catch-all shape today)', async () => {
    setUpCommon()
    checkUpdates.mockResolvedValue({
      updated: false,
      mods: [],
      error: 'ENOENT: no such file or directory',
      source: 'error',
    } as any)

    renderMods()
    await waitForLoaded()

    const checkButton = await screen.findByRole('button', { name: /scan for updates/i })
    fireEvent.click(checkButton)

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'ENOENT: no such file or directory',
          variant: 'destructive',
        }),
      ),
    )
  })
})
