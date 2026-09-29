import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Servers from '../Servers'
import { serversApi, serversDetectApi, dockerApi, configApi, updateApi } from '@/lib/api'
import en from '../../locales/en/servers.json'

// bug-hunt-2026-09-18 (narrow-width sweep, round 2): the Edit Server dialog
// (DialogContent at "max-w-lg", no height bound) renders every field on this
// server -- display name, docker container, install/data paths, an optional
// lifecycle-provider block, custom start command, RCON host/port/password,
// admin password, game port, min/max memory -- well past 1500px tall.
// dialog.tsx's own DialogContent has no default max-height/overflow (unlike
// several OTHER dialogs in this app -- Mods.tsx, RolesPermissions.tsx,
// Settings.tsx, ConflictsPanel.tsx, TemplatePreviewDialog.tsx -- which all
// opt into `max-h-[85vh] overflow-y-auto`), so on a real short mobile
// viewport (verified with Playwright at 375x667, iPhone SE-class) the fixed,
// vertically-centered dialog ran off BOTH the top and bottom of the screen
// with no scroll affordance at all: the title was cut off above the fold,
// and the Save Changes / Cancel buttons sat ~340px below the bottom of the
// viewport -- completely unreachable, not just scrolled out of view. Fixed
// by applying the same max-h-[85vh] overflow-y-auto sm:max-h-[80vh] pattern
// this app already uses elsewhere for exactly this problem (Servers.tsx's
// own sibling Add-Remote-Server dialog already carries max-h-[90vh]
// overflow-y-auto). jsdom does not compute real layout, so this test can
// only assert the classes that produce the fix are present -- the actual
// on-screen behavior (dialog fits, Save Changes reachable via internal
// scroll at 375x667) was verified directly against a running instance with
// Playwright, not simulated here.
//
// 2026-09 community report ("the edit menu can't be scrolled, I have to
// change the page zoom to see all of it", Linux host, so the
// lifecycle-provider block was showing): the viewport bound moved into
// dialog.tsx's DialogContent itself (max-h-[calc(100dvh-2rem)]
// overflow-y-auto) so no dialog depends on a per-call-site cap any more,
// and this dialog's fields now sit in a DialogBody -- the only scrolling
// region -- so the title and Save/Cancel stay on screen instead of
// scrolling away with the form. Same jsdom limit as above: these tests pin
// the structure that produces that layout (which element scrolls, and that
// the footer is NOT inside it); the rendered result was measured separately
// in headless Chromium at 1366x768, 1280x720 and 375x667, at 100/125/150%
// zoom.
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
      update: vi.fn(),
    },
    serversDetectApi: {
      ...actual.serversDetectApi,
      detect: vi.fn(),
      autoScan: vi.fn(),
    },
    dockerApi: {
      ...actual.dockerApi,
      getStatus: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn(),
    },
    updateApi: {
      ...actual.updateApi,
      getStatus: vi.fn(),
    },
  }
})

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

const getAll = vi.mocked(serversApi.getAll)
const getStatus = vi.mocked(serversApi.getStatus)
const getRconStatuses = vi.mocked(serversApi.getRconStatuses)
const discoverMounts = vi.mocked(serversApi.discoverMounts)
const dockerGetStatus = vi.mocked(dockerApi.getStatus)
const getAppSettings = vi.mocked(configApi.getAppSettings)
const updateGetStatus = vi.mocked(updateApi.getStatus)

const SERVER_ONE = {
  id: 1,
  name: 'Server One',
  serverName: 'server-one',
  installPath: '',
  zomboidDataPath: null,
  serverConfigPath: null,
  rconHost: '192.168.1.50',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
  isRemote: true,
  isActive: false,
  startCommand: '',
  adminPassword: '',
  createdAt: new Date(0).toISOString(),
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

// Radix's DropdownMenuTrigger opens on pointerdown, not click -- same quirk
// documented in Servers.duplicateRemoteServerEdit.test.tsx's identical helper.
async function openEditDialogFor(serverName: string) {
  const trigger = await screen.findByRole('button', { name: `Options for ${serverName}` })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByText(en.card.edit))
  await screen.findByRole('heading', { name: en.editDialog.title })
}

beforeEach(() => {
  getAll.mockReset().mockResolvedValue({ servers: [SERVER_ONE] } as never)
  getStatus.mockReset().mockResolvedValue({ servers: [] } as never)
  getRconStatuses.mockReset().mockResolvedValue({ servers: [] } as never)
  discoverMounts.mockReset().mockResolvedValue({ mounts: [] } as never)
  dockerGetStatus.mockReset().mockResolvedValue({ enabled: false, available: false, containers: [] } as never)
  getAppSettings.mockReset().mockResolvedValue({ settings: {} } as never)
  updateGetStatus.mockReset().mockResolvedValue({} as never)
})

// A local server on a host that supports managed lifecycle providers renders
// the tallest version of this form -- the exact one in the report's
// screenshot (data path, the Lifecycle Provider block with its amber
// "Managed services are opt-in" notice, custom start command, Launch without
// Steam, then RCON/admin password/ports/memory below the fold).
const LOCAL_SERVER = {
  ...(SERVER_ONE as object),
  id: 2,
  name: 'Server Two',
  serverName: 'server-two',
  installPath: '/opt/pzserver',
  zomboidDataPath: '/home/pz/Zomboid',
  rconHost: '127.0.0.1',
  isRemote: false,
  lifecycleProvider: 'direct',
} as never

// The dialog's one scrolling region. It has to be a DIRECT child of the
// dialog element: DialogContent's has-[>[data-dialog-body]] classes only turn
// the dialog into the flex column that lets it shrink when it is.
function getScrollBody(dialog: HTMLElement) {
  const body = dialog.querySelector<HTMLElement>('[data-dialog-body]')
  expect(body).not.toBeNull()
  expect(body!.parentElement).toBe(dialog)
  expect(body!.className).toMatch(/overflow-y-auto/)
  expect(body!.className).toMatch(/min-h-0/)
  return body!
}

function expectFooterAndTitleOutside(
  dialog: HTMLElement,
  body: HTMLElement,
  buttons: string[] = [en.editDialog.saveChanges, en.editDialog.cancel],
  title: string = en.editDialog.title,
) {
  // Inside the dialog, outside the scrolling body: these stay on screen
  // however far the fields are scrolled, instead of scrolling away with them.
  for (const name of buttons) {
    const button = within(dialog).getByRole('button', { name: new RegExp(`^${name}$`) })
    expect(body.contains(button)).toBe(false)
  }
  const heading = within(dialog).getByRole('heading', { name: title })
  expect(body.contains(heading)).toBe(false)
}

// Every copy of the text inside the dialog (a label can also appear in a
// HelpTip's accessible name) must be in the scrolling body.
function expectAllInside(dialog: HTMLElement, body: HTMLElement, text: string) {
  const matches = within(dialog).getAllByText(text)
  for (const match of matches) expect(body.contains(match)).toBe(true)
}

describe('Servers -- Edit Server dialog fits a short or zoomed-in viewport', () => {
  it('is bounded to the viewport by DialogContent and scrolls only its fields, keeping the title and Save/Cancel outside the scrolling body', async () => {
    renderServers()
    await openEditDialogFor('Server One')

    const dialog = screen.getByRole('dialog')
    // The shared dvh bound from dialog.tsx, not replaced by a call-site cap.
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]')
    expect(dialog.className).toMatch(/overflow-y-auto/)
    expect(dialog.className).toContain('has-[>[data-dialog-body]]:flex')
    expect(dialog.className).toContain('has-[>[data-dialog-body]]:flex-col')

    const body = getScrollBody(dialog)
    expectAllInside(dialog, body, en.editDialog.displayNameLabel)
    expectAllInside(dialog, body, en.editDialog.gamePortLabel)
    expectFooterAndTitleOutside(dialog, body)
  })

  it('keeps every field of the tall local-server form (lifecycle provider block included) inside the scrolling body', async () => {
    getAll.mockResolvedValue({ servers: [LOCAL_SERVER], lifecycleCapabilities: { supported: true } } as never)
    renderServers()
    await openEditDialogFor('Server Two')

    const dialog = screen.getByRole('dialog')
    const body = getScrollBody(dialog)
    for (const label of [
      en.editDialog.displayNameLabel,
      en.editDialog.dataPathLabel,
      en.editDialog.lifecycleProviderLabel,
      en.editDialog.lifecycleMigrationWarning,
      en.editDialog.customStartCommandLabel,
      en.editDialog.noSteamLabel,
      en.editDialog.rconPortLabel,
      en.editDialog.maxMemoryLabel,
    ]) {
      expectAllInside(dialog, body, label)
    }
    expectFooterAndTitleOutside(dialog, body)
  })
})

// The sibling Add Existing / Add Remote Server dialog is the same form
// family on the same page and used to scroll as one box under its own
// max-h-[90vh] -- its title and Add Server button scrolled away with the
// fields, the opposite of Edit. It now uses the same DialogBody layout.
async function openAddDialog(trigger: string, heading: string) {
  fireEvent.click(await screen.findByRole('button', { name: trigger }))
  await screen.findByRole('heading', { name: heading })
}

describe('Servers -- Add Existing/Remote Server dialog scrolls only its form, like Edit', () => {
  it('local mode: the tandem notes, local/remote switch and fields are in the scrolling body; the title and Cancel/Add Server are not', async () => {
    // A local server already exists, so the tandem-install notes render too.
    getAll.mockResolvedValue({ servers: [LOCAL_SERVER] } as never)
    renderServers()
    await openAddDialog(en.pageHeader.addExisting, en.addDialog.titleLocal)

    const dialog = screen.getByRole('dialog')
    // The shared dvh bound, no longer replaced by the dialog's own 90vh.
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]')
    expect(dialog.className).not.toContain('max-h-[90vh]')

    const body = getScrollBody(dialog)
    for (const text of [
      en.tandem.sectionTitle,
      en.addDialog.modeLocalTitle,
      en.addDialog.modeRemoteTitle,
      en.localForm.autoDetectTitle,
      en.localForm.dataPathLabel,
      en.localForm.installPathLabel,
    ]) {
      expectAllInside(dialog, body, text)
    }
    expectFooterAndTitleOutside(dialog, body, [en.addDialog.cancel, en.addDialog.addServer], en.addDialog.titleLocal)
  })

  it('remote mode: the RCON-only banner and remote fields are in the scrolling body; the title and Cancel/Add Server are not', async () => {
    renderServers()
    await openAddDialog(en.pageHeader.addRemote, en.addDialog.titleRemote)

    const dialog = screen.getByRole('dialog')
    const body = getScrollBody(dialog)
    for (const text of [
      en.addDialog.rconOnlyTitle,
      en.remoteForm.displayNameLabel,
      en.remoteForm.rconPasswordLabel,
      en.remoteForm.gamePortLabel,
    ]) {
      expectAllInside(dialog, body, text)
    }
    expectFooterAndTitleOutside(dialog, body, [en.addDialog.cancel, en.addDialog.addServer], en.addDialog.titleRemote)
  })
})
