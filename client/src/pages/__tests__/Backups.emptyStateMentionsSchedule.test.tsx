import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { backupApi, serversApi, type BackupStatus } from '@/lib/api'
import en from '../../locales/en/backups.json'

// pz-ux-deep-pass 2026-09-18 (Backups.tsx, first-launch persona): the empty
// "No safety net" card previously said the exact same thing ("Create a
// backup...") whether or not scheduled backups were already turned on --
// it never told the operator a scheduled run would fill this list in on its
// own, nor that a manual backup is the way to skip waiting for it. Now the
// copy branches on backupStatus.enabled so the empty state actually answers
// "what will appear here and how" (persona (a)'s question).

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

const baseStatus: BackupStatus = {
  enabled: false,
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
  lastScheduledBackupAttempt: null,
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

describe('Backups.tsx: the empty-backups card names the scheduled-backups option', () => {
  it('points to turning on scheduled backups when they are currently off', async () => {
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus.mockResolvedValue({ ...baseStatus, enabled: false })
    listBackups.mockResolvedValue({ backups: [] })
    getHistory.mockResolvedValue({ records: [] })

    renderBackups()

    expect(await screen.findByText(en.mainCard.emptyDesc)).toBeInTheDocument()
    expect(screen.queryByText(en.mainCard.emptyDescScheduled)).not.toBeInTheDocument()
  })

  it('says the first one will appear automatically once scheduled backups are already on', async () => {
    getResolvedActive.mockResolvedValue({ server: null })
    getStatus.mockResolvedValue({ ...baseStatus, enabled: true })
    listBackups.mockResolvedValue({ backups: [] })
    getHistory.mockResolvedValue({ records: [] })

    renderBackups()

    expect(await screen.findByText(en.mainCard.emptyDescScheduled)).toBeInTheDocument()
    expect(screen.queryByText(en.mainCard.emptyDesc)).not.toBeInTheDocument()
  })
})
