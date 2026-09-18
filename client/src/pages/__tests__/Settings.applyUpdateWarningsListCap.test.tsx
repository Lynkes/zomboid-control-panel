import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Settings from '../Settings'
import { configApi, panelUpdateApi } from '@/lib/api'

// bug-hunt-2026-09-18 (round 4, closing a round-3 flagged gap): the Confirm
// Apply Update AlertDialog's preflight-warnings <ul> had no cap -- a real,
// unbounded server-reported list (server/services/panelUpdateChecker.js can
// report several independent warnings: a running game server, low disk
// space, a non-writable executable, antivirus interference, ...). Round 3
// measured it fitting at 632/667 with 4 realistic warnings, but flagged it
// as a close call since nothing stops a real preflight from reporting more.
// Capped with the exact same `max-h-48 overflow-y-auto` pattern
// ConfirmContext.tsx already uses for its own optional items list, rather
// than inventing a new bound.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    panelUpdateApi: {
      ...actual.panelUpdateApi,
      getStatus: vi.fn(),
      preflight: vi.fn(),
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

const getAppSettings = vi.mocked(configApi.getAppSettings)
const getStatus = vi.mocked(panelUpdateApi.getStatus)
const preflight = vi.mocked(panelUpdateApi.preflight)

function createFakeSocket() {
  return { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() } as unknown as Socket
}

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings?tab=updates']}>
      <SocketContext.Provider value={createFakeSocket()}>
        <TooltipProvider>
          <Settings />
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings.tsx: Confirm Apply Update warnings list stays capped', () => {
  it('caps the preflight warnings list so a long, real-world warning set cannot push the dialog open', async () => {
    getAppSettings.mockResolvedValue({ settings: {} })
    getStatus.mockResolvedValue({
      currentVersion: '1.3.1', updateAvailable: true, latestVersion: '1.3.6',
      stagedUpdate: { version: '1.3.6' }, isDownloading: false, downloadProgress: 0,
      isChecking: false, lastCheck: null, lastError: null,
      lastApplyResult: null, releaseUrl: null, releaseNotes: null, publishedAt: null,
    })
    preflight.mockResolvedValue({
      ok: true, blockers: [], blockerDetails: [],
      warnings: [
        'A game server appears to be running and will be stopped before the update applies.',
        'Free disk space is low on the volume holding the panel executable.',
        'The panel executable is not writable without elevation.',
        'Antivirus real-time protection may lock the executable during replacement.',
        'A scheduled backup is due to run during the restart window.',
        'Another admin is currently signed in and will be logged out.',
      ],
      warningDetails: [],
      info: { isPackaged: true, platform: 'win32', updateMode: 'direct' },
    })

    renderSettings()

    const restartButton = await screen.findByRole('button', { name: /restart.*apply/i })
    fireEvent.click(restartButton)

    const dialog = await screen.findByRole('alertdialog')
    const warningsList = dialog.querySelector('ul')
    expect(warningsList).toBeTruthy()
    expect(warningsList!.className).toMatch(/max-h-48/)
    expect(warningsList!.className).toMatch(/overflow-y-auto/)
    // All six warnings still render (nothing was truncated/dropped) -- the
    // cap is a scroll bound, not a content limit.
    expect(warningsList!.querySelectorAll('li').length).toBe(6)
  })
})
