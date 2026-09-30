import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import enFiles from '@/locales/en/files.json'
import type { TrashItem } from '@/types/files'
import {
  FakeFilesServer,
  fmError,
  json,
  makeEntry,
  makeListing,
  makeProfile,
  makeRoot,
  makeText,
  renderFiles,
  stubLayout,
} from './filesTestHarness'

// Spec §A14.3: the per-root Trash (restore, restore-as, empty with a typed
// count), the editor's "Previous versions" menu, and "Set remote folders"
// (which also needs bridge.setup).

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

const JOB_ID = 'e'.repeat(32)

function trashItem(trashId: string, originalPath: string, reason: TrashItem['reason'], deletedAt = '2026-09-28T10:00:00.000Z'): TrashItem {
  return {
    trashId,
    originalPath,
    type: 'file',
    bytes: 4096,
    files: 1,
    deletedAt,
    deletedBy: { username: 'kate' },
    reason,
    expiresAt: '2026-10-05T10:00:00.000Z',
  }
}

let server: FakeFilesServer
let restoreLayout: () => void

beforeEach(() => {
  server = new FakeFilesServer()
  server.install()
  restoreLayout = stubLayout()
  server.profiles = [makeProfile({ roots: [makeRoot('data', { trashItemCount: 2 }), makeRoot('install')] })]
  server.listings.set('data|', makeListing([makeEntry('Server', 'dir')]))
})

afterEach(() => {
  cleanup()
  restoreLayout()
  vi.unstubAllGlobals()
  mockCan.mockImplementation(() => true)
  localStorage.clear()
})

describe('Files: Trash', () => {
  const ITEMS = [
    trashItem('20260928T100000Z-aaaaaaaa', 'Server/old.ini', 'deleted'),
    trashItem('20260928T090000Z-bbbbbbbb', 'Server/servertest.ini', 'edited', '2026-09-28T09:00:00.000Z'),
  ]

  beforeEach(() => {
    server.on(({ method, path }) => (method === 'GET' && path.endsWith('/trash') ? json(200, { items: ITEMS, totalBytes: 8192 }) : undefined))
  })

  it('lists what is in Trash, and restores under another name when the original is taken', async () => {
    server.on(({ method, path, body }) => {
      if (method !== 'POST' || !path.endsWith('/trash/restore')) return undefined
      if (!body.restoreAs) return fmError(409, 'FM_EXISTS', { name: 'old.ini' })
      return json(200, { entry: makeEntry(`Server/${body.restoreAs}`) })
    })
    renderFiles()
    fireEvent.click(await screen.findByRole('button', { name: 'Trash (2 items)' }))

    const table = await screen.findByRole('table')
    expect(within(table).getByText('Server/old.ini')).toBeInTheDocument()
    expect(within(table).getByText(enFiles.trash.reasons.deleted)).toBeInTheDocument()
    expect(within(table).getByText(enFiles.trash.reasons.edited)).toBeInTheDocument()
    expect(within(table).getAllByText(/^Removed on /)).toHaveLength(2)
    expect(screen.getByText(enFiles.trash.description)).toBeInTheDocument()

    fireEvent.click(within(table).getAllByRole('button', { name: enFiles.actions.restore })[0])
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(enFiles.dialogs.restoreAs.title)).toBeInTheDocument()
    expect(within(dialog).getByText('Something named old.ini is already there.')).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText(enFiles.dialogs.restoreAs.nameLabel), { target: { value: 'old (restored).ini' } })
    fireEvent.click(within(dialog).getByRole('button', { name: enFiles.actions.restore }))

    await waitFor(() => expect(server.callsTo('POST', '/trash/restore')).toHaveLength(2))
    expect(server.callsTo('POST', '/trash/restore')[1].body).toEqual({ root: 'data', trashId: '20260928T100000Z-aaaaaaaa', restoreAs: 'old (restored).ini' })
    expect(await screen.findByText('Restored to Server/old (restored).ini')).toBeInTheDocument()
  })

  it('Empty trash needs the item count typed, then runs a purge job', async () => {
    server.on(({ method, path }) => {
      if (method === 'POST' && path.endsWith('/trash/purge')) return json(202, { jobId: JOB_ID })
      if (method === 'GET' && path === `/jobs/${JOB_ID}`) return json(200, { id: JOB_ID, kind: 'trashPurge', state: 'done', progress: { done: 2, total: 2 } })
      return undefined
    })
    renderFiles()
    fireEvent.click(await screen.findByRole('button', { name: 'Trash (2 items)' }))
    fireEvent.click(await screen.findByRole('button', { name: enFiles.actions.emptyTrash }))

    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Permanently delete 2 items from Trash? This can\'t be undone.')).toBeInTheDocument()
    fireEvent.change(within(confirm).getByLabelText('Type 2 to confirm'), { target: { value: '2' } })
    fireEvent.click(within(confirm).getByRole('button', { name: enFiles.actions.emptyTrash }))

    await waitFor(() => expect(server.callsTo('POST', '/trash/purge')).toHaveLength(1))
    expect(server.callsTo('POST', '/trash/purge')[0].body).toEqual({ root: 'data', all: true, typedConfirmation: '2', confirm: ['permanent'] })
    expect(await screen.findByText(enFiles.jobs.done)).toBeInTheDocument()
  })

  it('the editor lists earlier versions and loads one as unsaved text', async () => {
    const ini = makeEntry('Server/servertest.ini')
    server.listings.set('data|Server', makeListing([ini]))
    server.texts.set('data|Server/servertest.ini', makeText(ini, 'PVP=true\n'))
    server.on(({ method, path, url }) => {
      if (method === 'GET' && path.endsWith('/trash/text') && url.searchParams.get('trashId') === '20260928T090000Z-bbbbbbbb') {
        return json(200, { content: 'PVP=false\n', bom: false, eol: 'lf', masked: false })
      }
      return undefined
    })
    renderFiles('/files?server=p1&root=data&path=Server&open=servertest.ini')
    const textarea = await screen.findByRole('textbox', { name: 'servertest.ini' })
    await waitFor(() => expect(textarea).toHaveValue('PVP=true\n'))

    fireEvent.pointerDown(screen.getByRole('button', { name: enFiles.editor.versions.title }), { button: 0, ctrlKey: false })
    const item = await screen.findByRole('menuitem', { name: /by kate/ })
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    expect(server.callsTo('GET', '/trash').at(-1)?.url.searchParams.get('originalPath')).toBe('Server/servertest.ini')
    fireEvent.click(item)

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'servertest.ini' })).toHaveValue('PVP=false\n'))
    expect(screen.getByText(/^Loaded the version from .+\. Save to restore it\.$/)).toBeInTheDocument()
    expect(screen.getAllByText(enFiles.editor.unsaved).length).toBeGreaterThan(0)
  })
})

describe('Files: remote folders', () => {
  beforeEach(() => {
    server.profiles = [makeProfile({
      remote: { host: 'vps.example', port: 22, username: 'pz' },
      provider: 'remote-sftp',
      serverState: 'unknown',
      roots: [
        makeRoot('install', { backend: 'sftp', available: false, unavailableReason: 'remoteInstallNotSet', displayPath: null }),
        makeRoot('data', { backend: 'sftp', displayPath: '/home/pz/Zomboid' }),
      ],
      remoteRoots: { installPath: null, dataPath: null, derivedDataPath: '/home/pz/Zomboid' },
    })]
  })

  it('saves the install folder and keeps the derived Zomboid folder as the placeholder', async () => {
    server.on(({ method, path, body }) => (method === 'PUT' && path.endsWith('/remote-roots')
      ? json(200, { profile: { ...server.profiles[0], remoteRoots: { ...body, derivedDataPath: '/home/pz/Zomboid' } } })
      : undefined))
    renderFiles('/files?server=p1&root=install')
    const emptyState = (await screen.findByText(enFiles.roots.unavailable.remoteInstallNotSet, { selector: 'p' })).closest('div.flex.flex-col') as HTMLElement
    fireEvent.click(within(emptyState).getByRole('button', { name: enFiles.roots.setRemoteFolders }))

    const dialog = await screen.findByRole('dialog')
    const data = within(dialog).getByLabelText(enFiles.remote.dataLabel)
    expect(data).toHaveAttribute('placeholder', '/home/pz/Zomboid')
    expect(within(dialog).getByText('Leave empty to use /home/pz/Zomboid.')).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText(enFiles.remote.installLabel), { target: { value: '/' } })
    expect(within(dialog).getByText(enFiles.remote.rootWarning)).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText(enFiles.remote.installLabel), { target: { value: '/home/pz/pzserver' } })
    fireEvent.click(within(dialog).getByRole('button', { name: enFiles.remote.save }))

    await waitFor(() => expect(server.callsTo('PUT', '/remote-roots')).toHaveLength(1))
    expect(server.callsTo('PUT', '/remote-roots')[0].body).toEqual({ installPath: '/home/pz/pzserver', dataPath: null })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('without bridge.setup the dialog explains who can change them and saves nothing', async () => {
    mockCan.mockImplementation((capability: string) => capability !== 'bridge.setup')
    renderFiles('/files?server=p1&root=install')
    fireEvent.click((await screen.findAllByRole('button', { name: enFiles.roots.setRemoteFolders }))[0])
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(enFiles.remote.needsBridgeSetup)).toBeInTheDocument()
    expect(within(dialog).getByLabelText(enFiles.remote.installLabel)).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: enFiles.remote.save })).toBeDisabled()
  })
})
