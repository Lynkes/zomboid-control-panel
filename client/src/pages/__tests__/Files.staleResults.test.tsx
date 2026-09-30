import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import enFiles from '@/locales/en/files.json'
import { FakeFilesServer, currentParams, json, makeEntry, makeListing, makeProfile, makeRoot, renderFiles, stubLayout } from './filesTestHarness'

// Answers that arrive for a place the page has left: another server picked
// while the previous one's profile is still shown, a permanent delete or an
// Undo that finishes after the operator opened another folder, a search or
// "Load more" answered late. None of them may replace what is shown now.

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

const PREVIEW_ID = 'a'.repeat(32)
const JOB_ID = 'f'.repeat(32)
const TRASH_ID = '20260929T120000Z-a1b2c3d4'

let server: FakeFilesServer
let restoreLayout: () => void

beforeEach(() => {
  localStorage.clear()
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

function preview(paths: string[]) {
  return {
    items: paths.map((path) => ({ path, type: 'file', files: 1, dirs: 0, bytes: 2048, truncated: false, worldState: false, containsProtected: false })),
    totals: { files: paths.length, dirs: 0, bytes: 2048 * paths.length },
    required: [],
    trashAvailable: true,
    previewId: PREVIEW_ID,
    expiresAt: '2026-09-29T12:05:00.000Z',
  }
}

function rowNames(): string[] {
  return screen
    .queryAllByRole('checkbox')
    .map((el) => el.getAttribute('aria-label') ?? '')
    .filter((name) => name.startsWith('Select ') && name !== 'Select all')
    .map((name) => name.slice('Select '.length))
}

describe('Files: switching servers', () => {
  // The Server picker is a Radix Select, which calls pointer-capture and
  // scrollIntoView methods jsdom doesn't have.
  const proto = Element.prototype as unknown as Record<string, unknown>
  const polyfilled = ['hasPointerCapture', 'releasePointerCapture', 'setPointerCapture', 'scrollIntoView'].filter((name) => !(name in proto))
  beforeEach(() => {
    for (const name of polyfilled) proto[name] = name === 'hasPointerCapture' ? () => false : () => {}
  })
  afterEach(() => {
    for (const name of polyfilled) delete proto[name]
  })

  it('stays on the server picked in the Server picker', async () => {
    server.profiles = [
      makeProfile({ id: 'p1', name: 'Alpha' }),
      makeProfile({ id: 'p2', name: 'Bravo', isActive: false, roots: [makeRoot('data', { displayPath: '/srv/bravo/Zomboid' }), makeRoot('install')] }),
    ]
    server.listings.set('data|', makeListing([makeEntry('alpha.txt')]))
    server.on(({ method, path, url }) => {
      if (method === 'GET' && path === '/profiles/p2/list' && url.searchParams.get('root') === 'data') {
        return json(200, makeListing([makeEntry('bravo.txt')]))
      }
      return undefined
    })
    renderFiles('/files?server=p1&root=data')
    await screen.findByRole('button', { name: 'alpha.txt' })

    const trigger = screen.getByRole('combobox', { name: 'Server' })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('option', { name: /Bravo/ }))

    expect(await screen.findByRole('button', { name: 'bravo.txt' })).toBeInTheDocument()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    expect(currentParams(screen.getByTestId).get('server')).toBe('p2')
    expect(screen.queryByRole('button', { name: 'alpha.txt' })).toBeNull()
  })
})

describe('Files: a change that finishes after the operator moved on', () => {
  beforeEach(() => {
    server.listings.set('data|', makeListing([makeEntry('Server', 'dir'), makeEntry('old.log'), makeEntry('older.log')]))
    server.listings.set('data|Server', makeListing([makeEntry('Server/servertest.ini')]))
  })

  it('a permanent delete whose job ends in another folder leaves that folder shown', async () => {
    let jobState: 'running' | 'done' = 'running'
    server.on(({ method, path, body }) => {
      if (method === 'POST' && path.endsWith('/delete/preview')) return json(200, preview(body.paths))
      if (method === 'POST' && path.endsWith('/delete')) return json(202, { jobId: JOB_ID })
      if (method === 'GET' && path === `/jobs/${JOB_ID}`) {
        return json(200, { id: JOB_ID, kind: 'permanentDelete', state: jobState, progress: { done: 0, total: 5 } })
      }
      return undefined
    })
    renderFiles('/files?server=p1&root=data&path=')
    await screen.findByRole('checkbox', { name: 'Select old.log' })
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions for old.log' }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: enFiles.actions.deletePermanently }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.change(within(dialog).getByLabelText('Type old.log to confirm'), { target: { value: 'old.log' } })
    fireEvent.click(within(dialog).getByRole('button', { name: enFiles.actions.deletePermanently }))
    await waitFor(() => expect(server.callsTo('GET', `/jobs/${JOB_ID}`).length).toBeGreaterThan(0))

    // Into Server while the job runs.
    fireEvent.click(screen.getByRole('button', { name: 'Server' }))
    await screen.findByRole('checkbox', { name: 'Select servertest.ini' })

    jobState = 'done'
    await screen.findByText(enFiles.jobs.done, {}, { timeout: 4000 })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    expect(currentParams(screen.getByTestId).get('path')).toBe('Server')
    expect(rowNames()).toEqual(['servertest.ini'])
    expect(localStorage.getItem('zcp-files-last:p1:data')).toBe('Server')
  })

  it('an Undo clicked in another folder leaves that folder shown', async () => {
    server.on(({ method, path, body }) => {
      if (method === 'POST' && path.endsWith('/delete/preview')) return json(200, preview(body.paths))
      if (method === 'POST' && path.endsWith('/delete')) return json(200, { trashed: [{ path: 'old.log', trashId: TRASH_ID }], failed: [] })
      if (method === 'POST' && path.endsWith('/trash/restore')) {
        return json(200, { restored: [{ trashId: TRASH_ID, entry: makeEntry('old.log') }], failed: [] })
      }
      return undefined
    })
    renderFiles('/files?server=p1&root=data&path=')
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select old.log' }))
    fireEvent.click(screen.getAllByRole('button', { name: enFiles.actions.delete })[0])
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: enFiles.actions.delete }))
    await screen.findByText('Moved 1 item to Trash.')

    fireEvent.click(screen.getByRole('button', { name: 'Server' }))
    await screen.findByRole('checkbox', { name: 'Select servertest.ini' })
    fireEvent.click(screen.getByRole('button', { name: enFiles.trash.undo }))
    await waitFor(() => expect(server.callsTo('POST', '/trash/restore')).toHaveLength(1))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    expect(currentParams(screen.getByTestId).get('path')).toBe('Server')
    expect(rowNames()).toEqual(['servertest.ini'])
  })
})

describe('Files: late search and "Load more" answers', () => {
  beforeEach(() => {
    server.listings.set('data|Server', makeListing([makeEntry('Server/servertest.ini')]))
  })

  it('a search answered after moving to another folder is not shown there', async () => {
    server.listings.set('data|', makeListing([makeEntry('a.txt'), makeEntry('Server', 'dir')]))
    let releaseSearch: (() => void) | null = null
    server.on(({ method, path }) => {
      if (method === 'GET' && path.endsWith('/search')) {
        return new Promise<Response>((resolve) => {
          releaseSearch = () => resolve(json(200, { results: [makeEntry('deep/a-match.txt'), makeEntry('x/a-match2.txt')], truncated: false, scanned: 10 }))
        })
      }
      return undefined
    })
    renderFiles('/files?server=p1&root=data&path=')
    await screen.findByRole('button', { name: 'a.txt' })
    const box = screen.getByRole('textbox', { name: enFiles.list.filterPlaceholder })
    fireEvent.change(box, { target: { value: 'match' } })
    fireEvent.submit(box.closest('form')!)
    await waitFor(() => expect(releaseSearch).not.toBeNull())
    // The typed filter hides the Server row; clear it so the row can be clicked.
    fireEvent.change(box, { target: { value: '' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Server' }))
    await screen.findByRole('button', { name: 'servertest.ini' })

    await act(async () => {
      releaseSearch!()
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    expect(currentParams(screen.getByTestId).get('path')).toBe('Server')
    expect(rowNames()).toEqual(['servertest.ini'])
  })

  it('a "Load more" answered after moving to another folder is not shown there', async () => {
    const first = Array.from({ length: 3 }, (_, i) => makeEntry(`f${i}.txt`))
    server.listings.set('data|', makeListing([makeEntry('Server', 'dir'), ...first], { total: 10, dirEtag: 'root-etag' }))
    let releaseMore: (() => void) | null = null
    server.on(({ method, path, url }) => {
      if (method === 'GET' && path.endsWith('/list') && url.searchParams.get('path') === '' && url.searchParams.get('offset') !== '0') {
        return new Promise<Response>((resolve) => {
          releaseMore = () => resolve(json(200, makeListing([makeEntry('g1.txt'), makeEntry('g2.txt')], { total: 10, dirEtag: 'root-etag', offset: 4 })))
        })
      }
      return undefined
    })
    renderFiles('/files?server=p1&root=data&path=')
    await screen.findByRole('button', { name: 'f0.txt' })
    fireEvent.click(screen.getByRole('button', { name: enFiles.list.loadMore }))
    await waitFor(() => expect(releaseMore).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Server' }))
    await screen.findByRole('button', { name: 'servertest.ini' })

    await act(async () => {
      releaseMore!()
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    expect(currentParams(screen.getByTestId).get('path')).toBe('Server')
    expect(rowNames()).toEqual(['servertest.ini'])
  })
})
