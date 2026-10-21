import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { UnsavedChangesProvider } from '@/contexts/UnsavedChangesContext'
import { panelBridgeApi, serverApi, serverFilesApi, serversApi } from '@/lib/api'
import { INI_CATEGORIES, getIniCategoryLabel } from '@/lib/serverConfigSchema'
import en from '../../locales/en/serverconfig.json'

// UX restructure, slice B (Server Configuration): the open tab lives in the
// URL, the header's "More" menu reaches the related pages, the category
// rail becomes a select on a phone, Spawn Regions edits are unsaved changes
// like any other (SaveBar, Discard), and leaving a dirty page asks first.

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

vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ on: () => {}, off: () => {} }),
}))

const getResolvedActive = vi.spyOn(serversApi, 'getResolvedActive')
const getActive = vi.spyOn(serversApi, 'getActive')
const getStatus = vi.spyOn(serverApi, 'getStatus')
const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getIni = vi.spyOn(serverFilesApi, 'getIni')
const getSpawnRegions = vi.spyOn(serverFilesApi, 'getSpawnRegions')
const saveSpawnRegions = vi.spyOn(serverFilesApi, 'saveSpawnRegions')
const getTemplates = vi.spyOn(serverFilesApi, 'getTemplates')
const getBackups = vi.spyOn(serverFilesApi, 'getBackups')
const sendCommand = vi.spyOn(panelBridgeApi, 'sendCommand')
const getDelivery = vi.spyOn(panelBridgeApi, 'getDelivery')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

function mockLoads() {
  getResolvedActive.mockResolvedValue({
    server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
  })
  getActive.mockResolvedValue({ server: { id: 1, isRemote: false } } as never)
  getStatus.mockResolvedValue({ running: false } as never)
  getPaths.mockResolvedValue({
    configPath: '/zomboid/Server',
    serverName: 'servera',
    exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: true },
  } as never)
  getIni.mockResolvedValue({ settings: { PVP: 'false' }, path: '/a', serverName: 'servera' } as never)
  getSpawnRegions.mockResolvedValue({ spawnregions: [{ name: 'Riverside', file: 'media/maps/Riverside' }], path: '/a' } as never)
  saveSpawnRegions.mockResolvedValue({ success: true } as never)
  getTemplates.mockResolvedValue({ templates: [] } as never)
  getBackups.mockResolvedValue({ backups: [], path: '/backups' } as never)
  sendCommand.mockRejectedValue(new Error('bridge unreachable'))
  getDelivery.mockRejectedValue(new Error('no delivery status'))
}

function LocationDisplay() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname + location.search}</output>
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TooltipProvider>
        <ConfirmProvider>
          <UnsavedChangesProvider>
            <LocationDisplay />
            <Routes>
              <Route
                path="/server-config"
                element={
                  <>
                    <Link to="/players">Go to Players</Link>
                    <ServerConfig />
                  </>
                }
              />
              <Route path="/players" element={<p>Players page</p>} />
              <Route path="/templates" element={<p>Templates page</p>} />
              <Route path="/files" element={<p>Files page</p>} />
            </Routes>
          </UnsavedChangesProvider>
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

const location = () => screen.getByTestId('location').textContent ?? ''

async function openMoreMenu() {
  fireEvent.pointerDown(await screen.findByRole('button', { name: en.pageHeader.more }), { button: 0, ctrlKey: false })
  return screen.findByRole('menu')
}

describe('Server Configuration: URL state', () => {
  it('writes the open tab to ?tab= so a reload or a link opens it again', async () => {
    mockLoads()
    renderAt('/server-config')
    await waitFor(() => expect(getIni).toHaveBeenCalled())

    fireEvent.mouseDown(await screen.findByRole('tab', { name: /spawn regions/i }), { button: 0 })
    await waitFor(() => expect(location()).toContain('tab=spawnregions'))
    expect(screen.getByRole('tab', { name: /spawn regions/i })).toHaveAttribute('aria-selected', 'true')
  })

  it('a deep link to a later tab scrolls the phone tab strip so that tab is in sight', async () => {
    mockLoads()
    // jsdom has no layout: the strip is 300px wide and every tab sits 400px
    // in, i.e. past its right edge, as on a 390px phone.
    const scrollBy = vi.fn()
    const rect = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 40, width, height: 40, x: left, y: 0, toJSON: () => ({}) })
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.getAttribute('role') === 'tablist' ? rect(0, 300) : rect(400, 120)) as DOMRect
    })
    // An own property on HTMLElement.prototype, removed afterwards (jsdom's
    // own scrollBy, if any, lives further up the chain and is untouched).
    Object.defineProperty(HTMLElement.prototype, 'scrollBy', { value: scrollBy, configurable: true, writable: true })
    try {
      renderAt('/server-config?tab=spawnregions')
      expect(await screen.findByRole('tab', { name: /spawn regions/i })).toHaveAttribute('aria-selected', 'true')
      await waitFor(() => expect(scrollBy).toHaveBeenCalledWith({ left: 400 + 120 - 300 + 8 }))
    } finally {
      rectSpy.mockRestore()
      delete (HTMLElement.prototype as { scrollBy?: unknown }).scrollBy
    }
  })

  it('?open=snapshots opens the Config snapshots dialog, then drops the parameter', async () => {
    mockLoads()
    renderAt('/server-config?tab=ini&open=snapshots')

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: en.templatesDialog.title })).toBeInTheDocument()
    expect(getTemplates).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(location()).not.toContain('open='))
    expect(location()).toContain('tab=ini')
  })
})

describe('Server Configuration: header', () => {
  it('"More" holds the config file backups, Templates and the config folder in Server Files', async () => {
    mockLoads()
    renderAt('/server-config')
    await waitFor(() => expect(getIni).toHaveBeenCalled())

    let menu = await openMoreMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: en.pageHeader.backups }))
    expect(await screen.findByRole('dialog')).toHaveTextContent(en.backupsDialog.title)
    expect(getBackups).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    menu = await openMoreMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: en.pageHeader.openInFiles }))
    await waitFor(() => expect(location()).toBe('/files?root=data&path=Server'))
  })

  it('"More" › Templates opens the Templates page', async () => {
    mockLoads()
    renderAt('/server-config')
    await waitFor(() => expect(getIni).toHaveBeenCalled())

    const menu = await openMoreMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: en.pageHeader.templatesPage }))
    expect(await screen.findByText('Templates page')).toBeInTheDocument()
  })

  it('the unresolved Mods= review links to the Mods page\'s active list', async () => {
    mockLoads()
    renderAt('/server-config?tab=ini&unresolved=FooMod')
    await screen.findByText(en.unresolvedReview.title)
    expect(screen.getByRole('link', { name: en.unresolvedReview.openActiveMods })).toHaveAttribute('href', '/mods?view=active')
  })
})

describe('Server Configuration: category rail', () => {
  it('below lg the INI categories are one select, so every category stays reachable on a phone', async () => {
    mockLoads()
    renderAt('/server-config?tab=ini')
    await waitFor(() => expect(getIni).toHaveBeenCalled())

    const select = await screen.findByRole('combobox', { name: en.categoriesNav.iniAria })
    // Every category is an option (none hidden behind a collapsed group).
    for (const category of INI_CATEGORIES) {
      expect(within(select).getByRole('option', { name: getIniCategoryLabel(category) })).toBeInTheDocument()
    }
    const target = INI_CATEGORIES[1]
    fireEvent.change(select, { target: { value: target.id } })
    expect(await screen.findByRole('heading', { name: getIniCategoryLabel(target) })).toBeInTheDocument()
  })
})

describe('Server Configuration: Spawn Regions edits are unsaved changes', () => {
  it('shows the SaveBar with Discard, and saving clears it', async () => {
    mockLoads()
    renderAt('/server-config?tab=spawnregions')

    const name = await screen.findByDisplayValue('Riverside')
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument()

    fireEvent.change(name, { target: { value: 'Riverside West' } })
    expect(await screen.findByText('Unsaved changes: 1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(await screen.findByDisplayValue('Riverside')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument())

    fireEvent.change(screen.getByDisplayValue('Riverside'), { target: { value: 'Riverside West' } })
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /^save$/i })) })
    await waitFor(() => expect(saveSpawnRegions).toHaveBeenCalledWith([{ name: 'Riverside West', file: 'media/maps/Riverside' }]))
    await waitFor(() => expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument())
  })
})

describe('Server Configuration: leaving with unsaved edits', () => {
  it('a link to another page asks first, and only leaves when told to', async () => {
    mockLoads()
    renderAt('/server-config?tab=spawnregions')

    fireEvent.change(await screen.findByDisplayValue('Riverside'), { target: { value: 'Riverside West' } })
    await screen.findByText('Unsaved changes: 1')

    fireEvent.click(screen.getByRole('link', { name: 'Go to Players' }))
    const ask = await screen.findByRole('alertdialog')
    expect(ask).toHaveTextContent('Leave without saving?')
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.queryByText('Players page')).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('Riverside West')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('link', { name: 'Go to Players' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard and leave' }))
    expect(await screen.findByText('Players page')).toBeInTheDocument()
  })
})
