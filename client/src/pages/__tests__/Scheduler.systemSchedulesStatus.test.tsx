import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Scheduler from '../Scheduler'
import { schedulerApi, serverApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'

// pz-scheduler-ux-pass (2026-09-18): server/services/scheduler.js's
// getStatus() has always returned autoRestartEnabled (whether the
// AUTO_RESTART_CRON env-configured periodic restart job is active) and
// backupScheduleEnabled (whether the automatic backup job is active) --
// both fetched into this page's own `status` state, but neither was ever
// read anywhere in the render. An operator with AUTO_RESTART_ENABLED set
// in the environment, or whose backup schedule silently stopped, had no
// way to see that from the Scheduler page itself -- even though the
// Scheduler Timezone card's own copy already claims both "run in this
// timezone". This proves both are now surfaced there.

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

async function baseMocks() {
  getTasks.mockResolvedValue({ tasks: [] })
  getCronPresets.mockResolvedValue({ presets: [] })
  getHistory.mockResolvedValue({ history: [] })
  serversGetAll.mockResolvedValue({ servers: [] })
  serverGetStatus.mockResolvedValue({ running: false } as Awaited<ReturnType<typeof serverApi.getStatus>>)
}

describe('Scheduler.tsx: the Timezone card surfaces the system auto-restart and automatic-backup schedule state', () => {
  it('shows both as active/on when the server reports them enabled', async () => {
    await baseMocks()
    getStatus.mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: true,
      backupScheduleEnabled: true,
      modUpdateRestartPending: false,
      timezone: 'UTC',
      configuredTimezone: 'UTC',
      timezoneFallback: null,
    })

    renderScheduler()

    expect(await screen.findByText(/Automatic backup: active/)).toBeInTheDocument()
    expect(screen.getByText(/Periodic auto-restart: on/)).toBeInTheDocument()
  })

  it('shows both as inactive/off when the server reports them disabled (the common default)', async () => {
    await baseMocks()
    getStatus.mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: false,
      backupScheduleEnabled: false,
      modUpdateRestartPending: false,
      timezone: 'UTC',
      configuredTimezone: 'UTC',
      timezoneFallback: null,
    })

    renderScheduler()

    expect(await screen.findByText(/Automatic backup: inactive/)).toBeInTheDocument()
    expect(screen.getByText(/Periodic auto-restart: off/)).toBeInTheDocument()
  })

  it('renders nothing for this line when the status fetch itself failed, rather than falsely claiming "off"', async () => {
    await baseMocks()
    getStatus.mockResolvedValue(null as unknown as Awaited<ReturnType<typeof schedulerApi.getStatus>>)

    renderScheduler()

    await screen.findByText('Scheduler Timezone')
    expect(screen.queryByText(/Automatic backup:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Periodic auto-restart:/)).not.toBeInTheDocument()
  })
})
