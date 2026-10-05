import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import Backups from '../Backups'
import { backupApi, serversApi, type BackupStatus } from '@/lib/api'

// Security sweep W2: backup:progress, restore:progress and restore:finished
// used to go to every socket; the server now sends them only to sockets in
// the "backups" room, which a socket joins with subscribe:backups (refused
// for a role without a backup capability, server/index.js). The page has to
// ask, on mount and again after every reconnect (a reconnect is a new
// server-side socket, in no rooms), or its progress card never moves.

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

const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: () => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: () => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))

const testStatus: BackupStatus = {
  enabled: true, schedule: '0 */6 * * *', maxBackups: 10, includeDb: true,
  backupInProgress: false, restoreInProgress: false, lastBackup: null,
  backupCount: 0, savesPath: '/saves', backupsPath: '/backups', savesExists: true,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

describe('Backups.tsx: joins the backups room', () => {
  it('asks for backup/restore progress on mount and again after a reconnect', async () => {
    vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server: { id: 1, name: 'Ashenwood' } as never })
    vi.mocked(backupApi.getStatus).mockResolvedValue(testStatus)
    vi.mocked(backupApi.listBackups).mockResolvedValue({ backups: [] })
    vi.mocked(backupApi.getHistory).mockResolvedValue({ records: [] })

    render(
      <TooltipProvider>
        <Backups />
      </TooltipProvider>,
    )
    const subscribes = () => fakeSocket.emit.mock.calls.filter(([event]) => event === 'subscribe:backups').length
    await waitFor(() => expect(subscribes()).toBe(1))

    act(() => { socketHandlers.get('connect')?.forEach((handler) => handler()) })
    expect(subscribes()).toBe(2)
  })
})
