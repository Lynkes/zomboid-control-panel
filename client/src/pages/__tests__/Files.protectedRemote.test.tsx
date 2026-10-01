import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import enErrors from '@/locales/en/errors.json'
import enFiles from '@/locales/en/files.json'
import type { TrashItem } from '@/types/files'
import { FakeFilesServer, json, makeEntry, makeListing, makeProfile, makeRoot, renderFiles, stubLayout } from './filesTestHarness'

// Folders the operator can open but not add to (a protected area), an SFTP
// root that can't be reached, and the header's Refresh while Trash is open.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'kate', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'token',
    can: () => true,
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
  localStorage.clear()
})

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('Files: inside a protected folder', () => {
  beforeEach(() => {
    const bridge = { level: 'readOnly' as const, area: 'bridgeIo' as const }
    server.listings.set('data|Lua/panelbridge', makeListing(
      [makeEntry('Lua/panelbridge/servertest', 'dir', { protection: bridge })],
      { dir: makeEntry('Lua/panelbridge', 'dir', { protection: bridge }) },
    ))
    const backups = { level: 'listOnly' as const, area: 'panelBackups' as const }
    server.listings.set('data|backups', makeListing(
      [makeEntry('backups/world-2026-09-29.zip', 'file', { protection: backups })],
      { dir: makeEntry('backups', 'dir', { protection: backups }) },
    ))
  })

  it.each([
    ['Lua/panelbridge', 'servertest', 'bridgeIo'],
    ['backups', 'world-2026-09-29.zip', 'panelBackups'],
  ] as const)('%s offers no create or upload, and says why', async (path, child, area) => {
    renderFiles(`/files?server=p1&root=data&path=${encodeURIComponent(path)}`)
    await screen.findByRole('checkbox', { name: `Select ${child}` })
    expect(screen.queryAllByRole('button', { name: enFiles.actions.newFile })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: enFiles.actions.newFolder })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: new RegExp(`^${enFiles.actions.upload}`) })).toHaveLength(0)
    // Said above the list too (a row may say it as well).
    expect(screen.getAllByText(enFiles.protected.areas[area]).length).toBeGreaterThan(0)
  })
})

describe('Files: an SFTP root that cannot be reached', () => {
  it.each([
    ['SFTP_AUTH_FAILED', /Verify the SFTP username and password/],
    ['SFTP_UNREACHABLE', /Check the SFTP host, port, firewall/],
    ['SFTP_TIMEOUT', /Check the SFTP host, port, firewall/],
  ])('%s: says why and offers Retry', async (code, guidance) => {
    const root = (id: 'data' | 'install', displayPath: string) =>
      makeRoot(id, { backend: 'sftp', available: false, unavailableReason: 'sftpUnreachable', unavailableDetail: code, writable: null, displayPath })
    server.profiles = [makeProfile({
      remote: { host: 'vps.example', port: 22, username: 'pz' },
      serverState: 'unknown',
      roots: [root('data', '/home/pz/Zomboid'), root('install', '/opt/pz')],
    })]
    renderFiles()
    await screen.findAllByText(new RegExp(escapeRe(enFiles.roots.unavailable.sftpUnreachable)))
    expect(screen.queryAllByText(guidance).length).toBeGreaterThan(0)
    expect((enErrors as Record<string, string>)[code === 'SFTP_TIMEOUT' ? 'SFTP_UNREACHABLE' : code]).toMatch(guidance)

    const profileGets = () => server.calls.filter((call) => call.method === 'GET' && call.url.pathname.endsWith('/profiles/p1')).length
    const before = profileGets()
    fireEvent.click(screen.getByRole('button', { name: enFiles.actions.retry }))
    await waitFor(() => expect(profileGets()).toBe(before + 1))
  })
})

describe('Files: the header Refresh while Trash is open', () => {
  const item = (trashId: string, originalPath: string): TrashItem => ({
    trashId,
    originalPath,
    type: 'file',
    bytes: 10,
    files: 1,
    deletedAt: '2026-09-28T10:00:00.000Z',
    deletedBy: { username: 'kate' },
    reason: 'deleted',
    expiresAt: '2026-10-05T10:00:00.000Z',
  })

  it('fetches the Trash list again', async () => {
    let trash = [item('20260928T100000Z-aaaaaaaa', 'Server/old.ini'), item('20260928T090000Z-bbbbbbbb', 'Server/gone.ini')]
    server.profiles = [makeProfile({ roots: [makeRoot('data', { trashItemCount: 2 }), makeRoot('install')] })]
    server.listings.set('data|', makeListing([makeEntry('Server', 'dir')]))
    server.on(({ method, path }) => (method === 'GET' && path.endsWith('/trash') ? json(200, { items: trash, totalBytes: 20 }) : undefined))
    renderFiles()
    fireEvent.click(await screen.findByRole('button', { name: 'Trash (2 items)' }))
    await screen.findByText('Server/gone.ini')
    const before = server.callsTo('GET', '/trash').length

    // Another admin (or the hourly clean-up) removed one meanwhile.
    trash = [trash[0]]
    fireEvent.click(screen.getByRole('button', { name: enFiles.page.refresh }))
    await waitFor(() => expect(server.callsTo('GET', '/trash').length - before).toBe(1))
    await waitFor(() => expect(screen.queryByText('Server/gone.ini')).toBeNull())
  })
})
