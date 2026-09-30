import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import enFiles from '@/locales/en/files.json'
import { FakeFilesServer, fmError, json, makeEntry, makeListing, renderFiles, stubLayout } from './filesTestHarness'

// Spec §A14.3 Delete: preview, then the "Are you absolutely sure?" confirm
// naming what goes where, then delete with the previewId, then an Undo toast
// that restores from Trash. Permanent delete is typed-confirmed and runs as
// a job.

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

function preview(paths: string[], extra: Record<string, unknown> = {}) {
  return {
    items: paths.map((path) => ({ path, type: 'file', files: 1, dirs: 0, bytes: 2048, truncated: false, worldState: false, containsProtected: false })),
    totals: { files: paths.length, dirs: 0, bytes: 2048 * paths.length },
    required: [],
    trashAvailable: true,
    previewId: PREVIEW_ID,
    expiresAt: '2026-09-29T12:05:00.000Z',
    ...extra,
  }
}

beforeEach(() => {
  server = new FakeFilesServer()
  server.install()
  restoreLayout = stubLayout()
  server.listings.set('data|', makeListing([makeEntry('Server', 'dir'), makeEntry('old.log'), makeEntry('older.log')]))
})

afterEach(() => {
  cleanup()
  restoreLayout()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function openRowMenu(name: string) {
  fireEvent.pointerDown(screen.getByRole('button', { name: `More actions for ${name}` }), { button: 0, ctrlKey: false })
}

describe('Files: delete to Trash', () => {
  it('previews, confirms with the details, deletes by previewId, and Undo restores', async () => {
    server.on(({ method, path, body }) => {
      if (method === 'POST' && path.endsWith('/delete/preview')) return json(200, preview(body.paths))
      if (method === 'POST' && path.endsWith('/delete')) return json(200, { trashed: [{ path: 'old.log', trashId: TRASH_ID }], failed: [] })
      if (method === 'POST' && path.endsWith('/trash/restore')) return json(200, { restored: [{ trashId: TRASH_ID, entry: makeEntry('old.log') }], failed: [] })
      return undefined
    })
    renderFiles()

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select old.log' }))
    fireEvent.click(screen.getAllByRole('button', { name: enFiles.actions.delete })[0])

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(enFiles.confirm.title)).toBeInTheDocument()
    expect(within(dialog).getByText(/Move old\.log \(2 kB\) from Zomboid folder to Trash\?/)).toBeInTheDocument()
    expect(within(dialog).getByText(/You can restore it from Trash for 7 days\. Trash doesn't free disk space until it's emptied\./)).toBeInTheDocument()
    expect(within(dialog).getByRole('listitem')).toHaveTextContent('old.log')
    expect(server.callsTo('POST', '/delete/preview')[0].body).toEqual({ root: 'data', paths: ['old.log'] })
    expect(server.callsTo('POST', '/delete')).toHaveLength(0)

    fireEvent.click(within(dialog).getByRole('button', { name: enFiles.actions.delete }))

    await waitFor(() => expect(server.callsTo('POST', '/delete')).toHaveLength(1))
    expect(server.callsTo('POST', '/delete')[0].body).toEqual({ root: 'data', previewId: PREVIEW_ID, mode: 'trash', confirm: [] })

    expect(await screen.findByText('Moved 1 item to Trash.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: enFiles.trash.undo }))

    await waitFor(() => expect(server.callsTo('POST', '/trash/restore')).toHaveLength(1))
    // One request for everything the delete trashed (one confirmation, one
    // hit on the per-minute limit).
    expect(server.callsTo('POST', '/trash/restore')[0].body).toEqual({ root: 'data', trashIds: [TRASH_ID], confirm: [] })
    expect(await screen.findByText('Restored to old.log')).toBeInTheDocument()
  })

  it('cancelling the confirm deletes nothing', async () => {
    server.on(({ method, path, body }) => (method === 'POST' && path.endsWith('/delete/preview') ? json(200, preview(body.paths)) : undefined))
    renderFiles()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select old.log' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select older.log' }))
    fireEvent.click(screen.getAllByRole('button', { name: enFiles.actions.delete })[0])
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/Move 2 items \(2 files, 4 kB\) from Zomboid folder to Trash\?/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: enFiles.actions.cancel }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(server.callsTo('POST', '/delete')).toHaveLength(0)
  })

  it('reports an item the server refused', async () => {
    server.on(({ method, path, body }) => {
      if (method === 'POST' && path.endsWith('/delete/preview')) return json(200, preview(body.paths))
      if (method === 'POST' && path.endsWith('/delete')) return json(200, { trashed: [], failed: [{ path: 'old.log', code: 'FM_FILE_IN_USE' }] })
      return undefined
    })
    renderFiles()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select old.log' }))
    fireEvent.click(screen.getAllByRole('button', { name: enFiles.actions.delete })[0])
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: enFiles.actions.delete }))
    expect(await screen.findByText(/Another program has this file open/)).toBeInTheDocument()
  })
})

describe('Files: permanent delete', () => {
  it('needs the name typed, sends typedConfirmation with the permanent token, and waits for the job', async () => {
    server.on(({ method, path, body }) => {
      if (method === 'POST' && path.endsWith('/delete/preview')) return json(200, preview(body.paths))
      if (method === 'POST' && path.endsWith('/delete')) return json(202, { jobId: JOB_ID })
      if (method === 'GET' && path === `/jobs/${JOB_ID}`) return json(200, { id: JOB_ID, kind: 'permanentDelete', state: 'done', progress: { done: 1, total: 1 } })
      return undefined
    })
    renderFiles()

    await screen.findByRole('checkbox', { name: 'Select old.log' })
    openRowMenu('old.log')
    fireEvent.click(await screen.findByRole('menuitem', { name: enFiles.actions.deletePermanently }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/Permanently delete old\.log \(2 kB\)\? This can't be undone\./)).toBeInTheDocument()
    const confirmButton = within(dialog).getByRole('button', { name: enFiles.actions.deletePermanently })
    expect(confirmButton).toBeDisabled()
    const input = within(dialog).getByLabelText('Type old.log to confirm')
    fireEvent.change(input, { target: { value: 'old.lo' } })
    expect(confirmButton).toBeDisabled()
    fireEvent.change(input, { target: { value: 'old.log' } })
    expect(confirmButton).toBeEnabled()
    fireEvent.click(confirmButton)

    await waitFor(() => expect(server.callsTo('POST', '/delete')).toHaveLength(1))
    expect(server.callsTo('POST', '/delete')[0].body).toEqual({
      root: 'data',
      previewId: PREVIEW_ID,
      mode: 'permanent',
      confirm: ['permanent'],
      typedConfirmation: 'old.log',
    })
    expect(await screen.findByText(enFiles.jobs.done)).toBeInTheDocument()
    expect(server.callsTo('GET', `/jobs/${JOB_ID}`).length).toBeGreaterThan(0)
  })

  it('when Trash is unavailable, a plain Delete is permanent and says so, typed by count for several items', async () => {
    server.on(({ method, path, body }) => {
      if (method === 'POST' && path.endsWith('/delete/preview')) return json(200, preview(body.paths, { trashAvailable: false, trashUnavailableReason: 'crossDevice' }))
      if (method === 'POST' && path.endsWith('/delete')) return fmError(400, 'FM_TYPED_CONFIRMATION_MISMATCH')
      return undefined
    })
    renderFiles()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select old.log' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select older.log' }))
    fireEvent.click(screen.getAllByRole('button', { name: enFiles.actions.delete })[0])

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(new RegExp(enFiles.confirm.trashUnavailable.replace(/\./g, '\\.')))).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('Type 2 to confirm'), { target: { value: '2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: enFiles.actions.deletePermanently }))

    await waitFor(() => expect(server.callsTo('POST', '/delete')).toHaveLength(1))
    expect(server.callsTo('POST', '/delete')[0].body).toMatchObject({ mode: 'permanent', typedConfirmation: '2', confirm: ['permanent'] })
    expect(await screen.findByText(/The confirmation text didn't match\. Nothing was deleted\./)).toBeInTheDocument()
  })
})
