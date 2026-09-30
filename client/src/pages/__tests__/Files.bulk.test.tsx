import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import i18n from '@/i18n'
import enFiles from '@/locales/en/files.json'
import ukFiles from '@/locales/uk/files.json'
import { FM_LIMITS } from '@/types/files'
import { FakeFilesServer, currentParams, fmError, json, makeEntry, makeListing, renderFiles, stubLayout } from './filesTestHarness'

// Selections: more paths than one request may name (the server takes
// FM_LIMITS.PATHS_PER_REQUEST), a folder holding a protected area, the
// delete sentence in a language whose "one" plural covers 21, Move on a
// search result, and the keys pressed on "Select all".

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

let server: FakeFilesServer
let restoreLayout: () => void

beforeEach(() => {
  localStorage.clear()
  server = new FakeFilesServer()
  server.install()
  restoreLayout = stubLayout()
})

afterEach(async () => {
  cleanup()
  restoreLayout()
  vi.unstubAllGlobals()
  localStorage.clear()
  await i18n.changeLanguage('en')
})

function previewOf(paths: string[], overrides?: (path: string) => Record<string, unknown>) {
  return {
    items: paths.map((path) => ({ path, type: 'file', files: 1, dirs: 0, bytes: 1234, truncated: false, worldState: false, containsProtected: false, ...overrides?.(path) })),
    totals: { files: paths.length, dirs: 0, bytes: 1234 * paths.length },
    required: [],
    trashAvailable: true,
    previewId: PREVIEW_ID,
    expiresAt: '2026-09-30T00:00:00.000Z',
  }
}

describe('Files: a selection bigger than one request', () => {
  const COUNT = 250
  const maxPathsSent = (suffix: string) => Math.max(0, ...server.callsTo('POST', suffix).map((call) => call.body.paths.length))

  beforeEach(() => {
    const logs = Array.from({ length: COUNT }, (_, i) => makeEntry(`Logs/${String(i).padStart(3, '0')}_DebugLog-server.txt`))
    server.listings.set('data|Logs', makeListing(logs))
    server.listings.set('data|', makeListing([makeEntry('Logs', 'dir'), makeEntry('Archive', 'dir')]))
    // What the real server answers for more than PATHS_PER_REQUEST paths.
    server.on(({ method, path, body }) => {
      if (method === 'POST' && /\/(delete\/preview|zip|move|delete)$/.test(path) && Array.isArray(body?.paths) && body.paths.length > FM_LIMITS.PATHS_PER_REQUEST) {
        return fmError(400, 'FM_INVALID_REQUEST', { field: 'paths' })
      }
      return undefined
    })
  })

  async function selectAll() {
    renderFiles('/files?server=p1&root=data&path=Logs')
    await screen.findByRole('checkbox', { name: 'Select 000_DebugLog-server.txt' })
    fireEvent.click(screen.getByRole('checkbox', { name: enFiles.list.selectAll }))
    return screen.findByRole('region', { name: `${COUNT} selected` })
  }

  it('Delete previews in parts, asks once, and trashes every part', async () => {
    let part = 0
    server.on(({ method, path, body }) => {
      if (method === 'POST' && path.endsWith('/delete/preview')) {
        part += 1
        return json(200, { ...previewOf(body.paths), previewId: String(part).repeat(32) })
      }
      if (method === 'POST' && path.endsWith('/delete')) {
        const paths = body.previewId === '1'.repeat(32) ? 200 : 50
        return json(200, { trashed: Array.from({ length: paths }, (_, i) => ({ path: `x${i}`, trashId: `20260929T120000Z-${String(i).padStart(8, '0')}` })), failed: [] })
      }
      return undefined
    })
    const bar = await selectAll()
    fireEvent.click(within(bar).getByRole('button', { name: enFiles.actions.delete }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(new RegExp(`Move ${COUNT} items`))).toBeInTheDocument()
    expect(maxPathsSent('/delete/preview')).toBeLessThanOrEqual(FM_LIMITS.PATHS_PER_REQUEST)
    expect(server.callsTo('POST', '/delete/preview')).toHaveLength(2)

    fireEvent.click(within(dialog).getByRole('button', { name: enFiles.actions.delete }))
    await waitFor(() => expect(server.callsTo('POST', '/delete')).toHaveLength(2))
    expect(server.callsTo('POST', '/delete').map((call) => call.body.previewId)).toEqual(['1'.repeat(32), '2'.repeat(32)])
    expect(await screen.findByText(`Moved ${COUNT} items to Trash.`)).toBeInTheDocument()
    expect(screen.queryAllByRole('alertdialog')).toHaveLength(0)
    expect(screen.queryAllByText(/Reload the page/)).toHaveLength(0)
  })

  it('Download as .zip says how many fit instead of sending them all', async () => {
    const bar = await selectAll()
    fireEvent.click(within(bar).getByRole('button', { name: enFiles.actions.downloadZip }))
    expect(await screen.findByText(enFiles.download.zipTooMany.replace('{{limit}}', String(FM_LIMITS.PATHS_PER_REQUEST)))).toBeInTheDocument()
    expect(server.callsTo('POST', '/zip')).toHaveLength(0)
    expect(screen.queryAllByText(/Reload the page/)).toHaveLength(0)
  })

  it('Move sends the selection in parts', async () => {
    server.on(({ method, path, body }) => (method === 'POST' && path.endsWith('/move')
      ? json(200, { moved: body.paths.map((p: string) => ({ from: p, to: p })), failed: [] })
      : undefined))
    const bar = await selectAll()
    fireEvent.click(within(bar).getByRole('button', { name: enFiles.actions.move }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: enFiles.list.parent }))
    const moveButton = within(dialog).getByRole('button', { name: enFiles.actions.move })
    await waitFor(() => expect((moveButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(moveButton)
    await waitFor(() => expect(server.callsTo('POST', '/move')).toHaveLength(2))
    expect(server.callsTo('POST', '/move').map((call) => call.body.paths.length)).toEqual([200, 50])
    expect(screen.queryAllByText(/Reload the page/)).toHaveLength(0)
  })
})

describe('Files: deleting a folder that holds a protected area', () => {
  it('says why instead of offering a Delete the server always refuses', async () => {
    server.listings.set('data|', makeListing([makeEntry('Lua', 'dir'), makeEntry('Server', 'dir')]))
    server.on(({ method, path, body }) => {
      if (method === 'POST' && path.endsWith('/delete/preview')) {
        return json(200, previewOf(body.paths, (p) => ({ type: 'dir', containsProtected: p === 'Lua' })))
      }
      if (method === 'POST' && path.endsWith('/delete')) return fmError(403, 'FM_PATH_PROTECTED', { area: 'bridgeIo', level: 'readOnly', containsProtected: true })
      return undefined
    })
    renderFiles('/files?server=p1&root=data&path=')
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Lua' }))
    const bar = await screen.findByRole('region', { name: '1 selected' })
    fireEvent.click(within(bar).getByRole('button', { name: enFiles.actions.delete }))
    await waitFor(() => expect(server.callsTo('POST', '/delete/preview')).toHaveLength(1))
    expect(await screen.findByText(enFiles.protected.containsProtected)).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(server.callsTo('POST', '/delete')).toHaveLength(0)
  })
})

describe('Files: the delete sentence in Ukrainian', () => {
  it('21 items (CLDR "one" in uk) name the count, not an empty single item', async () => {
    const N = 21
    await i18n.changeLanguage('uk')
    await i18n.loadNamespaces(['files', 'errors', 'shell', 'common'])
    const logs = Array.from({ length: N }, (_, i) => makeEntry(`Logs/log${String(i).padStart(2, '0')}.txt`))
    server.listings.set('data|Logs', makeListing(logs))
    server.on(({ method, path, body }) => (method === 'POST' && path.endsWith('/delete/preview') ? json(200, previewOf(body.paths)) : undefined))
    renderFiles('/files?server=p1&root=data&path=Logs')
    await screen.findByRole('checkbox', { name: ukFiles.list.selectItem.replace('{{name}}', 'log00.txt') })
    fireEvent.click(screen.getByRole('checkbox', { name: ukFiles.list.selectAll }))
    const bar = await screen.findByRole('region', { name: `Вибрано: ${N}` })
    fireEvent.click(within(bar).getByRole('button', { name: ukFiles.actions.delete }))
    const prompt = await screen.findByRole('alertdialog')
    const description = within(prompt).getAllByText(/кошика/)[0].textContent ?? ''
    expect(description).toContain(`Перемістити ${N} елемент `)
    expect(description).not.toMatch(/Перемістити\s{2}\(/)
  })
})

describe('Files: Move on a search result', () => {
  it('allows the folder that was searched and refuses the item\'s own folder', async () => {
    server.listings.set('data|', makeListing([makeEntry('Server', 'dir'), makeEntry('Logs', 'dir')]))
    server.listings.set('data|Server', makeListing([makeEntry('Server/servertest_SandboxVars.lua')]))
    server.listings.set('data|Logs', makeListing([]))
    server.on(({ method, path }) => (method === 'GET' && path.endsWith('/search')
      ? json(200, { results: [makeEntry('Server/servertest_SandboxVars.lua')], truncated: false, scanned: 3 })
      : undefined))
    renderFiles('/files?server=p1&root=data&path=')
    await screen.findByRole('button', { name: 'Server' })
    const box = screen.getByRole('textbox', { name: enFiles.list.filterPlaceholder })
    fireEvent.change(box, { target: { value: 'servertest' } })
    fireEvent.submit(box.closest('form')!)
    const more = await screen.findByRole('button', { name: 'More actions for servertest_SandboxVars.lua' })
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: enFiles.actions.move }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('button', { name: /Server/ })
    const moveButton = () => within(dialog).getAllByRole('button', { name: enFiles.actions.move }).at(-1) as HTMLButtonElement
    expect(moveButton().disabled).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: /Server/ }))
    await waitFor(() => expect(within(dialog).getByText('Server', { selector: 'bdi' })).toBeInTheDocument())
    await waitFor(() => expect(moveButton().disabled).toBe(true))
  })
})

describe('Files: keys pressed on "Select all"', () => {
  beforeEach(() => {
    server.listings.set('data|', makeListing([makeEntry('Server', 'dir'), makeEntry('a.txt')]))
    server.listings.set('data|Server', makeListing([makeEntry('Server/servertest.ini')]))
    server.on(({ method, path, body }) => (method === 'POST' && path.endsWith('/delete/preview') ? json(200, previewOf(body.paths)) : undefined))
  })

  it('Enter does not open the first row', async () => {
    renderFiles('/files?server=p1&root=data&path=')
    await screen.findByRole('button', { name: 'a.txt' })
    const selectAll = screen.getByRole('checkbox', { name: enFiles.list.selectAll })
    selectAll.focus()
    fireEvent.keyDown(selectAll, { key: 'Enter' })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    expect(currentParams(screen.getByTestId).get('path')).toBe('')
  })

  it('Delete with nothing selected does not offer to delete a row', async () => {
    renderFiles('/files?server=p1&root=data&path=')
    await screen.findByRole('button', { name: 'a.txt' })
    const selectAll = screen.getByRole('checkbox', { name: enFiles.list.selectAll })
    selectAll.focus()
    fireEvent.keyDown(selectAll, { key: 'Delete' })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    expect(server.callsTo('POST', '/delete/preview')).toHaveLength(0)
  })
})
