import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Link, MemoryRouter } from 'react-router-dom'
import Scheduler from '../Scheduler'
import { backupApi, schedulerApi, serverApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { UnsavedChangesProvider } from '@/contexts/UnsavedChangesContext'
import enScheduler from '../../locales/en/scheduler.json'

// UX restructure (slice B): the page is ordered around its tasks (tasks,
// then the act-now row, then history and settings), the header shows while
// loading, the backup health has its own card that links to the backup
// schedule, the settings card has one Save (the SaveBar), and the task
// dialog and the settings cannot be left with unsaved edits without a
// confirm.

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
      setTimezone: vi.fn(),
      setRestartWarning: vi.fn(),
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
const getCronPresets = vi.mocked(schedulerApi.getCronPresets)
const getStatus = vi.mocked(schedulerApi.getStatus)
const getHistory = vi.mocked(schedulerApi.getHistory)
const setTimezone = vi.mocked(schedulerApi.setTimezone)
const setRestartWarning = vi.mocked(schedulerApi.setRestartWarning)
const serversGetAll = vi.mocked(serversApi.getAll)
const serverGetStatus = vi.mocked(serverApi.getStatus)
const backupGetStatus = vi.mocked(backupApi.getStatus)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const STATUS = {
  activeTasks: 1,
  autoRestartEnabled: false,
  backupScheduleEnabled: true,
  backupNextRun: '2026-09-19T00:00:00.000Z',
  modUpdateRestartPending: false,
  timezone: 'UTC',
  configuredTimezone: 'UTC',
  timezoneFallback: null,
  restartWarning: { locale: 'en' as const, template: 'Restart in {count} {unit}' },
  restartWarningPresets: { en: 'Restart in {count} {unit}' },
}

function baseMocks() {
  getTasks.mockResolvedValue({
    tasks: [{
      id: 7, name: 'Nightly Restart', cron_expression: '0 4 * * *', command: 'restart',
      server_id: null, enabled: 1, last_run: null, created_at: '2026-08-01T00:00:00.000Z',
    }],
  })
  getCronPresets.mockResolvedValue({ presets: [] })
  getHistory.mockResolvedValue({ history: [] })
  getStatus.mockResolvedValue(STATUS as unknown as Awaited<ReturnType<typeof schedulerApi.getStatus>>)
  serversGetAll.mockResolvedValue({ servers: [] })
  serverGetStatus.mockResolvedValue({ running: true } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  backupGetStatus.mockResolvedValue({
    lastScheduledBackupAttempt: { success: true, message: null, executedAt: '2026-09-18T00:00:00.000Z' },
  } as unknown as Awaited<ReturnType<typeof backupApi.getStatus>>)
}

function renderScheduler({ guard = false }: { guard?: boolean } = {}) {
  const page = (
    <TooltipProvider>
      <Scheduler />
      <Link to="/backups">Somewhere else</Link>
    </TooltipProvider>
  )
  return render(
    <MemoryRouter initialEntries={['/scheduler']}>
      {guard ? (
        <ConfirmProvider>
          <UnsavedChangesProvider>{page}</UnsavedChangesProvider>
        </ConfirmProvider>
      ) : page}
    </MemoryRouter>,
  )
}

describe('Scheduler: one header in every state, tasks first', () => {
  it('shows the page header and New task while the data is still loading', async () => {
    getTasks.mockReturnValue(new Promise(() => {}))
    getCronPresets.mockResolvedValue({ presets: [] })
    getHistory.mockResolvedValue({ history: [] })
    getStatus.mockResolvedValue(null as unknown as Awaited<ReturnType<typeof schedulerApi.getStatus>>)
    serversGetAll.mockResolvedValue({ servers: [] })
    serverGetStatus.mockResolvedValue({ running: true } as Awaited<ReturnType<typeof serverApi.getStatus>>)
    backupGetStatus.mockResolvedValue(null as unknown as Awaited<ReturnType<typeof backupApi.getStatus>>)

    renderScheduler()

    expect(screen.getByRole('heading', { level: 1, name: enScheduler.pageHeader.title })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: enScheduler.pageHeader.newTask })).toBeInTheDocument()
    // Bug pass: opened before the server list loads, the form got its default
    // target server afterwards and an untouched dialog claimed unsaved edits.
    expect(screen.getByRole('button', { name: enScheduler.pageHeader.newTask })).toBeDisabled()
    expect(screen.queryByRole('heading', { level: 2, name: enScheduler.scheduledTasks.title })).not.toBeInTheDocument()
  })

  it('orders the sections: tasks, manual restart and quick broadcasts, then history, settings and automatic backups', async () => {
    baseMocks()
    renderScheduler()

    await screen.findByRole('heading', { level: 3, name: 'Nightly Restart' })
    const order = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(order).toEqual([
      enScheduler.scheduledTasks.title,
      enScheduler.manualRestart.title,
      enScheduler.quickBroadcasts.title,
      enScheduler.executionHistory.title,
      enScheduler.settings.title,
      enScheduler.timezone.backupHealthTitle,
      enScheduler.cronHelp.title,
    ])
  })

  it('the automatic-backups card links to the backup schedule on Backups', async () => {
    baseMocks()
    renderScheduler()

    const card = (await screen.findByRole('heading', { level: 2, name: enScheduler.timezone.backupHealthTitle })).closest('section') as HTMLElement
    expect(within(card).getByText(/Last attempt succeeded ·/)).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: enScheduler.timezone.backupHealthLink })).toHaveAttribute('href', '/backups?panel=schedule')
  })
})

describe('Scheduler settings: one Save in the SaveBar', () => {
  // Bug pass: the settings fields were filled by an effect a render after the
  // status arrived, so the SaveBar flashed on every load.
  it('never shows the SaveBar while the page loads', async () => {
    baseMocks()
    let flashed = false
    const observer = new MutationObserver(() => {
      if (screen.queryByRole('button', { name: enScheduler.timezone.saveButton })) flashed = true
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    try {
      renderScheduler()
      const template = await screen.findByLabelText(enScheduler.restartWarning.templateLabel)
      await waitFor(() => expect(template).toHaveValue('Restart in {count} {unit}'))
    } finally {
      observer.disconnect()
    }
    expect(flashed).toBe(false)
  })

  it('shows no Save until something changes, then saves only what changed', async () => {
    baseMocks()
    setRestartWarning.mockResolvedValue({ success: true, restartWarning: { locale: 'en', template: 'Going down in {count} {unit}' } } as unknown as Awaited<ReturnType<typeof schedulerApi.setRestartWarning>>)

    renderScheduler()

    const template = await screen.findByLabelText(enScheduler.restartWarning.templateLabel)
    await waitFor(() => expect(template).toHaveValue('Restart in {count} {unit}'))
    expect(screen.queryByRole('button', { name: enScheduler.timezone.saveButton })).not.toBeInTheDocument()

    fireEvent.change(template, { target: { value: 'Going down in {count} {unit}' } })
    fireEvent.click(await screen.findByRole('button', { name: enScheduler.timezone.saveButton }))

    await waitFor(() => expect(setRestartWarning).toHaveBeenCalledWith({ locale: 'en', template: 'Going down in {count} {unit}' }))
    expect(setTimezone).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('button', { name: enScheduler.timezone.saveButton })).not.toBeInTheDocument())
  })

  it('Discard puts the timezone and the warning back to what is saved', async () => {
    baseMocks()
    renderScheduler()

    const input = await screen.findByLabelText(enScheduler.timezone.inputLabel)
    await waitFor(() => expect(input).toHaveValue('UTC'))
    fireEvent.change(input, { target: { value: 'Europe/Berlin' } })
    const template = screen.getByLabelText(enScheduler.restartWarning.templateLabel)
    fireEvent.change(template, { target: { value: 'Changed' } })

    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))

    expect(input).toHaveValue('UTC')
    expect(template).toHaveValue('Restart in {count} {unit}')
    expect(screen.queryByRole('button', { name: enScheduler.timezone.saveButton })).not.toBeInTheDocument()
  })

  it('asks before leaving the page with an unsaved timezone', async () => {
    baseMocks()
    renderScheduler({ guard: true })

    const input = await screen.findByLabelText(enScheduler.timezone.inputLabel)
    await waitFor(() => expect(input).toHaveValue('UTC'))
    fireEvent.change(input, { target: { value: 'Europe/Berlin' } })

    fireEvent.click(screen.getByRole('link', { name: 'Somewhere else' }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Leave without saving?')
  })
})

describe('Scheduler task dialog: unsaved edits are not dropped silently', () => {
  it('asks before closing a task dialog that holds edits, and keeps it open on "Keep editing"', async () => {
    baseMocks()
    renderScheduler({ guard: true })

    fireEvent.click(await screen.findByRole('button', { name: enScheduler.pageHeader.newTask }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByPlaceholderText(enScheduler.dialog.taskNamePlaceholder), { target: { value: 'Half-written task' } })

    fireEvent.keyDown(dialog, { key: 'Escape' })
    const confirm = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep editing' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByPlaceholderText(enScheduler.dialog.taskNamePlaceholder)).toHaveValue('Half-written task')
  })

  it('closes an untouched task dialog without asking', async () => {
    baseMocks()
    renderScheduler({ guard: true })

    fireEvent.click(await screen.findByRole('button', { name: enScheduler.pageHeader.newTask }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
