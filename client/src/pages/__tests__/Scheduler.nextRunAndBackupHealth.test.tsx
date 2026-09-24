import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Scheduler from '../Scheduler'
import { schedulerApi, serverApi, serversApi, backupApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'

// continuous-bug-hunt round 28 (ux-proposals-need-backend-data): a native
// server crash vs a deliberate stop already got a fix elsewhere this round
// (serverManager/index.js stopReason classification), but the UX deep pass
// (092bfac0) flagged two more gaps that needed real server data before they
// could be fixed at all: (1) a scheduled task's card never showed WHEN it
// would next fire, only when it last did; (2) the automatic backup schedule
// could silently stop succeeding with nothing on this page to notice --
// "Automatic backup: active" (Scheduler.systemSchedulesStatus.test.tsx)
// only ever said the schedule exists, never that it's actually working.
// server/routes/scheduler.js's GET /tasks now composes next_run per task
// (scheduler.getTaskNextRun, tested server-side in
// schedulerTasksNextRun.test.js) and server/routes/backup.js's GET /status
// now composes backupNextRun (tested in backupStatusNextRun.test.js) --
// this proves both reach the Scheduler page's own render.

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

describe('Scheduler.tsx: a task row shows its computed next run time', () => {
  it('shows the next_run the server composed for an enabled task', async () => {
    await baseMocks()
    getTasks.mockResolvedValue({
      tasks: [
        {
          id: 1,
          name: 'Nightly Restart',
          cron_expression: '0 3 * * *',
          command: 'restart',
          server_id: null,
          enabled: 1,
          last_run: null,
          created_at: '2026-08-01T00:00:00.000Z',
          next_run: '2026-09-19T03:00:00.000Z',
        },
      ],
    })
    getStatus.mockResolvedValue({ activeTasks: 1, autoRestartEnabled: false, backupScheduleEnabled: false, modUpdateRestartPending: false })
    backupGetStatus.mockResolvedValue(null as unknown as Awaited<ReturnType<typeof backupApi.getStatus>>)

    renderScheduler()

    await screen.findByRole('heading', { name: 'Nightly Restart', level: 3 })
    expect(screen.getByText(/Next run ·/)).toBeInTheDocument()
  })

  it('shows no next-run line when the server did not compute one (e.g. a disabled task)', async () => {
    await baseMocks()
    getTasks.mockResolvedValue({
      tasks: [
        {
          id: 2,
          name: 'World Save',
          cron_expression: '*/30 * * * *',
          command: 'save',
          server_id: null,
          enabled: 0,
          last_run: null,
          created_at: '2026-08-01T00:00:00.000Z',
          next_run: null,
        },
      ],
    })
    getStatus.mockResolvedValue({ activeTasks: 0, autoRestartEnabled: false, backupScheduleEnabled: false, modUpdateRestartPending: false })
    backupGetStatus.mockResolvedValue(null as unknown as Awaited<ReturnType<typeof backupApi.getStatus>>)

    renderScheduler()

    await screen.findByText('World Save')
    expect(screen.queryByText(/Next run ·/)).not.toBeInTheDocument()
  })
})

describe('Scheduler.tsx: the Timezone card surfaces automatic-backup schedule health', () => {
  it('shows the last scheduled attempt succeeded, and the next run time, when backups are enabled', async () => {
    await baseMocks()
    getTasks.mockResolvedValue({ tasks: [] })
    getStatus.mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: false,
      backupScheduleEnabled: true,
      backupNextRun: '2026-09-19T00:00:00.000Z',
      modUpdateRestartPending: false,
    })
    backupGetStatus.mockResolvedValue({
      lastScheduledBackupAttempt: { success: true, message: null, executedAt: '2026-09-18T00:00:00.000Z' },
    } as unknown as Awaited<ReturnType<typeof backupApi.getStatus>>)

    renderScheduler()

    expect(await screen.findByText(/Last attempt succeeded ·/)).toBeInTheDocument()
    expect(screen.getByText(/Next run ·/)).toBeInTheDocument()
  })

  it('shows the failure reason when the last scheduled attempt failed', async () => {
    await baseMocks()
    getTasks.mockResolvedValue({ tasks: [] })
    getStatus.mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: false,
      backupScheduleEnabled: true,
      backupNextRun: null,
      modUpdateRestartPending: false,
    })
    backupGetStatus.mockResolvedValue({
      lastScheduledBackupAttempt: { success: false, message: 'Disk full', executedAt: '2026-09-18T00:00:00.000Z' },
    } as unknown as Awaited<ReturnType<typeof backupApi.getStatus>>)

    renderScheduler()

    expect(await screen.findByText(/Last attempt failed ·.*Disk full/)).toBeInTheDocument()
  })

  it('renders nothing for the backup-health block when the backup schedule is off', async () => {
    await baseMocks()
    getTasks.mockResolvedValue({ tasks: [] })
    getStatus.mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: false,
      backupScheduleEnabled: false,
      modUpdateRestartPending: false,
    })
    backupGetStatus.mockResolvedValue(null as unknown as Awaited<ReturnType<typeof backupApi.getStatus>>)

    renderScheduler()

    await screen.findByText('Scheduler Timezone')
    expect(screen.queryByText(/Backup schedule health/)).not.toBeInTheDocument()
  })
})
