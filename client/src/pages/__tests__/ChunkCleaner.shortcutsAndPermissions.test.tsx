import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ChunkCleaner from '../ChunkCleaner'
import { chunksApi, serversApi } from '@/lib/api'

// Four Map Cleanup defects that shipped in v1.4.17:
// - "Press 1/2 to switch tools": 1 and 2 are also the shell's Dashboard and
//   Console shortcuts (a bubble-phase window listener), so the key left the
//   page and the chunk selection was lost.
// - "Save as default" repoints the active server's data folder; the route
//   also wants server.configure, but the button only checked chunks.manage
//   and a role without it got a 403 toast.
// - After an active-server switch the reloaded list picked its FIRST save,
//   not the new active server's (several servers can share one folder).
// - The Map / Vehicles / Safehouses switches and the delete dialog's two
//   switches had no accessible name.

const capabilities = vi.hoisted(() => ({ current: ['chunks.manage', 'server.configure'] as string[] }))
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'custom', capabilities: capabilities.current },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => capabilities.current.includes(capability),
  }),
}))

const toastApi = vi.hoisted(() => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }))
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => toastApi,
}))

const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
const fakeSocket = vi.hoisted(() => ({
  connected: true,
  on: (event: string, handler: () => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: () => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => fakeSocket,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn() },
    chunksApi: { ...actual.chunksApi, getSaves: vi.fn(), getChunks: vi.fn(), getStats: vi.fn(), savePath: vi.fn() },
  }
})

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const save = (name: string) => ({ name, modified: '2026-08-20T00:00:00.000Z', chunkCount: 1, size: 1024, sizeFormatted: '1.0 KB' })

function setUp(saveNames = ['Ashenwood'], activeServerName: string | null = null) {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  vi.mocked(serversApi.getResolvedActive).mockResolvedValue({
    server: activeServerName ? ({ serverName: activeServerName } as never) : null,
  })
  vi.mocked(chunksApi.getSaves).mockResolvedValue({ saves: saveNames.map(save), debug: null })
  vi.mocked(chunksApi.getChunks).mockResolvedValue({
    chunks: [{ file: 'chunk_0_0.bin', x: 0, y: 0, size: 1024, modified: '2026-08-20T00:00:00.000Z' }],
    bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    isB42: false,
  })
  vi.mocked(chunksApi.getStats).mockResolvedValue({ saveName: saveNames[0], totalSize: 1024, totalSizeFormatted: '1.0 KB', folders: {} })
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/chunks']}>
      <ChunkCleaner />
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  socketHandlers.clear()
  capabilities.current = ['chunks.manage', 'server.configure']
})

describe('Map Cleanup tool keys', () => {
  it('1 and 2 switch the tool on the page and never reach the shell shortcuts', async () => {
    setUp()
    renderPage()
    const allButton = await screen.findByRole('button', { name: /^all$/i })
    await waitFor(() => expect(allButton).not.toBeDisabled())

    // Stands in for useKeyboardShortcuts' window listener (1 = Dashboard, 2 = Console).
    const shell = vi.fn()
    window.addEventListener('keydown', shell)
    try {
      fireEvent.keyDown(document.body, { key: '2' })
      expect(screen.getByRole('button', { name: 'Pan tool' })).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByRole('button', { name: 'Select tool' })).toHaveAttribute('aria-pressed', 'false')
      fireEvent.keyDown(document.body, { key: '1' })
      expect(screen.getByRole('button', { name: 'Select tool' })).toHaveAttribute('aria-pressed', 'true')
      expect(shell).not.toHaveBeenCalled()

      // Other keys still reach the shell.
      fireEvent.keyDown(document.body, { key: '3' })
      expect(shell).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', shell)
    }
  })
})

describe('Map Cleanup "Save as default"', () => {
  async function openCustomPath() {
    renderPage()
    await screen.findByRole('button', { name: /^all$/i })
    fireEvent.click(screen.getByRole('button', { name: /custom path/i }))
    const input = await screen.findByRole('textbox', { name: /custom server path/i })
    fireEvent.change(input, { target: { value: 'D:\\OtherZomboid' } })
    fireEvent.click(screen.getByRole('button', { name: /^load$/i }))
    return screen.findByRole('button', { name: 'Save as default' })
  }

  it('is offered to a role that may repoint the server folder', async () => {
    setUp()
    const button = await openCustomPath()
    await waitFor(() => expect(button).toBeEnabled())
  })

  it('is disabled, with the reason, without server.configure', async () => {
    capabilities.current = ['chunks.manage']
    setUp()
    const button = await openCustomPath()
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(chunksApi.savePath).not.toHaveBeenCalled()
  })
})

describe('Map Cleanup after an active-server switch', () => {
  it('opens the new active server\'s save, not the first one in the folder', async () => {
    setUp(['Alpha', 'Bravo'], 'Alpha')
    renderPage()
    await waitFor(() => expect(chunksApi.getChunks).toHaveBeenCalledWith('Alpha', undefined, expect.anything()))

    vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server: { serverName: 'Bravo' } as never })
    vi.mocked(chunksApi.getChunks).mockClear()
    socketHandlers.get('activeServerChanged')?.forEach((h) => h())

    await waitFor(() => expect(chunksApi.getChunks).toHaveBeenLastCalledWith('Bravo', undefined, expect.anything()))
  })
})

describe('Map Cleanup switches', () => {
  it('are named after their labels', async () => {
    setUp()
    renderPage()
    await screen.findByRole('button', { name: /^all$/i })
    expect(screen.getByRole('switch', { name: 'Map' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /^Vehicles/ })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /^Safehouses/ })).toBeInTheDocument()
  })

  it('in the delete confirm are named after their labels too', async () => {
    setUp()
    renderPage()
    const allButton = await screen.findByRole('button', { name: /^all$/i })
    await waitFor(() => expect(allButton).not.toBeDisabled())
    fireEvent.click(allButton)
    fireEvent.click(await screen.findByRole('button', { name: /delete 1 chunk/i }))
    expect(await screen.findByRole('switch', { name: 'Create safety backup' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Remove vehicles from save database' })).toBeInTheDocument()
  })
})
