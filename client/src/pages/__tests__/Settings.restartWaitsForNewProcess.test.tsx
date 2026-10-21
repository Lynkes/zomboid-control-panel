import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import Settings from '../Settings'
import { configApi, panelUpdateApi, serverApi } from '@/lib/api'

// The page waiting for a panel restart judged "it's back" by any
// /api/health answer (a plain restart) or by the version (restart and
// apply). The OLD process keeps answering while it hands off -- in the
// all-in-one container for as long as it takes to save and stop the game
// servers -- so a plain restart could reload onto the process about to
// exit. And when Start.bat rolled a failed update back, the new process came
// up on the old version: the page waited for a version that never came and
// three minutes later said the panel wasn't responding, though it was.
// Each process now has a bootId; the restart answers with the one going away.

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

const socket = { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() } as unknown as Socket

function renderSettings(tab: string) {
  return render(
    <MemoryRouter initialEntries={[`/settings?tab=${tab}`]}>
      <SocketContext.Provider value={socket}>
        <TooltipProvider>
          <Settings />
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

const PAGE = 'http://192.168.1.5:3001/settings'

function stubLocation() {
  const original = window.location
  const page = new URL(PAGE)
  let navigated: string | null = null
  const fake = {
    ...original,
    protocol: page.protocol,
    host: page.host,
    hostname: page.hostname,
    port: page.port,
    origin: page.origin,
    pathname: page.pathname,
    search: page.search,
    hash: page.hash,
  }
  Object.defineProperty(fake, 'href', {
    configurable: true,
    get: () => navigated ?? page.href,
    set: (value: string) => { navigated = value },
  })
  Object.defineProperty(window, 'location', { configurable: true, value: fake })
  return {
    navigatedTo: () => navigated,
    restore: () => Object.defineProperty(window, 'location', { configurable: true, value: original }),
  }
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

// /api/health answers from `answers` in turn (the last one repeats).
function stubFetch(answers: Array<Record<string, unknown>>) {
  let healthCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/api/panel-info')) return json({ localIp: '192.168.1.5', port: 3001, url: 'x' })
    if (url.includes('/api/health')) {
      const answer = answers[Math.min(healthCalls, answers.length - 1)]
      healthCalls += 1
      return json({ status: 'ok', ...answer })
    }
    return json({})
  }))
  return { healthCalls: () => healthCalls }
}

const stagedStatus = {
  currentVersion: '1.2.15', updateAvailable: true, latestVersion: '1.2.16',
  releaseUrl: null, releaseNotes: null, publishedAt: null,
  isChecking: false, isDownloading: false, downloadProgress: 0,
  lastCheck: null, lastError: null, updateMode: 'direct' as const,
  stagedUpdate: { version: '1.2.16', path: 'C:/panel/update.new.exe' },
  lastApplyResult: null,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Settings.tsx: the restart wait follows the process, not just the version', () => {
  it('a plain restart waits out the old process still answering, and reloads only once a new one does', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const location = stubLocation()
    getAppSettings.mockResolvedValue({ settings: { panelPort: '3001' } })
    getStatus.mockResolvedValue({ ...stagedStatus, updateAvailable: false, stagedUpdate: null })
    restartPanel.mockResolvedValue({ success: true, bootId: 'boot-old' })
    // The old process answers three polls (saving and stopping game servers
    // before it exits), then the new one.
    const health = stubFetch([
      { version: '1.2.15', bootId: 'boot-old' },
      { version: '1.2.15', bootId: 'boot-old' },
      { version: '1.2.15', bootId: 'boot-old' },
      { version: '1.2.15', bootId: 'boot-new' },
    ])
    try {
      renderSettings('general')
      fireEvent.click(await screen.findByRole('button', { name: 'Restart Panel' }))
      const risk = screen.queryByRole('checkbox')
      if (risk) fireEvent.click(risk)
      const dialogButtons = await screen.findAllByRole('button', { name: 'Restart Panel' })
      fireEvent.click(dialogButtons[dialogButtons.length - 1])
      await vi.waitFor(() => expect(restartPanel).toHaveBeenCalledTimes(1))

      // First poll at 3 s, then every 2 s: three answers from the old process.
      await vi.advanceTimersByTimeAsync(3000 + 2000 * 2)
      expect(health.healthCalls()).toBeGreaterThanOrEqual(3)
      expect(location.navigatedTo()).toBeNull()

      await vi.advanceTimersByTimeAsync(2000)
      await vi.waitFor(() => expect(location.navigatedTo()).toBe(PAGE))
    } finally {
      location.restore()
    }
  })

  it('reports a rolled-back update as soon as the new process answers on the old version, instead of waiting it out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const location = stubLocation()
    getAppSettings.mockResolvedValue({ settings: { panelPort: '3001' } })
    preflight.mockResolvedValue({
      ok: true, blockers: [], warnings: [], blockerDetails: [], warningDetails: [],
      info: { isPackaged: true, platform: 'win32', updateMode: 'direct', restartAssessment: { gameServers: 'preserved', requiresConfirmation: false }, temporaryDirectory: 'C:/tmp', applyLogPath: 'C:/tmp/log.txt' },
    })
    getStatus.mockResolvedValue(stagedStatus)
    restartPanel.mockResolvedValue({ success: true, bootId: 'boot-old', applyingUpdate: true, supervisor: true })
    // Start.bat's apply failed and it restored 1.2.15.
    stubFetch([
      { version: '1.2.15', bootId: 'boot-old' },
      { version: '1.2.15', bootId: 'boot-new' },
    ])
    try {
      renderSettings('updates')
      fireEvent.click(await screen.findByRole('button', { name: 'Restart and Apply Update' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Restart and apply' }))
      await vi.waitFor(() => expect(restartPanel).toHaveBeenCalledTimes(1))
      const statusFetchesBefore = getStatus.mock.calls.length

      await vi.advanceTimersByTimeAsync(3000 + 2000 * 2)

      const alert = await screen.findByText('Update not applied')
      expect(alert).toBeInTheDocument()
      expect(screen.getByText(/running v1\.2\.15, not v1\.2\.16/)).toBeInTheDocument()
      // The Updates card fetches the failed apply's details.
      await vi.waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(statusFetchesBefore))
      expect(location.navigatedTo()).toBeNull()
      expect(screen.queryByText(/hasn't come back/i)).not.toBeInTheDocument()
    } finally {
      location.restore()
    }
  })
})
