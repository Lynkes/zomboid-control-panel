import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { UnsavedChangesProvider, useUnsavedChangesGuard } from '@/contexts/UnsavedChangesContext'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'

// The shell around every page (UX plan §2.1, §2.7, §2.8): the "Search…"
// button and Ctrl/Cmd+K open the command palette, the lit row scrolls into
// view, the icon rail names rows by their full title, the tab title says
// page and server, the phone top bar shows where you are, and leaving a
// page with unsaved edits asks first from the sidebar and shortcuts too.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: false,
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
    serversApi: { ...actual.serversApi, getAll: vi.fn(), activate: vi.fn() },
    serverApi: { ...actual.serverApi, getStatus: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    modsApi: { ...actual.modsApi, getStatus: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn() },
  }
})

const SERVER = {
  id: 1, name: 'Knox', isRemote: false, isActive: true,
} as never
const OTHER = {
  id: 2, name: 'Rosewood', isRemote: false, isActive: false,
} as never

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

function Dirty() {
  useUnsavedChangesGuard(true)
  return null
}

function renderShell(at = '/', { dirty = false } = {}) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <ConfirmProvider>
        <UnsavedChangesProvider>
          <SocketContext.Provider value={null}>
            <Layout>
              {dirty && <Dirty />}
              <Where />
            </Layout>
          </SocketContext.Provider>
        </UnsavedChangesProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  )
}

function stubViewport({ lg }: { lg: boolean }) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 1024px)' ? lg : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

const where = () => screen.getByTestId('where').textContent
const mainNav = () => screen.getByRole('navigation', { name: 'Main navigation' })
let scrolled: Element[] = []
const originalScrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [SERVER, OTHER] } as never)
  vi.mocked(serversApi.activate).mockResolvedValue({} as never)
  vi.mocked(serverApi.getStatus).mockResolvedValue({ running: true } as never)
  vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)
  vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0 } as never)
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({ updateAvailable: false } as never)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.2.19' }) })))
  scrolled = []
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this) }
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  Element.prototype.scrollIntoView = originalScrollIntoView
})

describe('Layout: command palette', () => {
  it('opens from the sidebar\'s Search button', async () => {
    renderShell()
    await screen.findByText('Knox')
    fireEvent.click(screen.getByRole('button', { name: 'Search pages and sections' }))
    expect(await screen.findByRole('combobox', { name: 'Search pages, sections and servers' })).toBeInTheDocument()
  })

  it('opens and closes with Ctrl+K, and goes where you pick', async () => {
    renderShell()
    await screen.findByText('Knox')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const input = await screen.findByRole('combobox', { name: 'Search pages, sections and servers' })
    fireEvent.change(input, { target: { value: 'discord' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(where()).toBe('/discord'))
    expect(screen.queryByRole('combobox', { name: 'Search pages, sections and servers' })).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(await screen.findByRole('combobox', { name: 'Search pages, sections and servers' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Search pages, sections and servers' })).not.toBeInTheDocument())
  })

  it('switches the active server from the palette', async () => {
    renderShell()
    await screen.findByText('Knox')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const input = await screen.findByRole('combobox', { name: 'Search pages, sections and servers' })
    fireEvent.change(input, { target: { value: 'rosewood' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(serversApi.activate).toHaveBeenCalledWith(2))
  })
})

describe('Layout: sidebar behaviour', () => {
  it('scrolls the lit row into view after each route change', async () => {
    renderShell('/debug')
    await screen.findByText('Knox')
    const diagnostics = within(mainNav()).getByRole('link', { name: 'Diagnostics' })
    await waitFor(() => expect(scrolled).toContain(diagnostics))

    fireEvent.click(within(mainNav()).getByRole('link', { name: 'Public Servers' }))
    const publicServers = within(mainNav()).getByRole('link', { name: 'Public Servers' })
    await waitFor(() => expect(scrolled).toContain(publicServers))
  })

  it('names icon-rail rows by the page\'s full title, in the name and the tooltip', async () => {
    localStorage.setItem('sidebarCollapsed', 'true')
    renderShell()
    await waitFor(() => expect(within(mainNav()).getByRole('link', { name: 'Server Configuration' })).toBeInTheDocument())
    const config = within(mainNav()).getByRole('link', { name: 'Server Configuration' })
    expect(config).toHaveAttribute('href', '/server-config')
    fireEvent.focus(config)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Server Configuration')
    expect(screen.getByRole('button', { name: 'Search pages and sections' })).toBeInTheDocument()
  })

  it('offers "Add a server…" in the active-server menu', async () => {
    renderShell('/players')
    await screen.findByText('Knox')
    fireEvent.pointerDown(screen.getByText('Knox').closest('button')!, { button: 0, ctrlKey: false })
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add a server…' }))
    await waitFor(() => expect(where()).toBe('/server-setup'))
  })

  it('titles the browser tab "Page · Server · Zomboid Control Panel"', async () => {
    renderShell('/server-config')
    await screen.findByText('Knox')
    await waitFor(() => expect(document.title).toBe('Server Configuration · Knox · Zomboid Control Panel'))
  })
})

describe('Layout: phone', () => {
  it('shows the current page and the active server in the top bar, and starts the drawer with Search', async () => {
    stubViewport({ lg: false })
    renderShell('/server-config')
    await waitFor(() => expect(screen.getByTestId('mobile-page-title')).toHaveTextContent('Server Configuration'))
    await waitFor(() => expect(screen.getAllByText('Knox').length).toBeGreaterThan(0))
    const search = screen.getByRole('button', { name: 'Search pages and sections' })
    const strip = screen.getAllByText('Knox').map((el) => el.closest('button')).find(Boolean)!
    expect(search.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('Layout: unsaved changes', () => {
  it('asks before a sidebar row leaves a page with unsaved edits', async () => {
    renderShell('/settings', { dirty: true })
    await screen.findByText('Knox')
    fireEvent.click(within(mainNav()).getByRole('link', { name: 'Servers' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Leave without saving?')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    await act(async () => {})
    expect(where()).toBe('/settings')
  })

  it('asks before a digit shortcut leaves it too', async () => {
    renderShell('/settings', { dirty: true })
    await screen.findByText('Knox')
    fireEvent.keyDown(window, { key: '2' })
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard and leave' }))
    await waitFor(() => expect(where()).toBe('/console'))
  })
})
