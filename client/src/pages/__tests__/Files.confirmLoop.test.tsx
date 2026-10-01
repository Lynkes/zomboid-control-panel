import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import enFiles from '@/locales/en/files.json'
import { forgetServerRunningAcks } from '@/lib/filesApi'
import { FakeFilesServer, json, makeEntry, makeListing, renderFiles, stubLayout } from './filesTestHarness'

// Spec §A8/§A14.3: the server decides which confirmations a change needs.
// On FM_CONFIRMATION_REQUIRED the page asks once, listing each token's
// sentence, and retries once; a second FM_CONFIRMATION_REQUIRED is an error.
// A serverRunning acknowledgement is remembered for 10 minutes per server.

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
  forgetServerRunningAcks()
  server = new FakeFilesServer()
  server.install()
  restoreLayout = stubLayout()
  server.listings.set('data|', makeListing([makeEntry('Server', 'dir')]))
})

afterEach(() => {
  cleanup()
  restoreLayout()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function confirmationRequired(required: string[], details: Record<string, unknown> = {}) {
  return json(409, {
    error: 'Confirm this change first.',
    code: 'FM_CONFIRMATION_REQUIRED',
    params: { required },
    details: { serverState: 'running', ...details },
  })
}

async function createFolder(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: enFiles.actions.newFolder }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText(enFiles.dialogs.newFolder.nameLabel), { target: { value: name } })
  fireEvent.click(within(dialog).getByRole('button', { name: enFiles.actions.create }))
  return dialog
}

describe('Files: the confirmation loop', () => {
  it('asks once with the token sentence, then retries once with the token', async () => {
    let attempts = 0
    server.on(({ method, path }) => {
      if (method !== 'POST' || !path.endsWith('/mkdir')) return undefined
      attempts += 1
      return attempts === 1 ? confirmationRequired(['serverRunning']) : json(201, { entry: makeEntry('Mods2', 'dir') })
    })
    renderFiles()
    await createFolder('Mods2')

    const prompt = await screen.findByRole('alertdialog')
    expect(within(prompt).getByText(enFiles.confirm.changeTitle)).toBeInTheDocument()
    expect(within(prompt).getByText(enFiles.confirm.tokens.serverRunning)).toBeInTheDocument()
    const continueButton = within(prompt).getByRole('button', { name: enFiles.confirm.continue })
    // variant: 'warning' (amber), not destructive red.
    expect(continueButton.className).toContain('bg-warning')
    fireEvent.click(continueButton)

    await waitFor(() => expect(server.callsTo('POST', '/mkdir')).toHaveLength(2))
    expect(server.callsTo('POST', '/mkdir').map((call) => call.body.confirm)).toEqual([[], ['serverRunning']])
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('a second FM_CONFIRMATION_REQUIRED is shown as an error, with no third request', async () => {
    server.on(({ method, path }) => (method === 'POST' && path.endsWith('/mkdir') ? confirmationRequired(['serverRunning']) : undefined))
    renderFiles()
    const dialog = await createFolder('Mods2')

    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: enFiles.confirm.continue }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Confirm this change first.')
    expect(server.callsTo('POST', '/mkdir')).toHaveLength(2)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('declining sends nothing more and keeps the dialog open', async () => {
    server.on(({ method, path }) => (method === 'POST' && path.endsWith('/mkdir') ? confirmationRequired(['executable'], { executable: { names: ['start-server.sh'] } }) : undefined))
    renderFiles()
    const dialog = await createFolder('Mods2')
    const prompt = await screen.findByRole('alertdialog')
    expect(within(prompt).getByText('start-server.sh runs as code when the server starts. Only upload files you trust.')).toBeInTheDocument()
    fireEvent.click(within(prompt).getByRole('button', { name: enFiles.actions.cancel }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(server.callsTo('POST', '/mkdir')).toHaveLength(1)
    expect(dialog).toBeInTheDocument()
  })

  it('an unknown server state gets its own sentence', async () => {
    server.on(({ method, path }) => (method === 'POST' && path.endsWith('/mkdir') ? confirmationRequired(['serverRunning'], { serverState: 'unknown' }) : undefined))
    renderFiles()
    await createFolder('Mods2')
    expect(await within(await screen.findByRole('alertdialog')).findByText(enFiles.confirm.tokens.serverStateUnknown)).toBeInTheDocument()
  })

  it('remembers a serverRunning acknowledgement for the next change on this server', async () => {
    let attempts = 0
    server.on(({ method, path, body }) => {
      if (method !== 'POST' || !path.endsWith('/mkdir')) return undefined
      attempts += 1
      if (!body.confirm.includes('serverRunning')) return confirmationRequired(['serverRunning'])
      return json(201, { entry: makeEntry(body.name, 'dir') })
    })
    renderFiles()
    await createFolder('One')
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: enFiles.confirm.continue }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await createFolder('Two')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(attempts).toBe(3)
    expect(server.callsTo('POST', '/mkdir').map((call) => call.body.confirm)).toEqual([[], ['serverRunning'], ['serverRunning']])
  })
})

describe('Files: names are checked while typing', () => {
  it('shows the rule a name breaks and blocks Create', async () => {
    renderFiles()
    fireEvent.click(await screen.findByRole('button', { name: enFiles.actions.newFolder }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(enFiles.dialogs.newFolder.nameLabel), { target: { value: 'con.txt' } })
    expect(within(dialog).getByRole('alert')).toHaveTextContent(enFiles.nameRules.reservedDeviceName)
    expect(within(dialog).getByRole('button', { name: enFiles.actions.create })).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText(enFiles.dialogs.newFolder.nameLabel), { target: { value: 'notes.zcpupload' } })
    expect(within(dialog).getByRole('alert')).toHaveTextContent(enFiles.nameRules.reservedPanelName)
    expect(server.callsTo('POST', '/mkdir')).toHaveLength(0)
  })
})
