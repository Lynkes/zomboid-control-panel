import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { backupApi, configApi, serversApi, type BackupScheduleValidation, type BackupStatus } from '@/lib/api'

// Settings > Backups has its own raw "Schedule" field for the same saved
// schedule the Backups page's Backup Frequency picker edits. It used to be
// judged by a local regex (isValidCron: five fields of digits, '*', '/',
// '-', ',') while the Backups page asks the server (POST
// /backup/validate-schedule, the same checks POST /backup/settings saves
// under) -- so the two editors disagreed in both directions:
//
//   - "0 3 * * MON" (a named weekday node-cron and the server accept, and
//     the Backups page's custom field takes) was refused here outright;
//   - "99 * * * *" (minute 99) passed here and only failed at save, as a
//     generic "could not save".
//
// Same fix as 37e297c9 made for the Scheduler's cron field: this field now
// goes through the same check as the Backups page, live and on Save.

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

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    backupApi: {
      ...actual.backupApi,
      getStatus: vi.fn(),
      listBackups: vi.fn(),
      updateSettings: vi.fn(),
      validateSchedule: vi.fn(),
    },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

// Stable across renders -- see Settings.activeServerChangedEditLoss.test.tsx.
const fakeSocket = vi.hoisted(() => ({ connected: true, on: () => {}, off: () => {}, emit: () => {} }))
vi.mock('@/contexts/SocketContext', () => ({ useSocket: () => fakeSocket }))

const getAppSettings = vi.mocked(configApi.getAppSettings)
const getAllServers = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const updateSettings = vi.mocked(backupApi.updateSettings)
const validateSchedule = vi.mocked(backupApi.validateSchedule)

const status = {
  enabled: true,
  schedule: '0 */6 * * *',
  maxBackups: 10,
  savesExists: true,
  backupCount: 0,
  lastBackup: null,
  restartOverlaps: [],
} as unknown as BackupStatus

const VALID: BackupScheduleValidation = {
  valid: true, nextRun: '2026-09-28T03:00:00.000Z', timezone: 'UTC', restartOverlaps: [],
}

function prime() {
  getAppSettings.mockResolvedValue({ settings: {} } as never)
  getAllServers.mockResolvedValue({ servers: [] } as never)
  getStatus.mockResolvedValue(status)
  listBackups.mockResolvedValue({ backups: [] } as never)
  updateSettings.mockResolvedValue({ success: true, settings: status } as never)
  validateSchedule.mockResolvedValue(VALID)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings?tab=backups']}>
      <TooltipProvider>
        <Settings />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function scheduleField() {
  const field = await screen.findByLabelText('Schedule')
  await waitFor(() => expect(field).toHaveValue('0 */6 * * *'))
  return field
}

describe('Settings > Backups: the Schedule field is judged by the server, like the Backups page', () => {
  it('accepts what the server accepts -- a named weekday the old local regex refused -- and saves it', async () => {
    prime()
    renderSettings()
    const field = await scheduleField()

    fireEvent.change(field, { target: { value: '0 3 * * MON' } })
    expect(await screen.findByText('Valid schedule')).toBeInTheDocument()
    expect(validateSchedule).toHaveBeenCalledWith('0 3 * * MON')
    // Same preview as the Backups page's custom field: next run, labelled
    // with the scheduler's zone, and the zone itself.
    expect(screen.getByText(/^Next backup: .*UTC$/)).toBeInTheDocument()
    expect(screen.getByText(/Schedule times are in the panel's timezone, UTC/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /save schedule settings/i }))
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ enabled: true, schedule: '0 3 * * MON', maxBackups: 10 }, null),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Invalid Schedule' }))
  })

  it("refuses what the server refuses -- minute 99, which the old regex let through -- with the server's reason, live and on Save", async () => {
    prime()
    validateSchedule.mockImplementation(async (schedule: string) =>
      schedule === '99 * * * *'
        ? { valid: false, code: 'SCHEDULER_INVALID_CRON_EXPRESSION', error: 'Invalid cron expression format' }
        : VALID,
    )
    renderSettings()
    const field = await scheduleField()

    fireEvent.change(field, { target: { value: '99 * * * *' } })
    const reason = /^Invalid cron expression\. Use the format: minute hour day month weekday/
    expect(await screen.findByText(reason)).toBeInTheDocument()
    expect(screen.queryByText(/^Next backup:/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /save schedule settings/i }))
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Invalid Schedule',
        description: expect.stringMatching(reason),
        variant: 'destructive',
      })),
    )
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('previews the restart overlap for what is typed, not only for the saved schedule', async () => {
    prime()
    const overlap = {
      kind: 'task' as const, name: 'Restart every 4h', cron: '0 */4 * * *', restartTime: '00:00', backupTime: '00:00',
      timezone: 'UTC', allBackups: true, windowMinutes: 10,
    }
    validateSchedule.mockImplementation(async (schedule: string) =>
      schedule === '0 */4 * * *' ? { ...VALID, restartOverlaps: [overlap] } : VALID,
    )
    renderSettings()
    const field = await scheduleField()
    expect(screen.queryByText('Backups overlap a scheduled restart')).not.toBeInTheDocument()

    fireEvent.change(field, { target: { value: '0 */4 * * *' } })
    expect(await screen.findByText('Backups overlap a scheduled restart')).toBeInTheDocument()
    // The zone is named once -- by the next-run line right above it.
    expect(screen.getAllByText(/Schedule times are in the panel's timezone, UTC/)).toHaveLength(1)
  })

  it("a check that can't run doesn't block the save -- POST /backup/settings has the final word", async () => {
    prime()
    validateSchedule.mockRejectedValue(new Error('Network error'))
    renderSettings()
    const field = await scheduleField()

    fireEvent.change(field, { target: { value: ' 30 3 * * * ' } })
    fireEvent.click(screen.getByRole('button', { name: /save schedule settings/i }))
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ enabled: true, schedule: '30 3 * * *', maxBackups: 10 }, null),
    )
  })
})
