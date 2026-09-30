import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import enFiles from '@/locales/en/files.json'
import { ROOT_UNAVAILABLE_REASONS, type RootUnavailableReason } from '@/types/files'
import { FakeFilesServer, fmError, makeEntry, makeListing, makeProfile, makeRoot, renderFiles, stubLayout } from './filesTestHarness'

// Spec §A14.4: what the page shows for every root it can't open, for the
// server's live state, and for the access errors -- each with the action
// that fixes it.

const mockCan = vi.hoisted(() => vi.fn((_capability: string) => true))

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'kate', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'token',
    can: mockCan,
  }),
}))

let server: FakeFilesServer
let restoreLayout: () => void

beforeEach(() => {
  server = new FakeFilesServer()
  server.install()
  restoreLayout = stubLayout()
})

afterEach(() => {
  cleanup()
  restoreLayout()
  vi.unstubAllGlobals()
  mockCan.mockImplementation(() => true)
  localStorage.clear()
})

// The action each reason offers: a link to fix it elsewhere, or a button here.
const EXPECTED_ACTION: Record<RootUnavailableReason, { link?: string; button?: string }> = {
  missing: { link: '/servers' },
  notConfigured: { link: '/servers' },
  notMounted: { link: '/servers' },
  remoteNotActive: { link: '/servers' },
  tooBroad: { link: '/servers' },
  overlapsPanel: { link: '/servers' },
  unreadable: { link: '/servers' },
  remoteNotConfigured: { link: '/settings?tab=bridge' },
  sftpUnreachable: { link: '/settings?tab=bridge' },
  remoteInstallNotSet: { button: 'Set remote folders' },
}

describe('Files: a folder that cannot be opened', () => {
  it.each(ROOT_UNAVAILABLE_REASONS.map((reason) => [reason]))('%s shows its reason and its fix', async (reason) => {
    const remote = reason.startsWith('remote') || reason === 'sftpUnreachable'
    server.profiles = [makeProfile({
      remote: remote ? { host: 'vps.example', port: 22, username: 'pz' } : null,
      roots: [makeRoot('data', { available: false, unavailableReason: reason, unavailableDetail: 'EACCES', writable: null, displayPath: null })],
    })]
    renderFiles()

    const message = (enFiles.roots.unavailable as Record<string, string>)[reason].replace('{{detail}}', 'EACCES')
    const main = await screen.findByText(message, { selector: 'p' })
    const emptyState = main.closest('div.flex.flex-col') as HTMLElement
    const expected = EXPECTED_ACTION[reason]
    if (expected.link) {
      const link = within(emptyState).getByRole('link')
      expect(link).toHaveAttribute('href', expected.link)
    } else {
      expect(within(emptyState).getByRole('button', { name: expected.button })).toBeInTheDocument()
    }
    // Nothing is listed from a root that isn't available.
    expect(server.callsTo('GET', '/list')).toHaveLength(0)
  })
})

describe('Files: the server state callout', () => {
  beforeEach(() => {
    server.listings.set('data|', makeListing([makeEntry('Server', 'dir')]))
  })

  it('warns while the server runs, and "Check again" asks for a fresh state', async () => {
    server.profiles = [makeProfile({ serverState: 'running' })]
    renderFiles()
    const alert = (await screen.findByText(enFiles.serverState.running.title)).closest('[role="alert"]') as HTMLElement
    expect(alert.className).toContain('border-warning/40')
    expect(within(alert).getByText(enFiles.serverState.running.body)).toBeInTheDocument()

    fireEvent.click(within(alert).getByRole('button', { name: enFiles.serverState.checkAgain }))
    await waitFor(() => {
      expect(server.calls.some((call) => call.url.pathname === '/api/files/profiles/p1' && call.url.searchParams.get('fresh') === '1')).toBe(true)
    })
  })

  it('warns when a local server state is unknown', async () => {
    server.profiles = [makeProfile({ serverState: 'unknown' })]
    renderFiles()
    expect(await screen.findByText(enFiles.serverState.unknown.title)).toBeInTheDocument()
    expect(screen.getByText(enFiles.serverState.unknown.body)).toBeInTheDocument()
  })

  it('says plainly that a remote server state is invisible, without a warning', async () => {
    server.profiles = [makeProfile({ serverState: 'unknown', remote: { host: 'vps.example', port: 2222, username: 'pz' }, roots: [makeRoot('data', { backend: 'sftp' })] })]
    renderFiles()
    const note = await screen.findByText(enFiles.serverState.remoteUnknown)
    expect(note.closest('[role="alert"]')?.className).toContain('bg-muted/40')
    expect(screen.queryByText(enFiles.serverState.unknown.title)).not.toBeInTheDocument()
    expect(screen.getByText('Connected over SFTP to vps.example:2222 as pz')).toBeInTheDocument()
  })

  it('shows nothing while the server is stopped', async () => {
    renderFiles()
    await screen.findByRole('table')
    expect(screen.queryByText(enFiles.serverState.running.title)).not.toBeInTheDocument()
    expect(screen.queryByText(enFiles.serverState.unknown.title)).not.toBeInTheDocument()
  })
})

describe('Files: access', () => {
  it('without files.manage shows access denied and never calls the API', async () => {
    mockCan.mockImplementation((capability: string) => capability !== 'files.manage')
    renderFiles()
    expect(await screen.findByText(enFiles.access.denied)).toBeInTheDocument()
    expect(server.calls).toHaveLength(0)
  })

  it('a 403 from the server is access denied', async () => {
    server.on(({ path }) => (path === '/profiles' ? fmError(403, 'PERMISSION_DENIED') : undefined))
    renderFiles()
    expect(await screen.findByText(enFiles.access.denied)).toBeInTheDocument()
  })

  it('logins off: explains, and links to Panel Settings', async () => {
    server.on(({ path }) => (path === '/profiles' ? fmError(403, 'FM_AUTH_DISABLED') : undefined))
    renderFiles()
    expect(await screen.findByText(enFiles.access.authDisabled)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: enFiles.access.openSettings })).toHaveAttribute('href', '/settings?tab=security')
  })
})

describe('Files: list failures', () => {
  it('an SFTP failure shows the disconnected state with the SFTP guidance and a retry', async () => {
    server.profiles = [makeProfile({ remote: { host: 'vps.example', port: 22, username: 'pz' }, roots: [makeRoot('data', { backend: 'sftp' })] })]
    // Fails until the operator presses Try again (apiFetch itself retries a
    // 5xx GET a few times first, which this also covers).
    let failing = true
    server.on(({ path }) => {
      if (!path.endsWith('/list') || !failing) return undefined
      return fmError(502, 'FM_SFTP_ERROR', { sftpCode: 'SFTP_AUTH_FAILED', detail: 'All configured authentication methods failed' })
    })
    server.listings.set('data|', makeListing([makeEntry('Server', 'dir')]))
    renderFiles()

    expect(await screen.findByText('Disconnected', {}, { timeout: 30000 })).toBeInTheDocument()
    expect(screen.getByText(enFiles.roots.unavailable.sftpUnreachable)).toBeInTheDocument()
    expect(screen.getByText(/Verify the SFTP username and password/)).toBeInTheDocument()

    failing = false
    fireEvent.click(screen.getByRole('button', { name: enFiles.actions.retry }))
    expect(await screen.findByRole('button', { name: 'Server' })).toBeInTheDocument()
  })

  it('an empty folder offers Upload and New file', async () => {
    server.listings.set('data|', makeListing([]))
    renderFiles()
    expect(await screen.findByText(enFiles.list.empty.title)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: enFiles.actions.upload }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: enFiles.actions.newFile }).length).toBeGreaterThan(0)
  })

  it('a filter with no matches offers to clear it', async () => {
    server.listings.set('data|', makeListing([makeEntry('Server', 'dir'), makeEntry('console.txt')]))
    renderFiles()
    await screen.findByRole('button', { name: 'console.txt' })
    fireEvent.change(screen.getByRole('textbox', { name: enFiles.list.filterPlaceholder }), { target: { value: 'zzz' } })
    expect(await screen.findByText('Nothing matches “zzz”')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: enFiles.list.clearFilter }).at(-1)!)
    expect(await screen.findByRole('button', { name: 'console.txt' })).toBeInTheDocument()
  })
})
