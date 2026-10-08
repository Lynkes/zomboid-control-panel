import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { backupApi, serversApi, type BackupStatus } from '@/lib/api'

// The public demo (VITE_DEMO_MODE) answered GET /backup/status with its
// catch-all reply, which had no schedule: the saved schedule went into the
// settings form's string state as undefined, and customCron.trim() took the
// whole page down. A status without a usable schedule now reads as none.

// Radix <Select> can't be driven by pointer events in jsdom -- swapped for a
// native <select>, as in Backups.customScheduleAndRestartOverlap.test.tsx.
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
        <option value="">Select frequency</option>
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
const validateSchedule = vi.mocked(backupApi.validateSchedule)

// A full status, then the schedule taken out (or replaced with a non-string)
// -- everything else the page reads is still there.
function statusWithSchedule(schedule: 'missing' | null | number): BackupStatus {
  const status: Record<string, unknown> = {
    enabled: true, schedule: '0 */6 * * *', maxBackups: 10, includeDb: true,
    backupInProgress: false, restoreInProgress: false, lastBackup: null,
    backupCount: 1, savesPath: '/saves', backupsPath: '/backups', savesExists: true,
    lastScheduledBackupAttempt: null, restartOverlaps: [], backupDeferredSince: null,
  }
  if (schedule === 'missing') delete status.schedule
  else status.schedule = schedule
  return status as unknown as BackupStatus
}

function prime(status: BackupStatus) {
  getResolvedActive.mockResolvedValue({ server: { id: 1, name: 'Tavern' } as never })
  getStatus.mockResolvedValue(status)
  listBackups.mockResolvedValue({
    backups: [{ name: 'Tavern_2026-10-01T00-00-00-000.zip', path: '/backups/Tavern_2026-10-01T00-00-00-000.zip', size: 1024, created: '2026-10-01T00:00:00.000Z' }],
  })
  getHistory.mockResolvedValue({ records: [] })
  validateSchedule.mockResolvedValue({ valid: true, nextRun: null, timezone: 'UTC', restartOverlaps: [] })
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

describe('Backups.tsx: a status without a usable schedule', () => {
  it.each([
    ['no schedule field', 'missing' as const],
    ['a null schedule', null],
    ['a numeric schedule', 42],
  ])('renders with %s -- the page, its backups, and an empty schedule in the settings panel', async (_label, schedule) => {
    prime(statusWithSchedule(schedule))
    renderBackups()

    // The page itself, with the status and the list both applied.
    expect(await screen.findByText('Tavern_2026-10-01T00-00-00-000.zip')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'World Backups' })).toBeInTheDocument()
    await waitFor(() => expect(getStatus).toHaveBeenCalled())

    // The settings panel: no saved schedule to show, so the menu waits on a
    // choice -- not the form's '0 */6 * * *' default (the status was
    // applied), and not "Custom" with nothing in it.
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }))
    const frequency = await screen.findByRole('combobox', { name: 'Backup Frequency' })
    expect(frequency).toHaveValue('')
    expect(screen.queryByLabelText('Cron expression')).not.toBeInTheDocument()

    // Custom starts from nothing, and typing into it works.
    fireEvent.change(frequency, { target: { value: 'custom' } })
    const cron = await screen.findByLabelText('Cron expression')
    expect(cron).toHaveValue('')
    fireEvent.change(cron, { target: { value: ' 30 3 * * * ' } })
    await waitFor(() => expect(validateSchedule).toHaveBeenCalledWith('30 3 * * *'))
  })
})
