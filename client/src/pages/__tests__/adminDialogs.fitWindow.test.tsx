import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Backups from '../Backups'
import RolesPermissions from '../RolesPermissions'
import Users from '../Users'
import { backupApi, permissionsApi, serversApi, usersApi, type BackupStatus, type CapabilityGroup } from '@/lib/api'

// 2026-09 dialog sweep (after the Templates preview community report), each
// measured in Chromium at 375x667 / 853x413 / 1280x620 / 1920x1080:
//  - New Role listed all 30 capabilities in a dialog that scrolled as a whole
//    under its own 85vh cap: Create role and Cancel were off-screen at every
//    size;
//  - Add User's form took Create account below the fold on a landscape phone;
//  - Backups' Server Snapshot: a long SERVER.INI line widened it at every
//    size (fixed by AlertDialogContent's one-column template), and on a
//    landscape phone its only button, Close, was below the fold with the two
//    <pre>s scrolling inside the scrolling dialog;
//  - Delete Old Backups: a nowrap label row (es/fr/ht) wider than a phone.
// jsdom does no layout; this pins the structure.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'admin', role: 'admin', capabilities: [] },
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
    permissionsApi: { ...actual.permissionsApi, getCapabilities: vi.fn(), getRoles: vi.fn() },
    usersApi: { ...actual.usersApi, list: vi.fn() },
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn() },
    backupApi: { ...actual.backupApi, getStatus: vi.fn(), listBackups: vi.fn(), getHistory: vi.fn(), getSnapshot: vi.fn() },
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function bodyOf(dialog: HTMLElement, buttons: RegExp[]) {
  expect(dialog.className).not.toContain('max-h-[85vh]')
  const body = dialog.querySelector<HTMLElement>(':scope > [data-dialog-body]')
  expect(body).not.toBeNull()
  for (const name of buttons) expect(body!.contains(within(dialog).getByRole('button', { name }))).toBe(false)
  return body!
}

describe('Roles & Permissions -- New Role', () => {
  it('scrolls only the name and capability list; Create role and Cancel stay put', async () => {
    const groups: CapabilityGroup[] = Array.from({ length: 12 }, (_, g) => ({
      group: `group${g}`,
      capabilities: [0, 1, 2].map((c) => ({ key: `g${g}.c${c}`, label: `Capability ${g}.${c}`, description: 'd' })),
    }))
    vi.mocked(permissionsApi.getCapabilities).mockResolvedValue({ groups })
    vi.mocked(permissionsApi.getRoles).mockResolvedValue({ roles: [] })
    vi.mocked(usersApi.list).mockResolvedValue({ users: [] })
    render(<TooltipProvider><RolesPermissions /></TooltipProvider>)

    fireEvent.click((await screen.findAllByRole('button', { name: 'New Role' }))[0])
    const dialog = await screen.findByRole('dialog')
    const body = bodyOf(dialog, [/^create role$/i, /^cancel$/i])
    expect(within(body).getAllByRole('checkbox')).toHaveLength(36)
    expect(body.contains(within(dialog).getByLabelText('Role name'))).toBe(true)
  })
})

describe('Users -- Add User', () => {
  it('scrolls only the fields; Create account and Cancel stay put', async () => {
    vi.mocked(usersApi.list).mockResolvedValue({ users: [] })
    vi.mocked(permissionsApi.getRoles).mockResolvedValue({ roles: [] })
    render(
      <MemoryRouter>
        <TooltipProvider><ConfirmProvider><Users /></ConfirmProvider></TooltipProvider>
      </MemoryRouter>,
    )
    fireEvent.click((await screen.findAllByRole('button', { name: /add user/i }))[0])
    const dialog = await screen.findByRole('dialog')
    const body = bodyOf(dialog, [/^create account$/i, /^cancel$/i])
    expect(body.contains(within(dialog).getByLabelText('Username'))).toBe(true)
  })
})

describe('Backups -- snapshot and delete-older dialogs', () => {
  const status: BackupStatus = {
    enabled: true, schedule: '0 */6 * * *', maxBackups: 10, includeDb: true,
    backupInProgress: false, restoreInProgress: false, lastBackup: null,
    backupCount: 1, savesPath: '/saves', backupsPath: '/backups', savesExists: true,
  }
  const backupName = 'uploaded-DeadRising_Season3_full_world_backup_before_B42_migration.zip'

  function renderBackups() {
    vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server: { id: 1, name: 'Ashenwood' } as never })
    vi.mocked(backupApi.getStatus).mockResolvedValue(status)
    vi.mocked(backupApi.listBackups).mockResolvedValue({
      backups: [{ name: backupName, path: `/backups/${backupName}`, size: 1024, created: '2026-09-30T00:00:00.000Z' }],
    })
    vi.mocked(backupApi.getHistory).mockResolvedValue({ records: [] })
    render(<TooltipProvider><Backups /></TooltipProvider>)
  }

  it('Server Snapshot: one scrolling body with Close outside it; the <pre>s only scroll sideways', async () => {
    vi.mocked(backupApi.getSnapshot).mockResolvedValue({
      success: true,
      snapshot: {
        createdAt: '2026-09-30T00:00:00.000Z',
        server: { name: 'DeadRising_Survivors_PvE_Season3_EU_Main', provider: 'native' },
        serverIni: { PublicName: '[EU] Dead Rising Survivors | PvE | B42 | 24/7 | discord.gg/deadrising' },
        sandboxVars: { Zombies: 3 },
      },
    } as unknown as Awaited<ReturnType<typeof backupApi.getSnapshot>>)
    renderBackups()
    fireEvent.click(await screen.findByRole('button', { name: `View snapshot for ${backupName}` }))
    const dialog = await screen.findByRole('alertdialog')
    const body = bodyOf(dialog, [/^close$/i])

    const serverName = within(body).getByText('DeadRising_Survivors_PvE_Season3_EU_Main')
    expect(serverName.className).toContain('[overflow-wrap:anywhere]')
    for (const pre of body.querySelectorAll('pre')) {
      expect(pre.className).toContain('overflow-x-auto')
      expect(pre.className).not.toMatch(/max-h-/)
    }
  })

  it('Delete Old Backups: the "older than" row wraps', async () => {
    renderBackups()
    fireEvent.click(await screen.findByRole('button', { name: /delete older/i }))
    const dialog = await screen.findByRole('alertdialog')
    const label = within(dialog).getByText('Delete backups older than')
    expect(label.className).not.toContain('whitespace-nowrap')
    expect(label.parentElement!.className).toContain('flex-wrap')
  })
})
