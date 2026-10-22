import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, serversDetectApi, dockerApi, configApi, updateApi, serverApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// Quick Setup reuses the active server's install folder on purpose, so two
// profiles can share one game folder. "Delete Everything" and "Clear
// Folder" on one of them used to say nothing about the other, and the server
// deleted the folder even while the other one ran. Both confirmations now
// list the other profiles, and the request says the operator saw them
// (confirmShared); the server refuses while any of them runs.

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
    serversApi: {
      ...actual.serversApi,
      getAll: vi.fn(),
      getStatus: vi.fn(),
      getRconStatuses: vi.fn(),
      discoverMounts: vi.fn(),
      delete: vi.fn(),
      steamUpdate: vi.fn(),
    },
    serversDetectApi: { ...actual.serversDetectApi, deleteFiles: vi.fn() },
    dockerApi: { ...actual.dockerApi, getStatus: vi.fn(), getStats: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn(), updateAppSettings: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    serverApi: { ...actual.serverApi, detectSteamCmd: vi.fn(), getBranches: vi.fn() },
  }
})

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const getAll = vi.mocked(serversApi.getAll)
const del = vi.mocked(serversApi.delete)
const deleteFiles = vi.mocked(serversDetectApi.deleteFiles)

const base = {
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  isActive: false,
  startCommand: '',
  adminPassword: '',
  createdAt: new Date(0).toISOString(),
}
const ALPHA = {
  ...base,
  id: 1,
  name: 'alpha',
  serverName: 'alpha-cfg',
  installPath: '/srv/pz',
  zomboidDataPath: '/srv/pz_Data',
} as never
// Same game folder, written with a trailing slash.
const BRAVO = {
  ...base,
  id: 2,
  name: 'bravo',
  serverName: 'bravo-cfg',
  installPath: '/srv/pz/',
  zomboidDataPath: '/srv/bravo_Data',
} as never
const CHARLIE = {
  ...base,
  id: 3,
  name: 'charlie',
  serverName: 'charlie-cfg',
  installPath: '/srv/other',
  zomboidDataPath: '/srv/other_Data',
} as never

function renderServers() {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={null}>
        <TooltipProvider>
          <ConfirmProvider>
            <Servers />
          </ConfirmProvider>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

function setUpFixtures(servers: unknown[]) {
  getAll.mockResolvedValue({ servers } as never)
  vi.mocked(serversApi.getStatus).mockResolvedValue({ servers: [] } as never)
  vi.mocked(serversApi.getRconStatuses).mockResolvedValue({ servers: [] } as never)
  vi.mocked(serversApi.discoverMounts).mockResolvedValue({ mounts: [] } as never)
  vi.mocked(dockerApi.getStatus).mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  vi.mocked(dockerApi.getStats).mockResolvedValue({ containers: {} } as never)
  vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: { steamcmdPath: '/opt/steamcmd' } } as never)
  vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)
  vi.mocked(serverApi.detectSteamCmd).mockResolvedValue({ found: false, path: null } as never)
  vi.mocked(serverApi.getBranches).mockResolvedValue({ branches: [] } as never)
  del.mockResolvedValue({} as never)
  deleteFiles.mockResolvedValue({} as never)
}

async function openCardMenu(serverName: string) {
  const trigger = await screen.findByRole('button', { name: new RegExp(`options for ${serverName}`, 'i') })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  return screen.findByRole('menu')
}

async function openDeleteEverything(serverName: string) {
  const menu = await openCardMenu(serverName)
  fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.removeFromPanel }))
  await screen.findByRole('heading', { name: en.deleteDialog.title })
  fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(en.deleteDialog.alsoDeleteFilesLabel) }))
}

const sharedDesc = (names: string) => en.sharedInstallWarning.desc.replace('{{names}}', names)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Servers.tsx: another profile uses the same game folder', () => {
  it('Delete Everything lists the other profile and sends confirmShared', async () => {
    setUpFixtures([ALPHA, BRAVO, CHARLIE])
    renderServers()
    await screen.findByText('alpha')

    await openDeleteEverything('alpha')
    expect(screen.getByText(en.sharedInstallWarning.title)).toBeInTheDocument()
    // Only bravo shares the folder (charlie's is another one).
    expect(screen.getByText(sharedDesc('bravo'))).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: en.deleteDialog.deleteEverything }))
    await waitFor(() => expect(deleteFiles).toHaveBeenCalledWith('/srv/pz', { confirmShared: true }))
  })

  it('a folder nobody else uses shows no warning and does not send confirmShared', async () => {
    setUpFixtures([ALPHA, CHARLIE])
    renderServers()
    await screen.findByText('alpha')

    await openDeleteEverything('alpha')
    expect(screen.queryByText(en.sharedInstallWarning.title)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: en.deleteDialog.deleteEverything }))
    await waitFor(() => expect(deleteFiles).toHaveBeenCalledWith('/srv/pz', { confirmShared: false }))
  })

  it('Clear Folder lists the other profile and sends confirmShared', async () => {
    setUpFixtures([ALPHA, BRAVO])
    renderServers()
    await screen.findByText('alpha')

    const menu = await openCardMenu('alpha')
    fireEvent.click(within(menu).getByRole('menuitem', { name: en.card.updateServer }))
    await screen.findByRole('heading', { name: en.steamDialog.updateTitle })
    fireEvent.click(screen.getByRole('button', { name: en.steamDialog.clearFolderButton }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(en.sharedInstallWarning.title)).toBeInTheDocument()
    expect(within(dialog).getByText(sharedDesc('bravo'))).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: en.clearInstallDialog.clearFolder }))
    await waitFor(() => expect(deleteFiles).toHaveBeenCalledWith('/srv/pz', { confirmShared: true }))
  })
})
