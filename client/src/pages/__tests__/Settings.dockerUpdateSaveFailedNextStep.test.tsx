import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Settings from '../Settings'
import { ApiError, configApi, panelUpdateApi } from '@/lib/api'

// 2026-10-01 incident (Unraid all-in-one, 1.4.0 -> 1.4.1): the Docker panel
// update's pre-update world save failed every time ("RCON connection
// closed": the 42.21 server's game thread had died), and Settings > Updates
// said "Download Failed" -- nothing had been downloaded, and the toast gave
// no way forward. The refusal is now titled for what it is, keeps the
// server's message (which names Force stop and its cost), and offers the
// Dashboard, where Force stop lives. Nothing is force-stopped from here.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    serverApi: { ...actual.serverApi, forceStop: vi.fn() },
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

function createFakeSocket() {
  return { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() } as unknown as Socket
}

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings?tab=updates']}>
      <SocketContext.Provider value={createFakeSocket()}>
        <TooltipProvider>
          <Routes>
            <Route path="/settings" element={<Settings />} />
            <Route path="/" element={<div>Dashboard page</div>} />
          </Routes>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

const dockerStatus = {
  currentVersion: '1.4.0',
  updateAvailable: true,
  latestVersion: '1.4.1',
  releaseUrl: null,
  releaseNotes: null,
  publishedAt: null,
  isChecking: false,
  isDownloading: false,
  downloadProgress: 0,
  lastCheck: null,
  lastError: null,
  updateMode: 'docker' as const,
  stagedUpdate: null,
  lastApplyResult: null,
}

const preflightOk = {
  ok: true,
  blockers: [],
  warnings: [],
  blockerDetails: [],
  warningDetails: [],
  info: {
    isPackaged: false,
    platform: 'linux',
    updateMode: 'docker',
    restartAssessment: { gameServers: 'preserved', requiresConfirmation: false },
    temporaryDirectory: '/tmp',
    applyLogPath: '/tmp/log.txt',
  },
}

async function applyDockerUpdate() {
  const applyButton = await screen.findByRole('button', { name: 'Apply Docker Update' })
  await waitFor(() => expect(applyButton).toBeEnabled())
  await act(async () => {
    fireEvent.click(applyButton)
  })
  const confirm = await screen.findByRole('button', { name: 'Stop server and update' })
  await act(async () => {
    fireEvent.click(confirm)
  })
  await waitFor(() => expect(toastMock).toHaveBeenCalled())
  return toastMock.mock.calls[toastMock.mock.calls.length - 1][0] as {
    title: string
    description: string
    variant: string
    layout?: 'inline' | 'stacked'
    action?: ReactElement<{ onClick: () => void; children: string; altText: string }>
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings > Updates: a Docker update refused because the world could not be saved', () => {
  it('is titled "Update Not Applied", explains the way out, and offers the Dashboard', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    getStatus.mockResolvedValue(dockerStatus)
    preflight.mockResolvedValue(preflightOk)
    download.mockRejectedValue(
      new ApiError('raw English', {
        status: 409,
        code: 'save_failed',
        data: { code: 'save_failed', params: { reason: 'RCON connection closed' } },
      }),
    )

    renderSettings()
    const toast = await applyDockerUpdate()

    expect(download).toHaveBeenCalledWith(true)
    expect(toast.title).toBe('Update Not Applied')
    expect(toast.title).not.toBe('Download Failed')
    expect(toast.variant).toBe('destructive')
    expect(toast.description).toContain('RCON connection closed')
    expect(toast.description).toContain('Force stop on the Dashboard')
    expect(toast.action).toBeDefined()
    expect(toast.action!.props.children).toBe('Open Dashboard')
    // Review finding (2026-10-01): beside a 300-460 character message the
    // button squeezed the text into a column ~13 characters wide (uk).
    expect(toast.layout).toBe('stacked')

    // The action only navigates -- it never force-stops anything itself.
    act(() => {
      toast.action!.props.onClick()
    })
    expect(await screen.findByText('Dashboard page')).toBeInTheDocument()
    const { serverApi } = await import('@/lib/api')
    expect(vi.mocked(serverApi.forceStop)).not.toHaveBeenCalled()
  })

  it('a server that hasn\'t exited after its shutdown offers the Dashboard too', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    getStatus.mockResolvedValue(dockerStatus)
    preflight.mockResolvedValue(preflightOk)
    download.mockRejectedValue(
      new ApiError('raw English', {
        status: 503,
        code: 'SERVER_STOP_NOT_CONFIRMED',
        data: { code: 'SERVER_STOP_NOT_CONFIRMED' },
      }),
    )

    renderSettings()
    const toast = await applyDockerUpdate()

    expect(toast.title).toBe('Update Not Applied')
    expect(toast.description).toContain("still hasn't exited")
    expect(toast.description).toContain('Force stop on the Dashboard')
    expect(toast.description).not.toContain('process-detection scan')
    expect(toast.action!.props.children).toBe('Open Dashboard')
    expect(toast.layout).toBe('stacked')
  })

  it('keeps "Download Failed" (and no Dashboard action) for a real download failure', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    getStatus.mockResolvedValue(dockerStatus)
    preflight.mockResolvedValue(preflightOk)
    download.mockRejectedValue(new ApiError('Docker update controller unreachable', { status: 502, code: 'HTTP_502' }))

    renderSettings()
    const toast = await applyDockerUpdate()

    expect(toast.title).toBe('Download Failed')
    expect(toast.action).toBeUndefined()
    expect(toast.layout).toBeUndefined()
  })
})
