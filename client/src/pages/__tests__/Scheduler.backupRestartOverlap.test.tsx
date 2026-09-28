import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Scheduler from '../Scheduler'
import { schedulerApi, serverApi, serversApi, backupApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'

// 2026-09-27 Discord report: a restart task and the backup schedule both
// firing every 4 hours on the hour made every scheduled backup a "Skipped: a
// restart was in progress" failure. The Scheduler page -- where restarts get
// scheduled -- now says when the backup schedule lands inside a scheduled
// restart (GET /backup/status's restartOverlaps), and shows an old restart
// skip as a skip rather than a red failure.

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

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    schedulerApi: {
      ...actual.schedulerApi,
      getTasks: vi.fn(),
      getCronPresets: vi.fn(),
      getStatus: vi.fn(),
      getHistory: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    serverApi: { ...actual.serverApi, getStatus: vi.fn() },
    backupApi: { ...actual.backupApi, getStatus: vi.fn() },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const getTasks = vi.mocked(schedulerApi.getTasks)
const getCronPresets = vi.mocked(schedulerApi.getCronPresets)
const getStatus = vi.mocked(schedulerApi.getStatus)
const getHistory = vi.mocked(schedulerApi.getHistory)
const serversGetAll = vi.mocked(serversApi.getAll)
const serverGetStatus = vi.mocked(serverApi.getStatus)
const backupGetStatus = vi.mocked(backupApi.getStatus)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderScheduler() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Scheduler />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function baseMocks() {
  getCronPresets.mockResolvedValue({ presets: [] })
  getHistory.mockResolvedValue({ history: [] })
  serversGetAll.mockResolvedValue({ servers: [] })
  serverGetStatus.mockResolvedValue({ running: false } as Awaited<ReturnType<typeof serverApi.getStatus>>)
}

function enabledBackupStatus() {
  getStatus.mockResolvedValue({
    activeTasks: 1,
    autoRestartEnabled: false,
    backupScheduleEnabled: true,
    backupNextRun: null,
    modUpdateRestartPending: false,
  })
}

describe('Scheduler.tsx: the backup-health block explains restart interactions', () => {
  it('warns when the backup schedule lands inside a scheduled restart', async () => {
    await baseMocks()
    getTasks.mockResolvedValue({ tasks: [] })
    enabledBackupStatus()
    backupGetStatus.mockResolvedValue({
      lastScheduledBackupAttempt: { success: true, message: 'Created: a.zip', executedAt: '2026-09-27T08:05:00.000Z' },
      restartOverlaps: [
        { kind: 'task', name: 'Restart every 4h', cron: '0 */4 * * *', restartTime: '00:00', backupTime: '00:00' },
      ],
    } as unknown as Awaited<ReturnType<typeof backupApi.getStatus>>)

    renderScheduler()

    expect(await screen.findByText('Backups overlap a scheduled restart')).toBeInTheDocument()
    expect(screen.getByText('Backups due at 00:00 fall inside the scheduled restart "Restart every 4h" (00:00).')).toBeInTheDocument()
  })

  it('shows an old restart skip as a skip, not "Last attempt failed"', async () => {
    await baseMocks()
    getTasks.mockResolvedValue({ tasks: [] })
    enabledBackupStatus()
    backupGetStatus.mockResolvedValue({
      lastScheduledBackupAttempt: {
        success: false, message: 'Skipped: a restart was in progress', executedAt: '2026-09-27T04:00:00.000Z', skipReason: 'restart',
      },
      restartOverlaps: [],
    } as unknown as Awaited<ReturnType<typeof backupApi.getStatus>>)

    renderScheduler()

    expect(await screen.findByText(/Last attempt skipped for a restart ·/)).toBeInTheDocument()
    expect(screen.queryByText(/Last attempt failed/)).not.toBeInTheDocument()
    expect(screen.queryByText('Backups overlap a scheduled restart')).not.toBeInTheDocument()
  })
})
