import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import enFiles from '@/locales/en/files.json'
import { FakeFilesServer, makeEntry, makeListing, renderFiles, stubLayout } from './filesTestHarness'

// Spec §A6.7/§A14.2: a folder over 2,000 entries comes back sorted by name
// only (sortLimited) and paged; the table is virtualized, so only a window
// of rows is in the DOM while aria-rowcount still counts all of them.

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

const TOTAL = 2600

function chunk(offset: number, limit: number) {
  return Array.from({ length: Math.min(limit, TOTAL - offset) }, (_, i) =>
    makeEntry(`Saves/map_${String(offset + i).padStart(5, '0')}.bin`, 'file'))
}

describe('Files: a very large folder', () => {
  beforeEach(() => {
    server.on(({ path, url }) => {
      if (!path.endsWith('/list')) return undefined
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 500)
      return new Response(JSON.stringify(makeListing(chunk(offset, limit), {
        total: TOTAL,
        offset,
        limit,
        sortLimited: true,
        dirEtag: 'big-1',
      })), { status: 200, headers: { 'content-type': 'application/json' } })
    })
  })

  it('renders only a window of rows, counts them all, and pages with Load more', async () => {
    renderFiles('/files?server=p1&root=data&path=Saves')

    const table = await screen.findByRole('table')
    await screen.findByRole('button', { name: 'map_00000.bin' })
    expect(table).toHaveAttribute('aria-rowcount', String(500 + 1))
    const rendered = screen.getAllByRole('row').length
    expect(rendered).toBeGreaterThan(5)
    expect(rendered).toBeLessThan(80)
    expect(screen.getByText(enFiles.list.showing.replace('{{shown}}', '500').replace('{{total}}', String(TOTAL)))).toBeInTheDocument()
    expect(screen.getByText(`This folder has ${TOTAL} items, so it can only be sorted by name.`)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: enFiles.list.loadMore }))
    await waitFor(() => expect(table).toHaveAttribute('aria-rowcount', String(1000 + 1)))
    const offsets = server.callsTo('GET', '/list').map((call) => call.url.searchParams.get('offset'))
    expect(offsets).toEqual(['0', '500'])
    // Only name sorting is asked for once the server says the folder is sort-limited.
    expect(server.callsTo('GET', '/list').every((call) => call.url.searchParams.get('sort') === 'name')).toBe(true)
  })

  it('holds all 2,600 names while keeping the DOM to a window', async () => {
    renderFiles('/files?server=p1&root=data&path=Saves')
    const table = await screen.findByRole('table')
    await screen.findByRole('button', { name: 'map_00000.bin' })
    for (let loaded = 500; loaded < TOTAL; loaded += 500) {
      fireEvent.click(screen.getByRole('button', { name: enFiles.list.loadMore }))
      await waitFor(() => expect(table).toHaveAttribute('aria-rowcount', String(Math.min(TOTAL, loaded + 500) + 1)))
    }
    expect(table).toHaveAttribute('aria-rowcount', String(TOTAL + 1))
    expect(screen.queryByRole('button', { name: enFiles.list.loadMore })).not.toBeInTheDocument()
    expect(screen.getAllByRole('row').length).toBeLessThan(80)
  })

  it('rows carry aria-rowindex across the whole folder as it scrolls', async () => {
    renderFiles('/files?server=p1&root=data&path=Saves')
    await screen.findByRole('button', { name: 'map_00000.bin' })
    const indexes = screen.getAllByRole('row').map((row) => Number(row.getAttribute('aria-rowindex')))
    expect(indexes[0]).toBe(1)
    expect(indexes[1]).toBe(2)
    expect(new Set(indexes).size).toBe(indexes.length)
  })

  it('restarts from the top when the folder changes between pages', async () => {
    let etag = 'big-1'
    server.on(({ path, url }) => {
      if (!path.endsWith('/list')) return undefined
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const response = makeListing(chunk(offset, 500), { total: TOTAL, offset, limit: 500, sortLimited: true, dirEtag: etag })
      etag = 'big-2'
      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    renderFiles('/files?server=p1&root=data&path=Saves')
    await screen.findByRole('button', { name: 'map_00000.bin' })
    fireEvent.click(screen.getByRole('button', { name: enFiles.list.loadMore }))
    await waitFor(() => expect(server.callsTo('GET', '/list').map((call) => call.url.searchParams.get('offset'))).toEqual(['0', '500', '0']))
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', String(500 + 1))
  })
})
