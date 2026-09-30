import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import enFiles from '@/locales/en/files.json'
import { forgetServerRunningAcks } from '@/lib/filesApi'
import {
  FakeFilesServer,
  currentParams,
  fmError,
  json,
  makeEntry,
  makeListing,
  makeText,
  renderFiles,
  stubLayout,
} from './filesTestHarness'

// Spec §A14.3 Editor: a stressed operator must never lose typed work. The
// unsaved-changes guard covers Close, Esc and the Back button, beforeunload
// is registered only while dirty, Ctrl+S saves, a save conflict offers
// Reload / Copy my text / Save anyway, masked .ini secrets get their own
// callout, and file content never reaches browser storage.

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

const INI = makeEntry('Server/servertest.ini')
const ORIGINAL = 'PVP=true\nPassword=•••\n'
const SENTINEL = 'SENTINEL_CONTENT_7f3a'

let server: FakeFilesServer
let restoreLayout: () => void

beforeEach(() => {
  forgetServerRunningAcks()
  server = new FakeFilesServer()
  server.install()
  restoreLayout = stubLayout()
  server.listings.set('data|Server', makeListing([INI]))
  server.texts.set('data|Server/servertest.ini', makeText(INI, ORIGINAL, {
    masked: true,
    hints: ['restartToApply', 'secretsMasked'],
  }))
})

afterEach(() => {
  cleanup()
  restoreLayout()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
})

async function openEditor() {
  renderFiles('/files?server=p1&root=data&path=Server')
  fireEvent.click(await screen.findByRole('button', { name: 'servertest.ini' }))
  const textarea = await screen.findByRole('textbox', { name: 'servertest.ini' })
  await waitFor(() => expect(textarea).toHaveValue(ORIGINAL))
  return textarea as HTMLTextAreaElement
}

function closeButton() {
  return within(screen.getByRole('dialog')).getAllByRole('button', { name: enFiles.actions.close })[0]
}

describe('Files editor', () => {
  it('shows masked secrets and hints as neutral callouts, and keeps the text left-to-right', async () => {
    const textarea = await openEditor()
    const masked = screen.getByText(enFiles.editor.hints.secretsMasked)
    expect(masked.closest('[role="alert"]')?.className).toContain('bg-muted/40')
    expect(screen.getByText(enFiles.editor.hints.restartToApply)).toBeInTheDocument()
    expect(textarea).toHaveAttribute('dir', 'ltr')
    expect(textarea).toHaveAttribute('spellcheck', 'false')
    expect(currentParams(screen.getByTestId).get('open')).toBe('servertest.ini')
  })

  it('Ctrl+S saves what was typed with the etag it loaded', async () => {
    server.on(({ method, path }) => (method === 'PUT' && path.endsWith('/text')
      ? json(200, { entry: INI, etag: 'h:saved', previousVersion: { trashId: '20260929T120000Z-a1b2c3d4' }, restartRequired: true, hints: ['restartToApply'] })
      : undefined))
    const textarea = await openEditor()
    fireEvent.change(textarea, { target: { value: `${ORIGINAL}MaxPlayers=32\n` } })
    expect(screen.getAllByText(enFiles.editor.unsaved).length).toBeGreaterThan(0)

    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true })

    await waitFor(() => expect(server.callsTo('PUT', '/text')).toHaveLength(1))
    expect(server.callsTo('PUT', '/text')[0].body).toEqual({
      root: 'data',
      path: 'Server/servertest.ini',
      content: `${ORIGINAL}MaxPlayers=32\n`,
      etag: 'h:original',
      eol: 'lf',
      bom: false,
      confirm: [],
    })
    expect(await screen.findByText(enFiles.editor.previousVersion)).toBeInTheDocument()
    expect(screen.queryByText(enFiles.editor.unsaved)).not.toBeInTheDocument()
  })

  it('Tab inserts a tab character instead of leaving the field', async () => {
    const textarea = await openEditor()
    textarea.setSelectionRange(0, 0)
    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(textarea.value.startsWith('\t')).toBe(true)
  })

  it('closing with unsaved changes asks first; Cancel keeps the text', async () => {
    const textarea = await openEditor()
    fireEvent.change(textarea, { target: { value: 'typed work' } })
    fireEvent.click(closeButton())

    const prompt = await screen.findByRole('alertdialog')
    expect(within(prompt).getByText('Discard your changes to servertest.ini?')).toBeInTheDocument()
    fireEvent.click(within(prompt).getByRole('button', { name: enFiles.actions.cancel }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'servertest.ini' })).toHaveValue('typed work')

    fireEvent.click(closeButton())
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: enFiles.confirm.discardConfirm }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('the Back button runs the same guard, and Cancel keeps the editor and its URL', async () => {
    const textarea = await openEditor()
    fireEvent.change(textarea, { target: { value: 'typed work' } })

    fireEvent.click(screen.getByTestId('history-back'))

    const prompt = await screen.findByRole('alertdialog')
    fireEvent.click(within(prompt).getByRole('button', { name: enFiles.actions.cancel }))
    await waitFor(() => expect(currentParams(screen.getByTestId).get('open')).toBe('servertest.ini'))
    expect(screen.getByRole('textbox', { name: 'servertest.ini' })).toHaveValue('typed work')
  })

  it('Back with nothing typed just closes', async () => {
    await openEditor()
    fireEvent.click(screen.getByTestId('history-back'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('registers beforeunload only while there are unsaved changes', async () => {
    const textarea = await openEditor()
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)

    fireEvent.change(textarea, { target: { value: 'typed work' } })
    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)
  })

  it('never writes file content to browser storage', async () => {
    const localSet = vi.spyOn(Storage.prototype, 'setItem')
    server.on(({ method, path }) => (method === 'PUT' && path.endsWith('/text')
      ? json(200, { entry: INI, etag: 'h:saved', previousVersion: null, restartRequired: false, hints: [] })
      : undefined))
    const textarea = await openEditor()
    fireEvent.change(textarea, { target: { value: `${ORIGINAL}${SENTINEL}\n` } })
    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true })
    await waitFor(() => expect(server.callsTo('PUT', '/text')).toHaveLength(1))
    for (const call of localSet.mock.calls) {
      expect(String(call[1])).not.toContain(SENTINEL)
      expect(String(call[1])).not.toContain('Password=')
    }
  })
})

describe('Files editor: a save conflict', () => {
  beforeEach(() => {
    server.on(({ method, path, body }) => {
      if (method !== 'PUT' || !path.endsWith('/text')) return undefined
      if (body.etag === 'h:newer') return json(200, { entry: INI, etag: 'h:mine', previousVersion: null, restartRequired: false, hints: [] })
      return fmError(409, 'FM_CONFLICT', { currentEtag: 'h:newer' })
    })
  })

  async function conflict() {
    const textarea = await openEditor()
    fireEvent.change(textarea, { target: { value: 'my version' } })
    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true })
    const alert = (await screen.findByText(enFiles.editor.conflict.title)).closest('[role="alert"]') as HTMLElement
    expect(within(alert).getByText(enFiles.editor.conflict.description)).toBeInTheDocument()
    return alert
  }

  it('Save anyway confirms, then saves over the newer version with its etag', async () => {
    const alert = await conflict()
    fireEvent.click(within(alert).getByRole('button', { name: enFiles.actions.saveAnyway }))
    const prompt = await screen.findByRole('alertdialog')
    expect(within(prompt).getByText(enFiles.confirm.saveAnywayTitle)).toBeInTheDocument()
    expect(within(prompt).getByText(enFiles.confirm.saveAnywayBody)).toBeInTheDocument()
    fireEvent.click(within(prompt).getByRole('button', { name: enFiles.actions.saveAnyway }))

    await waitFor(() => expect(server.callsTo('PUT', '/text')).toHaveLength(2))
    expect(server.callsTo('PUT', '/text').map((call) => call.body.etag)).toEqual(['h:original', 'h:newer'])
    await waitFor(() => expect(screen.queryByText(enFiles.editor.conflict.title)).not.toBeInTheDocument())
  })

  it('Copy my text puts the typed text on the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText } }))
    vi.stubGlobal('isSecureContext', true)
    const alert = await conflict()
    fireEvent.click(within(alert).getByRole('button', { name: enFiles.actions.copyMyText }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('my version'))
    expect(server.callsTo('PUT', '/text')).toHaveLength(1)
  })

  it('Reload replaces my text with the version on disk', async () => {
    const alert = await conflict()
    server.texts.set('data|Server/servertest.ini', makeText(INI, 'PVP=false\n', { etag: 'h:newer' }))
    fireEvent.click(within(alert).getByRole('button', { name: enFiles.actions.reload }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'servertest.ini' })).toHaveValue('PVP=false\n'))
    expect(screen.queryByText(enFiles.editor.conflict.title)).not.toBeInTheDocument()
  })
})
