import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ScheduledBackupServers } from '@/components/backups/ScheduledBackupServers'
import { backupApi, serversApi, type ServerInstance } from '@/lib/api'

// Which servers the backup schedule backs up, on the Backups page: shown
// with two local servers or more, saved at once; with one, nothing changes.

vi.mock('@/contexts/SocketContext', () => ({ useSocket: () => null }))
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    backupApi: { ...actual.backupApi, getSummary: vi.fn(), updateSettings: vi.fn() },
  }
})

const getAll = vi.mocked(serversApi.getAll)
const getSummary = vi.mocked(backupApi.getSummary)
const updateSettings = vi.mocked(backupApi.updateSettings)

const server = (id: string, name: string, extra: Partial<ServerInstance> = {}) =>
  ({ id, name, serverName: name, isActive: false, isRemote: false, ...extra }) as ServerInstance

function renderIt(canManage = true) {
  return render(<TooltipProvider><ScheduledBackupServers canManage={canManage} /></TooltipProvider>)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ScheduledBackupServers', () => {
  it('stays out of the way with a single local server', async () => {
    getAll.mockResolvedValue({ servers: [server('a', 'Alpha', { isActive: true }), server('r', 'Far', { isRemote: true })] } as never)
    getSummary.mockResolvedValue({ servers: [], schedule: { enabled: true, serverIds: null } } as never)
    renderIt()

    await waitFor(() => expect(getSummary).toHaveBeenCalled())
    expect(screen.queryByTestId('scheduled-backup-servers')).not.toBeInTheDocument()
  })

  it('shows the active server chosen until a list is saved, and saves another one added', async () => {
    getAll.mockResolvedValue({ servers: [server('a', 'Alpha', { isActive: true }), server('b', 'Bravo')] } as never)
    getSummary.mockResolvedValue({ servers: [], schedule: { enabled: true, serverIds: null } } as never)
    updateSettings.mockResolvedValue({ success: true } as never)
    renderIt()

    const alpha = await screen.findByRole('checkbox', { name: /Alpha/ })
    const bravo = screen.getByRole('checkbox', { name: /Bravo/ })
    expect(alpha).toBeChecked()
    expect(bravo).not.toBeChecked()

    fireEvent.click(bravo)
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ serverIds: ['a', 'b'] }))
  })

  it('says so when no server is checked, and offers nothing to a role without backups.manage', async () => {
    getAll.mockResolvedValue({ servers: [server('a', 'Alpha', { isActive: true }), server('b', 'Bravo')] } as never)
    getSummary.mockResolvedValue({ servers: [], schedule: { enabled: true, serverIds: [] } } as never)
    renderIt(false)

    expect(await screen.findByText('No server is checked, so the schedule backs up nothing.')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Alpha/ })).toBeDisabled()
  })
})
