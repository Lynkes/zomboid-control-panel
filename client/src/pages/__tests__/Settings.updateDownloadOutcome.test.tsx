import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Settings from '../Settings'
import { ApiError, configApi, panelUpdateApi } from '@/lib/api'

// What the Updates card shows around a download:
// - after a failed, unretryable apply, the re-download the failure banner
//   asks for must enable "Restart and Apply" (the failure was tested before
//   the staged bundle and kept it disabled);
// - a failed download must not leave the card on "Downloading" (nothing
//   read the state back);
// - the preflight blocker and the downloaded toast are in the reader's
//   language, not the server's English.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    panelUpdateApi: {
      ...actual.panelUpdateApi,
      getStatus: vi.fn(),
      preflight: vi.fn(),
      download: vi.fn(),
    },
  }
})

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

const toastMock = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastMock, dismiss: vi.fn(), toasts: [] }),
}))

const getAppSettings = vi.mocked(configApi.getAppSettings)
const getStatus = vi.mocked(panelUpdateApi.getStatus)
const preflight = vi.mocked(panelUpdateApi.preflight)
const download = vi.mocked(panelUpdateApi.download)

const socket = { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() } as unknown as Socket

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings?tab=updates']}>
      <SocketContext.Provider value={socket}>
        <TooltipProvider>
          <Settings />
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

const okPreflight = {
  ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
  info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath: 'C:/tmp/log.txt' },
}

const baseStatus = {
  currentVersion: '1.2.14', updateAvailable: true, latestVersion: '1.2.15',
  releaseUrl: null, releaseNotes: null, publishedAt: null,
  isChecking: false, isDownloading: false, downloadProgress: 0,
  lastCheck: null, lastError: null, updateMode: 'direct' as const,
  stagedUpdate: null,
  lastApplyResult: null,
}

const failedUnretryable = {
  status: 'failed' as const, pendingVersion: '1.2.15', currentVersion: '1.2.14',
  at: new Date().toISOString(), stagedStillPresent: false,
  helperLog: 'log', likelyCause: 'av_quarantine' as const, canRetryApply: false,
  panelFolder: 'C:/panel',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings.tsx: Updates card around a download', () => {
  it('enables Restart and Apply once a bundle is staged again after a failed, unretryable apply', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    preflight.mockResolvedValue(okPreflight as never)
    // An older server still reports the failure next to the new bundle.
    getStatus.mockResolvedValue({
      ...baseStatus,
      stagedUpdate: { version: '1.2.15', path: 'C:/panel/update.new.exe' },
      lastApplyResult: failedUnretryable,
    } as never)

    renderSettings()

    const restart = await screen.findByRole('button', { name: 'Restart and Apply Update' })
    await waitFor(() => expect(restart).toBeEnabled())
  })

  it('reads the update state back after a failed download, so the card does not stay on Downloading', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    preflight.mockResolvedValue(okPreflight as never)
    getStatus.mockResolvedValue(baseStatus as never)
    download.mockRejectedValue(new ApiError('SHA256 checksum mismatch', { status: 400 } as never))

    renderSettings()
    const downloadButton = await screen.findByRole('button', { name: /download update/i })
    await waitFor(() => expect(downloadButton).toBeEnabled())
    const fetchesBefore = getStatus.mock.calls.length
    fireEvent.click(downloadButton)

    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(fetchesBefore))
  })

  it('shows a preflight blocker in the reader\'s language, not the server\'s English', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    getStatus.mockResolvedValue(baseStatus as never)
    preflight.mockResolvedValueOnce(okPreflight as never)

    renderSettings()
    const downloadButton = await screen.findByRole('button', { name: /download update/i })
    await waitFor(() => expect(downloadButton).toBeEnabled())

    preflight.mockResolvedValueOnce({
      ...okPreflight,
      ok: false,
      blockers: ['SERVER ENGLISH: disk is full'],
      blockerDetails: [{ key: 'updates.preflight.diskSpace', params: { neededMb: 200, freeMb: 10 }, message: 'SERVER ENGLISH: disk is full' }],
    } as never)
    fireEvent.click(downloadButton)

    await waitFor(() => expect(toastMock).toHaveBeenCalled())
    const description = String(toastMock.mock.calls.at(-1)![0].description)
    expect(description).toBe('Not enough free disk space. Need about 200 MB, have 10 MB.')
    expect(download).not.toHaveBeenCalled()
  })

  it('describes a finished download with the translated text, not the server\'s English message', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    preflight.mockResolvedValue(okPreflight as never)
    getStatus.mockResolvedValue(baseStatus as never)
    download.mockResolvedValue({ success: true, message: 'Update to v1.2.15 downloaded. Restart the panel to apply.' } as never)

    renderSettings()
    const downloadButton = await screen.findByRole('button', { name: /download update/i })
    await waitFor(() => expect(downloadButton).toBeEnabled())
    fireEvent.click(downloadButton)

    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        description: 'The update files are ready. Restart the panel to apply this version.',
      })),
    )
  })
})
