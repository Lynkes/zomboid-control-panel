import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '../Dashboard'
import Scheduler from '../Scheduler'
import Servers from '../Servers'
import ServerConfig from '../ServerConfig'
import {
  serverApi, serversApi, playersApi, panelBridgeApi, backupApi, configApi,
  debugApi, panelUpdateApi, modsApi, schedulerApi, serversDetectApi, dockerApi,
  updateApi, serverFilesApi, type ServerInstance,
} from '@/lib/api'
import en from '../../locales/en/servers.json'

// bug-hunt-2026-09-18 (round 3, narrow-width dialog sweep): the Servers.tsx
// Edit Server dialog fix (36b94af5) was one call site outside this app's own
// max-h-[85vh] overflow-y-auto[ sm:max-h-[80vh]] convention -- god asked for
// every DialogContent/AlertDialogContent in client/src to be checked the
// same way. Measured live with Playwright at 375x667 (iPhone SE-class):
// four more genuinely overflowed the viewport with no scroll affordance --
//   - Dashboard.tsx's Wipe Server AlertDialog (830px tall; 4 checkbox rows
//     + a wipe-preview box push it well past the fold)
//   - Scheduler.tsx's New/Edit Task dialog (985px tall; the simple/advanced
//     schedule tabs plus conditional weekday/hour fields are the tallest
//     dialog in the app)
//   - Servers.tsx's Steam Update/Verify dialog (680px; a 192px log panel
//     tips it over by a few px)
//   - ServerConfig.tsx's Backups dialog (681px; a similar few-px overflow)
// All four got the exact same fix as the Edit Server dialog. (Two more --
// Settings.tsx's Confirm Apply Update AlertDialog and ServerConfig.tsx's
// Saved-Configs/Templates dialog -- measured at 632px and 665px respectively
// under realistic content and were left alone: they fit, if narrowly, so
// per the "fix only the ones that really overflow" instruction they were
// not touched.) jsdom does not compute real layout, so these tests can only
// assert the classes that produce the fix are present and that each
// dialog's own footer/primary action lives inside the same scrollable
// element -- the actual on-screen behavior (fits at 375x667, scrolls
// internally) was verified directly against a running instance with
// Playwright, not simulated here.

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

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serverApi: {
      ...actual.serverApi,
      getStatus: vi.fn(),
      getPanelInfo: vi.fn(),
      getConsoleErrorCount: vi.fn(),
    },
    serversApi: {
      ...actual.serversApi,
      getStatus: vi.fn(),
      getComposedStatus: vi.fn(),
      getResolvedActive: vi.fn(),
      getActive: vi.fn(),
      getAll: vi.fn(),
      discoverMounts: vi.fn(),
      getRconStatuses: vi.fn(),
    },
    playersApi: { ...actual.playersApi, getPlayers: vi.fn(), getActivityLogs: vi.fn() },
    panelBridgeApi: { ...actual.panelBridgeApi, getStatus: vi.fn(), getZombieCount: vi.fn(), getWorldStats: vi.fn() },
    backupApi: { ...actual.backupApi, getStatus: vi.fn() },
    configApi: { ...actual.configApi, getAppSettings: vi.fn() },
    debugApi: { ...actual.debugApi, getPerformanceHistory: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn() },
    modsApi: { ...actual.modsApi, getStatus: vi.fn() },
    schedulerApi: {
      ...actual.schedulerApi,
      getTasks: vi.fn(),
      getCronPresets: vi.fn(),
      getStatus: vi.fn(),
      getHistory: vi.fn(),
    },
    serversDetectApi: { ...actual.serversDetectApi, detect: vi.fn(), autoScan: vi.fn() },
    dockerApi: { ...actual.dockerApi, getStatus: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    serverFilesApi: {
      ...actual.serverFilesApi,
      getPaths: vi.fn(),
      getIni: vi.fn(),
      getBackups: vi.fn(),
    },
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function makeServer(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 1, name: 'Ashenwood', serverName: 'Ashenwood', installPath: 'C:/servers/ashenwood',
    zomboidDataPath: null, serverConfigPath: null, rconHost: '127.0.0.1', rconPort: 27015,
    rconPassword: 'hunter2', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
    useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
    adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z', ...overrides,
  } as ServerInstance
}

// 2026-09 dialog sweep (after the Templates preview community report): the
// dialogs below scrolled as a whole under their own 85vh/80vh caps, which
// took their primary buttons below the fold on 1280x620 and every smaller
// window. They now take the primitives' own dvh bound and scroll only a
// DialogBody/AlertDialogBody, with the buttons outside it.
function assertPinnedBody(dialog: HTMLElement, buttons: RegExp[]) {
  expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]')
  expect(dialog.className).not.toMatch(/max-h-\[85vh\]/)
  const body = dialog.querySelector<HTMLElement>(':scope > [data-dialog-body]')
  expect(body).not.toBeNull()
  for (const name of buttons) {
    const button = within(dialog).getByRole('button', { name })
    expect(dialog.contains(button)).toBe(true)
    expect(body!.contains(button)).toBe(false)
  }
  return body!
}

describe('Dashboard -- Wipe Server dialog fits a short mobile viewport', () => {
  it('scrolls only the targets and backup rows; Preview and Cancel stay on screen', async () => {
    vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server: makeServer() })
    vi.mocked(serverApi.getStatus).mockResolvedValue({
      running: false, startTime: null, uptime: 0, serverPath: 'C:/servers/ashenwood',
      serverPathConfigured: true, rcon: { host: '127.0.0.1', port: 27015, connected: false },
    } as Awaited<ReturnType<typeof serverApi.getStatus>>)
    vi.mocked(serversApi.getComposedStatus).mockRejectedValue(new Error('no composed status'))
    vi.mocked(serversApi.getStatus).mockResolvedValue({ servers: [], detectedProcesses: 0, detectionError: null })
    vi.mocked(playersApi.getPlayers).mockResolvedValue({ players: [] })
    vi.mocked(playersApi.getActivityLogs).mockResolvedValue({ logs: [] })
    vi.mocked(serverApi.getPanelInfo).mockResolvedValue({ localIp: '10.0.0.5', port: 8080, url: 'http://10.0.0.5:8080' })
    vi.mocked(serverApi.getConsoleErrorCount).mockResolvedValue({ exists: true, count: 0 })
    vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} })
    vi.mocked(backupApi.getStatus).mockResolvedValue({ lastBackup: null, backupCount: 0 })
    vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0, totalModsTracked: 0 })
    vi.mocked(schedulerApi.getTasks).mockResolvedValue({ tasks: [] })
    vi.mocked(schedulerApi.getStatus).mockResolvedValue({ nextRun: null })
    vi.mocked(debugApi.getPerformanceHistory).mockResolvedValue({ history: [] })
    vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({
      currentVersion: '1.0.0', updateAvailable: false, latestVersion: null, releaseUrl: null,
      releaseNotes: null, publishedAt: null, isChecking: false, isDownloading: false,
      downloadProgress: 0, lastCheck: null, lastError: null, stagedUpdate: null, lastApplyResult: null,
    })
    vi.mocked(panelBridgeApi.getStatus).mockResolvedValue({ configured: false, isRunning: false, modConnected: false, modStatus: null })
    vi.mocked(serversApi.discoverMounts).mockResolvedValue({ candidates: [] })
    vi.mocked(updateApi.getStatus).mockResolvedValue({})

    render(
      <MemoryRouter>
        <TooltipProvider>
          <Dashboard />
        </TooltipProvider>
      </MemoryRouter>,
    )

    const wipeButton = await screen.findByRole('button', { name: /wipe server/i })
    fireEvent.click(wipeButton)

    const dialog = await screen.findByRole('alertdialog')
    const body = assertPinnedBody(dialog, [/^preview$/i, /^cancel$/i])
    expect(body.querySelectorAll('[role="checkbox"]').length).toBe(4)
  })
})

describe('Scheduler -- New Task dialog fits a short mobile viewport', () => {
  it('scrolls only the schedule form; Create Task stays on screen', async () => {
    vi.mocked(schedulerApi.getTasks).mockResolvedValue({ tasks: [] })
    vi.mocked(schedulerApi.getCronPresets).mockResolvedValue({ presets: [] })
    vi.mocked(schedulerApi.getStatus).mockResolvedValue({ activeTasks: 0, autoRestartEnabled: false, modUpdateRestartPending: false })
    vi.mocked(schedulerApi.getHistory).mockResolvedValue({ history: [] })
    vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [] })
    vi.mocked(serverApi.getStatus).mockResolvedValue({ running: true } as Awaited<ReturnType<typeof serverApi.getStatus>>)

    render(
      <MemoryRouter>
        <TooltipProvider>
          <Scheduler />
        </TooltipProvider>
      </MemoryRouter>,
    )

    const newTaskButton = await screen.findByRole('button', { name: /new task/i })
    fireEvent.click(newTaskButton)

    const dialog = await screen.findByRole('dialog')
    const body = assertPinnedBody(dialog, [/create task/i])
    expect(body.contains(within(dialog).getByText(/task name/i))).toBe(true)
  })
})

describe('Servers -- Steam Update dialog fits a short mobile viewport', () => {
  async function openCardMenuItem(serverName: string, item: string) {
    const trigger = await screen.findByRole('button', { name: `Options for ${serverName}` })
    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByText(item))
  }
  const openUpdateDialogFor = (serverName: string) => openCardMenuItem(serverName, en.card.updateServer)

  function renderServers(server = makeServer()) {
    vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [server] })
    vi.mocked(serversApi.getStatus).mockResolvedValue({ servers: [] })
    vi.mocked(serversApi.getRconStatuses).mockResolvedValue({ servers: [] })
    vi.mocked(serversApi.discoverMounts).mockResolvedValue({ mounts: [] })
    vi.mocked(dockerApi.getStatus).mockResolvedValue({ enabled: false, available: false, containers: [] })
    vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} })
    vi.mocked(updateApi.getStatus).mockResolvedValue({})
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Servers />
        </TooltipProvider>
      </MemoryRouter>,
    )
  }

  // 2026-09 dialog sweep: an install or data path with no break point
  // widened the Remove from Panel confirm past a phone screen (the grid half
  // is AlertDialogContent's own column template) and, with "Also delete
  // server files" and the nested data-path warning, it outgrew a landscape
  // phone. The paths break anywhere and the description scrolls in a body.
  it('Remove from Panel: paths break anywhere, and the description scrolls under the pinned title and buttons', async () => {
    const installPath = 'D:\\Games\\ProjectZomboid\\DedicatedServers\\KnoxCountrySurvivors_B42'
    renderServers(makeServer({ installPath, zomboidDataPath: `${installPath}\\Zomboid` }))
    await openCardMenuItem('Ashenwood', en.card.removeFromPanel)
    const dialog = await screen.findByRole('alertdialog')
    const body = assertPinnedBody(dialog, [/remove from panel/i, /^cancel$/i])
    expect(body.contains(within(dialog).getByText(installPath))).toBe(true)
    expect(within(dialog).getByText(installPath).className).toContain('break-all')
    expect(body.contains(within(dialog).getByRole('heading', { name: en.deleteDialog.title }))).toBe(false)
  })

  it('Clear Installation Folder: the install path breaks anywhere', async () => {
    const installPath = 'C:\\Users\\Administrator\\Desktop\\ProjectZomboidServer'
    renderServers(makeServer({ installPath }))
    await openUpdateDialogFor('Ashenwood')
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: en.steamDialog.clearFolderButton }))
    const confirm = await screen.findByRole('alertdialog')
    const code = confirm.querySelector('code')!
    expect(code.className).toContain('break-all')
  })

  it('scrolls only the path/branch/log content; Start Update and Cancel stay on screen', async () => {
    vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [makeServer()] })
    vi.mocked(serversApi.getStatus).mockResolvedValue({ servers: [] })
    vi.mocked(serversApi.getRconStatuses).mockResolvedValue({ servers: [] })
    vi.mocked(serversApi.discoverMounts).mockResolvedValue({ mounts: [] })
    vi.mocked(dockerApi.getStatus).mockResolvedValue({ enabled: false, available: false, containers: [] })
    vi.mocked(configApi.getAppSettings).mockResolvedValue({ settings: {} })
    vi.mocked(updateApi.getStatus).mockResolvedValue({})

    render(
      <MemoryRouter>
        <TooltipProvider>
          <Servers />
        </TooltipProvider>
      </MemoryRouter>,
    )

    await openUpdateDialogFor('Ashenwood')

    const dialog = await screen.findByRole('dialog')
    const body = assertPinnedBody(dialog, [/start update/i, /^cancel$/i])
    expect(body.contains(within(dialog).getByText(/steamcmd path/i))).toBe(true)
  })
})

describe('ServerConfig -- Backups dialog fits a short mobile viewport', () => {
  it('caps height and keeps the backup list inside the scrollable dialog', async () => {
    vi.mocked(serversApi.getResolvedActive).mockResolvedValue({
      server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
    })
    vi.mocked(serverFilesApi.getPaths).mockResolvedValue({
      exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
    } as never)
    vi.mocked(serverFilesApi.getIni).mockResolvedValue({
      settings: { PVP: 'false' }, path: '/a', serverName: 'servera',
    } as never)
    vi.mocked(serversApi.getActive).mockResolvedValue({ server: null } as never)
    vi.mocked(serverFilesApi.getBackups).mockResolvedValue({
      backups: Array.from({ length: 8 }, (_, i) => ({
        filename: `ini-backup-${i}.zip`, type: 'ini', size: 1024 * (i + 1), created: '2026-01-01T00:00:00.000Z',
      })) as never,
      path: '/backups',
    })

    render(
      <MemoryRouter>
        <ServerConfig />
      </MemoryRouter>,
    )
    await waitFor(() => expect(serverFilesApi.getIni).toHaveBeenCalled())

    const backupsButton = await screen.findByRole('button', { name: /^backups$/i })
    fireEvent.click(backupsButton)

    const dialog = await screen.findByRole('dialog')
    // 2026-09 dialog viewport sweep: this dialog is now a flex column whose
    // backup list shrinks (ServerConfig.listDialogsPinnedFooter.test.tsx),
    // and its own 85vh/80vh cap gave way to DialogContent's dvh bound -- in
    // a column a lower cap only took rows off the list. Same guarantee:
    // bounded to the viewport, and whatever doesn't fit scrolls.
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]')
    expect(dialog.className).toMatch(/overflow-y-auto/)
    const firstBackupRow = within(dialog).getByText(/ini-backup-0\.zip/)
    expect(dialog.contains(firstBackupRow)).toBe(true)
  })
})
