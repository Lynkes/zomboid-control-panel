import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { ApiError, configApi, panelUpdateApi, panelBridgeApi, serverApi, serversApi } from '@/lib/api'

// #193 follow-up: "Trust new host key" used to forget the pin and let the
// next connection pin whatever key it saw, without ever showing the
// operator a fingerprint to check. The refusal now carries both
// fingerprints, /panel-bridge/status lists every refused host (so the
// warning shows whoever connected -- bridge, Files, log viewer -- and with
// the Remote connection section still collapsed), and Trust sends back
// exactly the key that was shown.

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

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), getCorsDiagnostics: vi.fn() },
    serverApi: { ...actual.serverApi, getNetworkInterfaces: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn(), preflight: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      trustSftpHostKey: vi.fn(),
      testSftp: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
  }
})

const getBridgeStatus = vi.mocked(panelBridgeApi.getStatus)
const trustSftpHostKey = vi.mocked(panelBridgeApi.trustSftpHostKey)
const testSftp = vi.mocked(panelBridgeApi.testSftp)

const PINNED = 'SHA256:+Vb3Pj0R2lqsXyIhG0NTX1ICLXR8hYH9kq0gmHtcoUk'
const PRESENTED = 'SHA256:qFJ4wQ6zG1Yq3rQcZ5m0Z0FzW5mH2h3V2l0nYv8Ue2k'
const REFUSAL = {
  host: 'pz.example.net',
  port: 2222,
  pinned: PINNED,
  presented: PRESENTED,
  reason: 'mismatch' as const,
  firstSeenAt: '2026-10-04T20:00:00.000Z',
  lastSeenAt: '2026-10-04T20:01:00.000Z',
  attempts: 9,
}

function primeMocks(hostKeyRefusals: unknown[]) {
  vi.mocked(configApi.getAppSettings).mockResolvedValue({
    settings: {
      panelPort: 8080, httpsEnabled: false, httpsPort: 8443, corsAllowedOrigins: '',
      autoReconnect: false, autoStartServer: false,
      panelBridgeSftpHost: 'pz.example.net', panelBridgeSftpPort: '2222',
      panelBridgeSftpUsername: 'pz', panelBridgeSftpPassword: '••••',
      panelBridgeSftpBridgePath: '', panelBridgeSftpPollIntervalSeconds: '5',
    },
  } as never)
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({
    currentVersion: '1.0.0', updateAvailable: false, latestVersion: null,
    releaseUrl: null, releaseNotes: null, publishedAt: null, isChecking: false,
    isDownloading: false, downloadProgress: 0, lastCheck: null, lastError: null,
    updateMode: 'direct', stagedUpdate: null, lastApplyResult: null,
  } as never)
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [] } as never)
  vi.mocked(configApi.getCorsDiagnostics).mockResolvedValue({ diagnostics: null } as never)
  vi.mocked(serverApi.getNetworkInterfaces).mockResolvedValue({ interfaces: [] } as never)
  getBridgeStatus.mockResolvedValue({
    isRunning: false, modConnected: false, bridgePath: null, connection: null,
    // Bridge not running: no transport error to key the warning off.
    hostKeyRefusals,
  } as never)
}

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings?tab=bridge']}>
      <TooltipProvider>
        <Settings />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = () => true
})

describe('Settings.tsx: SFTP host-key refusal', () => {
  it('shows both fingerprints from the status poll, with the Remote connection section collapsed', async () => {
    primeMocks([REFUSAL])
    renderSettings()

    const warning = (await screen.findByText(/presented a different host key/i)).closest('#sftp-host-key')
    expect(warning).not.toBeNull()
    const scope = within(warning as HTMLElement)
    expect(scope.getByText('pz.example.net:2222')).toBeInTheDocument()
    expect(scope.getByText(PINNED)).toBeInTheDocument()
    expect(scope.getByText(PRESENTED)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /remote connection/i })).toHaveAttribute('aria-expanded', 'false')
  })

  it('trusts exactly the presented fingerprint and refreshes the status', async () => {
    primeMocks([REFUSAL])
    trustSftpHostKey.mockResolvedValue({
      success: true, host: 'pz.example.net', port: 2222, fingerprint: PRESENTED, previous: PINNED,
    })
    renderSettings()

    const trust = await screen.findByRole('button', { name: 'Trust new host key' })
    getBridgeStatus.mockClear()
    fireEvent.click(trust)

    await waitFor(() =>
      expect(trustSftpHostKey).toHaveBeenCalledWith({ host: 'pz.example.net', port: 2222, fingerprint: PRESENTED }),
    )
    await waitFor(() => expect(getBridgeStatus).toHaveBeenCalled())
    // No follow-up connection that could pin some other key.
    expect(testSftp).not.toHaveBeenCalled()
  })

  it('shows the refusal a Verify returned before the status poll has it', async () => {
    primeMocks([])
    testSftp.mockRejectedValue(
      new ApiError('Host denied (verification failed)', {
        status: 400,
        code: 'SFTP_HOST_KEY_MISMATCH',
        data: {
          error: 'Host denied (verification failed)',
          code: 'SFTP_HOST_KEY_MISMATCH',
          params: { detail: 'Host denied (verification failed)' },
          hostKey: REFUSAL,
        },
      }),
    )
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: /remote connection/i }))
    fireEvent.click(await screen.findByRole('button', { name: /verify and prepare sftp/i }))

    expect(await screen.findByText(PRESENTED)).toBeInTheDocument()
    expect(screen.getByText(PINNED)).toBeInTheDocument()
  })

  it('keeps Trust disabled without bridge.setup', async () => {
    mockCan = (cap) => cap !== 'bridge.setup'
    primeMocks([REFUSAL])
    renderSettings()

    const trust = await screen.findByRole('button', { name: 'Trust new host key' })
    expect(trust).toBeDisabled()
    fireEvent.click(trust)
    await new Promise((r) => setTimeout(r, 0))
    expect(trustSftpHostKey).not.toHaveBeenCalled()
  })
})
