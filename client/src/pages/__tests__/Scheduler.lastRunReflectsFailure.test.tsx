import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Scheduler from '../Scheduler'
import { schedulerApi, serverApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'

// pz-scheduler-ux-pass (2026-09-18): server/database/init.js's
// updateTaskLastRun() -- the thing that sets a scheduled task's own
// `last_run` column -- is only ever called from the SUCCESS branch of
// runTaskNow() (server/services/scheduler.js). A refused or failed run
// (RCON down, server already stopped, an overlapping execution) never
// touches it, so a task that has been failing repeatedly can sit in the
// Scheduled Tasks card with a stale or blank "Last run" line and nothing
// telling the operator it's broken -- exactly the "looks like nothing is
// wrong" failure mode this pass targets. Execution History rows (written
// via logScheduleExecution) ARE recorded on every outcome including
// failure and already carry the task's id -- this proves the task row now
// cross-references that already-fetched history instead of trusting the
// task's own last_run column alone.

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

describe('Scheduler.tsx: a task row reflects its most recent execution-history result, including failure', () => {
  it('shows the failure reason from Execution History next to a task whose own last_run is stale/blank', async () => {
    getTasks.mockResolvedValue({
      tasks: [
        {
          id: 1,
          name: 'Nightly Restart',
          cron_expression: '0 3 * * *',
          command: 'restart',
          server_id: null,
          enabled: 1,
          // The task's own column never advanced past its very first
          // successful run, days before its two most recent attempts
          // (both failures) even though those attempts DID fire.
          last_run: '2026-09-01T03:00:00.000Z',
          created_at: '2026-08-01T00:00:00.000Z',
        },
      ],
    })
    getCronPresets.mockResolvedValue({ presets: [] })
    getStatus.mockResolvedValue({ activeTasks: 1, autoRestartEnabled: false, modUpdateRestartPending: false })
    getHistory.mockResolvedValue({
      history: [
        {
          id: 10,
          task_id: 1,
          task_name: 'Nightly Restart',
          task_name_key: null,
          command: 'restart',
          success: 0,
          message: 'RCON connection failed',
          duration: 50,
          executed_at: '2026-09-18T03:00:00.000Z',
        },
        // An older row for the same task -- must lose to the one above.
        {
          id: 9,
          task_id: 1,
          task_name: 'Nightly Restart',
          task_name_key: null,
          command: 'restart',
          success: 1,
          message: 'Completed successfully',
          duration: 900,
          executed_at: '2026-09-17T03:00:00.000Z',
        },
      ],
    })
    serversGetAll.mockResolvedValue({ servers: [] })
    serverGetStatus.mockResolvedValue({ running: true } as Awaited<ReturnType<typeof serverApi.getStatus>>)

    renderScheduler()

    // "Nightly Restart" also appears twice more, in the Execution History
    // card's own two rows for this task -- wait on the failure text itself
    // instead, which is unique to the Scheduled Tasks row this fix touches.
    await screen.findByRole('heading', { name: 'Nightly Restart', level: 3 })

    // The failure reason from the most recent history row is surfaced,
    // not the stale success-only last_run date.
    expect(screen.getByText(/failed: RCON connection failed/)).toBeInTheDocument()
  })

  it('falls back to the plain last_run date when no history entry for that task was fetched', async () => {
    getTasks.mockResolvedValue({
      tasks: [
        {
          id: 2,
          name: 'World Save',
          cron_expression: '*/30 * * * *',
          command: 'save',
          server_id: null,
          enabled: 1,
          last_run: '2026-09-18T02:30:00.000Z',
          created_at: '2026-08-01T00:00:00.000Z',
        },
      ],
    })
    getCronPresets.mockResolvedValue({ presets: [] })
    getStatus.mockResolvedValue({ activeTasks: 1, autoRestartEnabled: false, modUpdateRestartPending: false })
    // No history at all fetched for this task (e.g. it fell outside the
    // fetch window) -- must not fabricate a success/fail verdict.
    getHistory.mockResolvedValue({ history: [] })
    serversGetAll.mockResolvedValue({ servers: [] })
    serverGetStatus.mockResolvedValue({ running: true } as Awaited<ReturnType<typeof serverApi.getStatus>>)

    renderScheduler()

    await screen.findByText('World Save')

    expect(screen.queryByText(/failed:/)).not.toBeInTheDocument()
    expect(screen.getByText(/Last run ·/)).toBeInTheDocument()
  })
})
