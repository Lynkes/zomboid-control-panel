import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { ApiError, configApi, rconApi, serversApi, type ServerInstance } from '@/lib/api'
import enConsole from '../../locales/en/console.json'

// UX restructure (slice B): the Console keeps its tab in ?tab=log|rcon so the
// palette and the Dashboard can open the RCON console directly, and every
// dead end names its fix -- no server, RCON not configured, wrong password,
// unreachable host all link to the Servers page where host, port and
// password are set per server.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    rconApi: { ...actual.rconApi, execute: vi.fn(), getHistory: vi.fn() },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    configApi: { ...actual.configApi, testRcon: vi.fn() },
  }
})

const getHistory = vi.mocked(rconApi.getHistory)
const getAllServers = vi.mocked(serversApi.getAll)
const testRcon = vi.mocked(configApi.testRcon)

const baseServer: ServerInstance = {
  id: 1,
  name: 'Ashenwood',
  serverName: 'Ashenwood',
  // No log source: the server-log polling (not mocked here) never starts.
  installPath: '',
  zomboidDataPath: null,
  serverConfigPath: null,
  rconHost: '10.0.0.5',
  rconPort: 27015,
  rconPassword: 'hunter2',
  serverPort: 16261,
  minMemory: 2048,
  maxMemory: 4096,
  useNoSteam: false,
  useDebug: false,
  isRemote: false,
  isActive: true,
  startCommand: '',
  adminPassword: '',
  createdAt: '2026-01-01T00:00:00.000Z',
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname + location.search}</output>
}

function renderConsole(entry = '/console') {
  return render(
    <TooltipProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/console" element={<><Console /><LocationProbe /></>} />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </TooltipProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = () => true
})

describe('Console: the tab lives in ?tab=', () => {
  it('opens the RCON console from /console?tab=rcon', async () => {
    getAllServers.mockResolvedValue({ servers: [baseServer] })
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockResolvedValue({ success: true, connected: true })

    renderConsole('/console?tab=rcon')

    const rconTab = await screen.findByRole('tab', { name: enConsole.tabs.rconConsole })
    expect(rconTab).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByLabelText(/rcon command input/i)).toBeInTheDocument()
  })

  it('writes the tab back to the URL when the operator switches', async () => {
    getAllServers.mockResolvedValue({ servers: [baseServer] })
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockResolvedValue({ success: true, connected: true })

    renderConsole('/console')
    const logTab = await screen.findByRole('tab', { name: enConsole.tabs.serverLog })
    expect(logTab).toHaveAttribute('aria-selected', 'true')

    fireEvent.mouseDown(screen.getByRole('tab', { name: enConsole.tabs.rconConsole }), { button: 0 })
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/console?tab=rcon'))
  })

  it('reads an unknown tab as the server log', async () => {
    getAllServers.mockResolvedValue({ servers: [baseServer] })
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockResolvedValue({ success: true, connected: true })

    renderConsole('/console?tab=nonsense')
    expect(await screen.findByRole('tab', { name: enConsole.tabs.serverLog })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('Console: dead ends link to their fix', () => {
  it('with no server, keeps the page header and offers "Add a server" on the Servers page', async () => {
    getAllServers.mockResolvedValue({ servers: [] })

    renderConsole()

    expect(await screen.findByText(enConsole.emptyState.title)).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: enConsole.pageHeader.title })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: enConsole.emptyState.action })).toHaveAttribute('href', '/servers')
  })

  it('RCON not configured: the alert links to Edit server on the Servers page', async () => {
    getAllServers.mockResolvedValue({ servers: [{ ...baseServer, rconPassword: '' }] })
    getHistory.mockResolvedValue({ history: [] })

    renderConsole('/console?tab=rcon')

    const alert = (await screen.findByText(enConsole.rcon.notConfiguredTitle)).closest('[role="status"]') as HTMLElement
    expect(within(alert).getByRole('link', { name: enConsole.actions.editServer })).toHaveAttribute('href', '/servers')
  })

  it('wrong RCON password: the alert links to Edit server', async () => {
    getAllServers.mockResolvedValue({ servers: [baseServer] })
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockRejectedValue(
      new ApiError('Authentication failed', { status: 200, code: 'RCON_CONNECT_AUTH_FAILED', data: { success: false, error: 'auth_failed' } }),
    )

    renderConsole('/console?tab=rcon')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(enConsole.rcon.authFailedTitle)
    expect(within(alert).getByRole('link', { name: enConsole.actions.editServer })).toHaveAttribute('href', '/servers')
  })

  it('unreachable host: the advice names the Servers page (not Panel Settings) and links there', async () => {
    getAllServers.mockResolvedValue({ servers: [baseServer] })
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockResolvedValue({ success: true, connected: false })

    renderConsole('/console?tab=rcon')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(enConsole.rcon.hostUnreachableDesc)
    expect(enConsole.rcon.hostUnreachableDesc).not.toMatch(/Panel Settings/)
    expect(within(alert).getByRole('link', { name: enConsole.actions.editServer })).toHaveAttribute('href', '/servers')
  })

  // Bug pass: the redesign added "Edit presets in Chat" here, but these
  // buttons are the Console's own translated templates; Chat's presets never
  // reach them, so the link promised an edit that changed nothing.
  it('Broadcast does not send the operator to Chat presets it does not use', async () => {
    getAllServers.mockResolvedValue({ servers: [baseServer] })
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockResolvedValue({ success: true, connected: true })

    renderConsole('/console?tab=rcon')

    await screen.findByRole('textbox', { name: enConsole.rcon.inputAria })
    expect(document.querySelector('a[href="/chat"]')).toBeNull()
  })

  // Enter that picks a candidate in an IME (zh-CN, zh-TW) must not send the
  // half-typed command.
  it('Enter during IME composition does not run the command', async () => {
    getAllServers.mockResolvedValue({ servers: [baseServer] })
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockResolvedValue({ success: true, connected: true })
    vi.mocked(rconApi.execute).mockResolvedValue({ success: true, response: 'ok' } as never)

    renderConsole('/console?tab=rcon')

    const input = await screen.findByRole('textbox', { name: enConsole.rcon.inputAria })
    await waitFor(() => expect(input).not.toBeDisabled())
    fireEvent.change(input, { target: { value: 'servermsg 你' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(rconApi.execute).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(rconApi.execute).toHaveBeenCalledTimes(1))
  })
})

describe('Console: quick commands share the Run gate', () => {
  it('disables the quick-command chips when the role lacks rcon.execute', async () => {
    mockCan = (capability) => capability !== 'rcon.execute'
    getAllServers.mockResolvedValue({ servers: [baseServer] })
    testRcon.mockResolvedValue({ success: true, connected: true })

    renderConsole('/console?tab=rcon')

    await screen.findByLabelText(/rcon command input/i)
    await screen.findByText(enConsole.rcon.online)
    expect(screen.getByRole('button', { name: 'Players' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('leaves them enabled for a role that can run commands', async () => {
    getAllServers.mockResolvedValue({ servers: [baseServer] })
    getHistory.mockResolvedValue({ history: [] })
    testRcon.mockResolvedValue({ success: true, connected: true })

    renderConsole('/console?tab=rcon')

    await screen.findByText(enConsole.rcon.online)
    expect(screen.getByRole('button', { name: 'Players' })).not.toBeDisabled()
  })
})
