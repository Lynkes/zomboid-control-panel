import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { backupApi, serversApi, type BackupStatus } from '@/lib/api'
import en from '../../locales/en/backups.json'

// pz-ux-deep-pass 2026-09-18 (Backups.tsx): the "Status Cards" row --
// Total Backups / Total Size / Last Backup / Auto-Backup -- used to be
// gated on `backups.length > 0`. That made two real states invisible:
//
//   1. A server whose scheduled backups have been failing since before the
//      first one ever succeeded (disk full, unreachable saves path, etc.)
//      never gets to backups.length > 0, so the amber
//      "Last scheduled attempt failed" card -- the ONLY place that failure
//      is surfaced -- never rendered. The page looked identical to
//      "auto-backup was simply never configured", failing operator
//      irritant #1 ("can't tell what state it's in") in exactly the way
//      persona (c) of the UX pass calls out.
//   2. The Auto-Backup Switch living in that same card is the ONLY control
//      on the page that turns scheduled backups on. Hiding the whole row
//      until a backup already exists meant a first-launch operator with an
//      empty backups list had no way to reach it at all -- irritant #2
//      ("doesn't know what to do next").
//
// The fix re-gates the row on `backupsLoaded` (the fetch has settled,
// whether it found zero backups or many) instead of `backups.length > 0`.
// This test pins that: zero backups, a scheduled job that's been failing,
// and the card must still show up.

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
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn() },
    backupApi: {
      ...actual.backupApi,
      getStatus: vi.fn(),
      listBackups: vi.fn(),
      getHistory: vi.fn(),
    },
  }
})

const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getStatus = vi.mocked(backupApi.getStatus)
const listBackups = vi.mocked(backupApi.listBackups)
const getHistory = vi.mocked(backupApi.getHistory)

const failingStatus: BackupStatus = {
  enabled: true,
  schedule: '0 */6 * * *',
  maxBackups: 10,
  includeDb: true,
  backupInProgress: false,
  restoreInProgress: false,
  lastBackup: null,
  backupCount: 0,
  savesPath: '/saves',
  backupsPath: '/backups',
  savesExists: true,
  lastScheduledBackupAttempt: {
    success: false,
    message: 'ENOSPC: no space left on device',
    executedAt: '2026-09-17T08:00:00.000Z',
  },
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderBackups() {
  return render(
    <TooltipProvider>
      <Backups />
    </TooltipProvider>,
  )
}

describe('Backups.tsx: the Auto-Backup status row is not hidden behind having at least one backup', () => {
  it('shows the Auto-Backup card and the failing-scheduled-attempt warning even with zero backups', async () => {
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus.mockResolvedValue(failingStatus)
    listBackups.mockResolvedValue({ backups: [] })
    getHistory.mockResolvedValue({ records: [] })

    renderBackups()

    // The row itself (previously entirely absent with zero backups).
    expect(await screen.findByText(en.statusCards.autoBackup)).toBeInTheDocument()
    // The one control that turns scheduling on/off must be reachable too.
    expect(screen.getByRole('switch', { name: en.statusCards.toggleAria })).toBeInTheDocument()
    // The failure itself, not silently indistinguishable from "not configured".
    // The failed-attempt <p> carries the raw message as its title attribute.
    expect(screen.getByTitle(failingStatus.lastScheduledBackupAttempt!.message!)).toBeInTheDocument()
  })

  it('control: the "no scheduled backups configured" state stays distinguishable (Off, no attempt)', async () => {
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus.mockResolvedValue({ ...failingStatus, enabled: false, lastScheduledBackupAttempt: null })
    listBackups.mockResolvedValue({ backups: [] })
    getHistory.mockResolvedValue({ records: [] })

    renderBackups()

    expect(await screen.findByText(en.statusCards.off)).toBeInTheDocument()
    expect(screen.getByText(en.statusCards.noScheduled)).toBeInTheDocument()
  })
})
