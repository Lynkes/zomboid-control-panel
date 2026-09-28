import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { backupApi, serversApi, type BackupStatus, type BackupScheduleValidation } from '@/lib/api'

// 2026-09-27 community requests (Discord, server "Tavern"):
//
//   - "Custom (cron expression)" on the Backup Frequency picker. The menu only
//     had presets, while Settings > Backups has always taken a raw cron
//     expression for the same saved schedule -- so a custom schedule saved
//     there showed up here as a blank menu and a bare cron string. The option
//     validates live against the server's own rules (POST
//     /backup/validate-schedule, shared with POST /backup/settings), shows the
//     next run in the scheduler's timezone, and describes itself as custom.
//   - The restart collision behind "Scheduled backup failing -- Skipped: a
//     restart was in progress": the page now says when the backup schedule
//     lands inside a scheduled restart, and words an old restart skip as a
//     skip.
//
// Radix <Select> can't be driven by pointer events in jsdom (see
// Chat.capabilityGating.test.tsx) -- swapped for a native <select>, which
// leaves Backups.tsx's own schedule logic untouched.
vi.mock('@/components/ui/select', () => {
  function collectItems(children: React.ReactNode): Array<{ value: string; label: React.ReactNode }> {
    const items: Array<{ value: string; label: React.ReactNode }> = []
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const nested = (child.props as { children?: React.ReactNode }).children
      React.Children.forEach(nested, (item) => {
        if (React.isValidElement(item) && (item.props as { value?: string }).value !== undefined) {
          items.push({ value: (item.props as { value: string }).value, label: (item.props as { children?: React.ReactNode }).children })
        }
      })
    })
    return items
  }
  function Select({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode }) {
    return (
      <select aria-label="Backup Frequency" value={value} onChange={(e) => onValueChange(e.target.value)}>
        {collectItems(children).map((it) => (
          <option key={it.value} value={it.value}>{it.label}</option>
        ))}
      </select>
    )
  }
  return {
    Select,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

vi.mock('@/contexts/SocketContext', () => ({ useSocket: () => null }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn() },
    backupApi: {
      ...actual.backupApi,
      getStatus: vi.fn(),
      listBackups: vi.fn(),
      getHistory: vi.fn(),
      updateSettings: vi.fn(),
      validateSchedule: vi.fn(),
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const getHistory = vi.mocked(backupApi.getHistory)
const updateSettings = vi.mocked(backupApi.updateSettings)
const validateSchedule = vi.mocked(backupApi.validateSchedule)

function statusWith(overrides: Partial<BackupStatus>): BackupStatus {
  return {
    enabled: true, schedule: '0 */6 * * *', maxBackups: 10, includeDb: true,
    backupInProgress: false, restoreInProgress: false, lastBackup: null,
    backupCount: 0, savesPath: '/saves', backupsPath: '/backups', savesExists: true,
    lastScheduledBackupAttempt: null, restartOverlaps: [], backupDeferredSince: null,
    ...overrides,
  }
}

const VALID: BackupScheduleValidation = {
  valid: true, nextRun: '2026-09-28T03:30:00.000Z', timezone: 'UTC', restartOverlaps: [],
}

function prime(status: BackupStatus) {
  getResolvedActive.mockResolvedValue({ server: { id: 1, name: 'Tavern' } as never })
  getStatus.mockResolvedValue(status)
  listBackups.mockResolvedValue({ backups: [] })
  getHistory.mockResolvedValue({ records: [] })
  updateSettings.mockResolvedValue({ success: true, settings: status })
  validateSchedule.mockResolvedValue(VALID)
}

function renderBackups() {
  return render(
    <TooltipProvider>
      <Backups />
    </TooltipProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Backups.tsx: custom cron schedule', () => {
  it('shows a custom schedule saved elsewhere as "Custom", with its expression, next run and timezone', async () => {
    prime(statusWith({ schedule: '30 3 * * 1-5' }))
    renderBackups()

    // Status card: named as a custom schedule, not a bare cron string.
    expect(await screen.findByText('Runs on a custom schedule (30 3 * * 1-5) · keep 10')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }))
    const frequency = await screen.findByRole('combobox', { name: 'Backup Frequency' })
    expect(frequency).toHaveValue('custom')
    expect(screen.getByRole('option', { name: 'Custom (cron expression)' })).toBeInTheDocument()
    expect(screen.getByLabelText('Cron expression')).toHaveValue('30 3 * * 1-5')

    expect(await screen.findByText('Valid schedule')).toBeInTheDocument()
    expect(validateSchedule).toHaveBeenCalledWith('30 3 * * 1-5')
    expect(screen.getByText(/^Next backup: /)).toBeInTheDocument()
    expect(screen.getByText(/Schedule times are in the panel's timezone, UTC/)).toBeInTheDocument()
  })

  it('switching to Custom starts from the current preset; a too-frequent expression shows the reason and is not saved; a valid one is', async () => {
    prime(statusWith({ schedule: '0 */6 * * *' }))
    validateSchedule.mockImplementation(async (schedule: string) =>
      schedule === '*/2 * * * *'
        ? { valid: false, code: 'BACKUP_SCHEDULE_TOO_FREQUENT', error: 'Backups cannot run more often than every 5 minutes' }
        : VALID,
    )
    renderBackups()

    fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }))
    const frequency = await screen.findByRole('combobox', { name: 'Backup Frequency' })
    expect(frequency).toHaveValue('0 */6 * * *')
    expect(screen.queryByLabelText('Cron expression')).not.toBeInTheDocument()

    fireEvent.change(frequency, { target: { value: 'custom' } })
    const input = await screen.findByLabelText('Cron expression')
    expect(input).toHaveValue('0 */6 * * *')

    fireEvent.change(input, { target: { value: '*/2 * * * *' } })
    // Translated through the errors namespace by its code.
    expect(await screen.findByText('Backups cannot run more often than every 5 minutes')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() => expect(validateSchedule).toHaveBeenLastCalledWith('*/2 * * * *'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updateSettings).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '15 */6 * * *' } })
    expect(await screen.findByText('Valid schedule')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ enabled: true, schedule: '15 */6 * * *', maxBackups: 10 }, 1),
    )
  })

  it('choosing a preset again saves the preset, not the leftover custom text', async () => {
    prime(statusWith({ schedule: '30 3 * * 1-5' }))
    renderBackups()

    fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }))
    const frequency = await screen.findByRole('combobox', { name: 'Backup Frequency' })
    await waitFor(() => expect(frequency).toHaveValue('custom'))
    fireEvent.change(frequency, { target: { value: '0 */12 * * *' } })
    expect(screen.queryByLabelText('Cron expression')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ enabled: true, schedule: '0 */12 * * *', maxBackups: 10 }, 1),
    )
  })
})

describe('Backups.tsx: scheduled backups and scheduled restarts', () => {
  const overlap = {
    kind: 'task' as const, name: 'Restart every 4h', cron: '0 */4 * * *', restartTime: '04:00', backupTime: '04:00',
  }

  it('explains when the saved schedule lands inside a scheduled restart', async () => {
    prime(statusWith({ schedule: '0 */4 * * *', restartOverlaps: [overlap] }))
    renderBackups()

    expect(await screen.findByText('Backups overlap a scheduled restart')).toBeInTheDocument()
    expect(screen.getByText('Backups due at 04:00 fall inside the scheduled restart "Restart every 4h" (04:00).')).toBeInTheDocument()
    expect(screen.getByText(/They wait for the restart to finish, then run/)).toBeInTheDocument()
  })

  it('warns in the settings panel for the schedule being chosen, before it is saved', async () => {
    prime(statusWith({ schedule: '30 */4 * * *' }))
    validateSchedule.mockImplementation(async (schedule: string) =>
      schedule === '0 */4 * * *' ? { ...VALID, restartOverlaps: [overlap] } : VALID,
    )
    renderBackups()

    fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }))
    const frequency = await screen.findByRole('combobox', { name: 'Backup Frequency' })
    await waitFor(() => expect(frequency).toHaveValue('custom'))
    expect(screen.queryByText('Backups overlap a scheduled restart')).not.toBeInTheDocument()

    fireEvent.change(frequency, { target: { value: '0 */4 * * *' } })
    expect(await screen.findByText('Backups overlap a scheduled restart')).toBeInTheDocument()
  })

  it('words an old restart skip as a skip, not a failure -- and a backup since then clears it', async () => {
    const skip = {
      success: false, message: 'Skipped: a restart was in progress', executedAt: '2026-09-27T04:00:00.000Z', skipReason: 'restart' as const,
    }
    prime(statusWith({ lastScheduledBackupAttempt: { ...skip, recoveredAt: null } }))
    renderBackups()
    expect(await screen.findByText(/Last scheduled backup skipped for a restart/)).toBeInTheDocument()
    expect(screen.queryByText(/Last scheduled attempt failed/)).not.toBeInTheDocument()
    cleanup()

    prime(statusWith({ lastScheduledBackupAttempt: { ...skip, recoveredAt: '2026-09-27T05:00:00.000Z' } }))
    renderBackups()
    expect(await screen.findByText('Runs every 6 hours · keep 10')).toBeInTheDocument()
    expect(screen.queryByText(/skipped for a restart/)).not.toBeInTheDocument()
  })

  it('shows a backup waiting on a restart right now', async () => {
    prime(statusWith({ backupDeferredSince: '2026-09-27T04:00:00.000Z' }))
    renderBackups()

    expect(await screen.findByText(/waiting for the server restart to finish/)).toBeInTheDocument()
  })
})
