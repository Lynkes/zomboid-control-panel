import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Scheduler from '../Scheduler'
import { backupApi, schedulerApi, serverApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { UnsavedChangesProvider } from '@/contexts/UnsavedChangesContext'

// Scheduler redesign: the task dialog asks what the task does first (the
// command field fits the choice), builds the schedule from friendly modes
// with a plain-language summary and the next runs, validates inline, and
// the page offers one-click presets, Duplicate, and human schedules.

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
      createTask: vi.fn(),
      updateTask: vi.fn(),
      validateCron: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    serverApi: { ...actual.serverApi, getStatus: vi.fn() },
    backupApi: { ...actual.backupApi, getStatus: vi.fn() },
  }
})

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

const getTasks = vi.mocked(schedulerApi.getTasks)
const createTask = vi.mocked(schedulerApi.createTask)
const updateTask = vi.mocked(schedulerApi.updateTask)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const SERVERS = [{ id: 3, name: 'Main', serverName: 'main', isActive: true }]

function mocks(tasks: unknown[] = []) {
  getTasks.mockResolvedValue({ tasks })
  vi.mocked(schedulerApi.getCronPresets).mockResolvedValue({ presets: [] })
  vi.mocked(schedulerApi.getHistory).mockResolvedValue({ history: [] })
  vi.mocked(schedulerApi.getStatus).mockResolvedValue({
    activeTasks: 0, autoRestartEnabled: false, backupScheduleEnabled: false, modUpdateRestartPending: false,
    timezone: 'UTC', configuredTimezone: 'UTC', timezoneFallback: null,
  } as unknown as Awaited<ReturnType<typeof schedulerApi.getStatus>>)
  vi.mocked(schedulerApi.validateCron).mockResolvedValue({ valid: true })
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: SERVERS } as unknown as Awaited<ReturnType<typeof serversApi.getAll>>)
  vi.mocked(serverApi.getStatus).mockResolvedValue({ running: true } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  vi.mocked(backupApi.getStatus).mockResolvedValue(null as unknown as Awaited<ReturnType<typeof backupApi.getStatus>>)
  createTask.mockResolvedValue({ success: true, task: {}, dstWarning: null })
  updateTask.mockResolvedValue({ success: true, dstWarning: null })
}

function renderScheduler() {
  return render(
    <MemoryRouter initialEntries={['/scheduler']}>
      <ConfirmProvider>
        <UnsavedChangesProvider>
          <TooltipProvider>
            <Scheduler />
          </TooltipProvider>
        </UnsavedChangesProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  )
}

async function openNewTask() {
  fireEvent.click(await screen.findByRole('button', { name: 'New task' }))
  return screen.findByRole('dialog')
}

const TASK = {
  id: 9, name: 'Heads-up', cron_expression: '0 */6 * * *', command: 'servermsg Restart soon',
  server_id: 3, enabled: 1, last_run: null, created_at: '2026-08-01T00:00:00.000Z', next_run: null,
}

describe('Scheduler task dialog: type first, then a friendly schedule', () => {
  it('a broadcast gets a message box, a generated name, a summary with the next runs, and saves as servermsg', async () => {
    mocks()
    renderScheduler()
    const dialog = await openNewTask()

    expect(within(dialog).queryByLabelText('Message')).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Broadcast' }))
    fireEvent.change(within(dialog).getByLabelText('Message'), { target: { value: 'Back in 5' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Every few hours' }))

    expect(within(dialog).getAllByText('Every 6 hours').length).toBeGreaterThan(0)
    expect(within(dialog).getByText('Next runs')).toBeInTheDocument()
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(3)
    expect(within(dialog).getByLabelText('Task Name')).toHaveValue('Broadcast · Every 6 hours')
    expect(within(dialog).queryByText(/Generated Cron/)).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Task' }))
    await waitFor(() => expect(createTask).toHaveBeenCalledWith('Broadcast · Every 6 hours', '0 */6 * * *', 'servermsg Back in 5', '3'))
  })

  it('shows what is missing inline instead of saving', async () => {
    mocks()
    renderScheduler()
    const dialog = await openNewTask()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Task' }))
    expect(await within(dialog).findByText('Pick what the task should do.')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Broadcast' }))
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Specific days' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Monday' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Task' }))

    expect(await within(dialog).findByText('Write the message players will see.')).toBeInTheDocument()
    expect(within(dialog).getByText('Pick at least one day.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Message')).toHaveAttribute('aria-invalid', 'true')
    expect(createTask).not.toHaveBeenCalled()
  })

  it('specific days save one cron for the picked days', async () => {
    mocks()
    renderScheduler()
    const dialog = await openNewTask()

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Save' }))
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Specific days' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Friday' }))
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '21:30' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Task' }))

    await waitFor(() => expect(createTask).toHaveBeenCalledWith(expect.stringMatching(/^Save · Every Monday and Friday at/), '30 21 * * 1,5', 'save', '3'))
  })

  it('Backup points to the backup schedule instead of creating a task', async () => {
    mocks()
    renderScheduler()
    const dialog = await openNewTask()

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Backup' }))
    expect(within(dialog).getByRole('link', { name: 'Open the backup schedule' })).toHaveAttribute('href', '/backups?panel=schedule')
    expect(within(dialog).queryByRole('button', { name: 'Create Task' })).not.toBeInTheDocument()
  })
})

describe('Scheduler task list and presets', () => {
  it('rows read as a human schedule, and Edit reopens the task in its own type and mode', async () => {
    mocks([TASK])
    renderScheduler()

    await screen.findByRole('heading', { level: 3, name: 'Heads-up' })
    expect(screen.getByText('Every 6 hours')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Heads-up' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('radio', { name: 'Broadcast' })).toHaveAttribute('aria-checked', 'true')
    expect(within(dialog).getByRole('radio', { name: 'Every few hours' })).toHaveAttribute('aria-checked', 'true')
    expect(within(dialog).getByLabelText('Message')).toHaveValue('Restart soon')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(updateTask).toHaveBeenCalledWith(9, 'Heads-up', '0 */6 * * *', 'servermsg Restart soon', true, '3'))
  })

  it('Duplicate opens a copy that creates a new task', async () => {
    mocks([TASK])
    renderScheduler()

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'More actions for Heads-up' }), { button: 0, ctrlKey: false })
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Duplicate' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Create Scheduled Task')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Task' }))
    await waitFor(() => expect(createTask).toHaveBeenCalledWith('Heads-up (copy)', '0 */6 * * *', 'servermsg Restart soon', '3'))
    expect(updateTask).not.toHaveBeenCalled()
  })

  it('an empty list offers one-click presets that open ready to save, and close without claiming edits', async () => {
    mocks()
    renderScheduler()

    fireEvent.click(await screen.findByRole('button', { name: /Daily restart/ }))
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('radio', { name: 'Restart' })).toHaveAttribute('aria-checked', 'true')
    expect(within(dialog).getByLabelText('Task Name')).toHaveValue('Daily restart')

    // Untouched: closes without the leave-without-saving confirm.
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Daily restart/ }))
    dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Task' }))
    await waitFor(() => expect(createTask).toHaveBeenCalledWith('Daily restart', '0 6 * * *', 'restart', '3'))
  })
})
