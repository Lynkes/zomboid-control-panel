import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Scheduler from '../Scheduler'
import { schedulerApi, serverApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'

// pz-scheduler-ux-pass (2026-09-18): the "no scheduled tasks" empty state
// (first-launch persona) told the operator what a scheduled task IS but
// gave no direct next step inside the empty state itself -- the only way to
// create the first task was the small "+ New Task" button up in the page
// header, easy to miss when the whole card below is a big empty box. The
// shared EmptyState component already supports an `action` button (used
// elsewhere in the app to open dialogs / navigate) -- this wires it up here
// so "what do I do next" is answered right where the operator is looking.

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
  getStatus.mockResolvedValue({ activeTasks: 0, autoRestartEnabled: false, modUpdateRestartPending: false })
  serversGetAll.mockResolvedValue({ servers: [] })
  serverGetStatus.mockResolvedValue({ running: false } as Awaited<ReturnType<typeof serverApi.getStatus>>)
}

describe('Scheduler.tsx: the empty "no scheduled tasks" state offers a direct way to create the first task', () => {
  it('renders a "Create scheduled task" action inside the empty state that opens the create-task dialog', async () => {
    await baseMocks()
    renderScheduler()

    await screen.findByText('No scheduled tasks')

    // Distinct label from both the page-header "New Task" button and the
    // dialog's own "Create Task" submit button -- reusing either of those
    // would make this new button indistinguishable by accessible name from
    // an existing one once the dialog is open (both stay mounted at once).
    const emptyStateButton = await screen.findByRole('button', { name: 'Create scheduled task' })
    fireEvent.click(emptyStateButton)

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    expect(screen.getByText('Create Scheduled Task')).toBeInTheDocument()
  })
})
