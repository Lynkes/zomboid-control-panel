import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Settings from '../Settings'
import { configApi, panelUpdateApi, serverApi } from '@/lib/api'

// 2026-09 dialog sweep: the "Restart and Apply Update" confirm scrolled as a
// whole, so with preflight warnings (their list a second scroller inside) a
// landscape phone had Restart/Cancel below the fold; and the helper-log path
// -- long and unbroken when the panel lives on the Desktop -- widened it past
// a phone screen, cutting the risk checkbox's label. The description now
// scrolls in one AlertDialogBody under the pinned title and buttons, and the
// path breaks anywhere. Measured in Chromium; jsdom does no layout.

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
    serverApi: { ...actual.serverApi, restartPanel: vi.fn() },
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
const restartPanel = vi.mocked(serverApi.restartPanel)

function createFakeSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const socket = {
    connected: true,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler)
    }),
    emit: vi.fn(),
  }
  return { socket: socket as unknown as Socket }
}

function renderSettings(socket: Socket) {
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Settings.tsx: the apply-update confirm fits a short window', () => {
  it('scrolls the description in one body, keeps Restart/Cancel out of it, and breaks the log path', async () => {
    const applyLogPath = 'C:/Users/Administrator/Desktop/ZomboidControlPanel/logs/panel-update-last.log'
    getAppSettings.mockResolvedValue({ settings: { panelPort: '3001' } })
    preflight.mockResolvedValue({
      ok: true, blockers: [], blockerDetails: [], warningDetails: [],
      warnings: ['The panel folder looks like it is synced by OneDrive.', 'A previous backup folder already exists.'],
      info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath },
    } as unknown as Awaited<ReturnType<typeof panelUpdateApi.preflight>>)
    getStatus.mockResolvedValue({
      currentVersion: '1.2.15', updateAvailable: true, latestVersion: '1.2.16',
      releaseUrl: null, releaseNotes: null, publishedAt: null,
      isChecking: false, isDownloading: false, downloadProgress: 0,
      lastCheck: null, lastError: null, updateMode: 'direct',
      stagedUpdate: { version: '1.2.16', path: 'C:/panel/update.new.exe' },
      lastApplyResult: null,
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })))

    const { socket } = createFakeSocket()
    renderSettings(socket)
    ;(await screen.findByRole('button', { name: 'Restart and Apply Update' })).click()

    const dialog = await screen.findByRole('alertdialog')
    const body = dialog.querySelector<HTMLElement>(':scope > [data-dialog-body]')
    expect(body).not.toBeNull()
    for (const name of ['Restart and apply', 'Cancel']) {
      expect(body!.contains(within(dialog).getByRole('button', { name }))).toBe(false)
    }
    expect(body!.contains(within(dialog).getByRole('heading'))).toBe(false)

    const warnings = await within(body!).findByText('A previous backup folder already exists.')
    // One scroller: the warnings list flows in the body.
    expect(warnings.closest('ul')!.className).not.toMatch(/max-h-|overflow-y-auto/)
    const code = within(body!).getByText(applyLogPath)
    expect(code.tagName).toBe('CODE')
    expect(code.className).toContain('break-all')
  })
})
