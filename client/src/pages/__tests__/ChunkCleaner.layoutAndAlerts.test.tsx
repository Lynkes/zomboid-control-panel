import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ChunkCleaner from '../ChunkCleaner'
import { chunksApi, serversApi, panelBridgeApi } from '@/lib/api'

// UX restructure (slice C): the "deleting resets areas" caution is a page
// alert under the header, Help is a header button, the header uses the
// registry's Map Cleanup icon (Eraser, not World Map's Map), and on phones
// the save picker comes first, then the map, and Delete rides a bar stuck to
// the bottom of the screen once something is selected.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

// A stable toast: the page's callbacks depend on it, and a new function on
// every render would re-run its effects forever.
const toastApi = vi.hoisted(() => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }))
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => toastApi,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn() },
    chunksApi: { ...actual.chunksApi, getSaves: vi.fn(), getChunks: vi.fn(), getStats: vi.fn() },
    panelBridgeApi: { ...actual.panelBridgeApi, sendCommand: vi.fn() },
  }
})

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function setUp() {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server: null })
  vi.mocked(chunksApi.getSaves).mockResolvedValue({
    saves: [{ name: 'Ashenwood', modified: '2026-08-20T00:00:00.000Z', chunkCount: 1, size: 1024, sizeFormatted: '1.0 KB' }],
    debug: null,
  })
  vi.mocked(chunksApi.getChunks).mockResolvedValue({
    chunks: [{ file: 'chunk_0_0.bin', x: 0, y: 0, size: 1024, modified: '2026-08-20T00:00:00.000Z' }],
    bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    isB42: false,
  })
  vi.mocked(chunksApi.getStats).mockResolvedValue({ saveName: 'Ashenwood', totalSize: 1024, totalSizeFormatted: '1.0 KB', folders: {} })
  vi.mocked(panelBridgeApi.sendCommand).mockResolvedValue({ success: true, data: {} } as never)
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
})

describe('Map Cleanup header and alerts', () => {
  it('shows the delete caution as a page alert and Help as a header toggle', async () => {
    setUp()
    renderPage()
    const header = screen.getByRole('heading', { level: 1, name: 'Map Cleanup' }).closest('section')!
    // The registry's Map Cleanup icon, not World Map's.
    expect(header.querySelector('.lucide-eraser')).not.toBeNull()
    expect(header.querySelector('.lucide-map')).toBeNull()

    const caution = screen.getByText(/Deleting chunks resets those areas/)
    const alert = caution.closest('[role="status"]')
    expect(alert).not.toBeNull()
    // A short title states the stakes; the long sentence is the description.
    expect(within(alert as HTMLElement).getByText("Deleting chunks can't be undone")).toBeInTheDocument()

    const help = within(header).getByRole('button', { name: 'Show help' })
    expect(help).toHaveAttribute('aria-expanded', 'false')
    const panel = document.getElementById('chunk-cleaner-help')!
    expect(panel).not.toBeVisible()
    fireEvent.click(help)
    expect(within(header).getByRole('button', { name: 'Hide help' })).toHaveAttribute('aria-expanded', 'true')
    expect(panel).toBeVisible()
    expect(within(panel).getByText('Select chunks')).toBeInTheDocument()
    await screen.findByRole('button', { name: /^all$/i })
  })
})

describe('Map Cleanup on phones', () => {
  it('puts the save picker before the map, and Delete in a sticky bar once something is selected', async () => {
    setUp()
    renderPage()
    const allButton = await screen.findByRole('button', { name: /^all$/i })
    await waitFor(() => expect(allButton).not.toBeDisabled())

    const saveHeading = screen.getByRole('heading', { name: 'Save' })
    // The map's box (the canvas inside it needs a measured size jsdom lacks).
    const mapBox = document.querySelector('[class*="lg:row-span-4"]')!
    expect(mapBox).not.toBeNull()
    // Document order is phone order: save picker, then the map, then the tools.
    expect(saveHeading.compareDocumentPosition(mapBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(mapBox.compareDocumentPosition(allButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(screen.queryByRole('button', { name: /delete \d+ chunks?/i })).not.toBeInTheDocument()
    fireEvent.click(allButton)
    const deleteButton = await screen.findByRole('button', { name: /delete 1 chunk/i })
    // One Delete button, after the tools, in a bar that sticks to the bottom
    // below lg and sits in the left column from lg.
    expect(screen.getAllByRole('button', { name: /delete \d+ chunks?/i })).toHaveLength(1)
    expect(allButton.compareDocumentPosition(deleteButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const bar = deleteButton.closest('.sticky')
    expect(bar).not.toBeNull()
    expect(bar).toHaveClass('bottom-4', 'lg:static')
  })
})
