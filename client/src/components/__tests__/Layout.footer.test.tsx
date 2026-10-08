import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'

// The sidebar footer (feat/kofi-button): the update badge folded into the
// version so the toolbar fits in 231px, the icon rail kept to lg so a rail
// saved on desktop can't strand the mobile drawer without its expand
// button, and Escape closing only the innermost layer in the drawer.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: false,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    serverApi: { ...actual.serverApi, getStatus: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    modsApi: { ...actual.modsApi, getStatus: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn() },
  }
})

const panelUpdateGetStatus = vi.mocked(panelUpdateApi.getStatus)

// Only the sidebar's lg query is answered; anything else reads as no match.
function stubViewport({ lg }: { lg: boolean }) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 1024px)' ? lg : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

function renderLayout() {
  const view = render(
    <MemoryRouter>
      <SocketContext.Provider value={null}>
        <Layout>
          <div>page content</div>
        </Layout>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
  const aside = view.container.querySelector('aside')!
  // Role queries over the whole shell are slow, and the header repeats the
  // version; the footer is the aside's last block, so scope to it.
  const footer = () => within(aside.lastElementChild as HTMLElement)
  return { aside, footer }
}

beforeEach(() => {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [] } as never)
  vi.mocked(serverApi.getStatus).mockResolvedValue({ running: false } as never)
  vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)
  vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0 } as never)
  panelUpdateGetStatus.mockResolvedValue({ updateAvailable: false } as never)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.2.19' }) })))
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('Layout footer', () => {
  it('shows the plain version when no panel update is waiting', async () => {
    const { footer } = renderLayout()
    const version = await footer().findByText('v1.2.19')
    expect(version.closest('a')).toBeNull()
  })

  it('turns the version into the link to Settings > Updates when a panel update is waiting', async () => {
    panelUpdateGetStatus.mockResolvedValue({ updateAvailable: true, latestVersion: '1.2.20' } as never)
    const { footer } = renderLayout()
    await waitFor(() => expect(footer().getByText('v1.2.19').closest('a')).not.toBeNull())
    const link = footer().getByText('v1.2.19').closest('a')!
    // The name is the link text: jsdom loads no CSS, so it reads the sr-only
    // span as inline and drops its leading space; browsers keep it.
    expect(link.textContent).toBe('v1.2.19 Update')
    expect(link).not.toHaveAttribute('aria-label')
    expect(link).toHaveAttribute('href', '/settings?tab=updates')
    expect(link).toHaveAttribute('title', expect.stringContaining('1.2.20'))
  })

  it('names the Ko-fi link by its visible text', async () => {
    const { footer } = renderLayout()
    const link = (await footer().findByText('Support me on Ko-fi')).closest('a')!
    expect(link.textContent).toBe('Support me on Ko-fi (opens in new tab)')
    expect(link).not.toHaveAttribute('aria-label')
  })

  it('keeps the icon rail on desktop when the sidebar was collapsed', async () => {
    localStorage.setItem('sidebarCollapsed', 'true')
    stubViewport({ lg: true })
    const { footer } = renderLayout()
    expect(await footer().findByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()
    expect(footer().queryByText('Support me on Ko-fi')).not.toBeInTheDocument()
  })

  it('shows the full drawer below lg even when the sidebar was collapsed on desktop', async () => {
    localStorage.setItem('sidebarCollapsed', 'true')
    stubViewport({ lg: false })
    const { footer } = renderLayout()
    expect(await footer().findByText('Support me on Ko-fi')).toBeInTheDocument()
    expect(footer().queryByRole('button', { name: 'Expand sidebar' })).not.toBeInTheDocument()
  })

  it('leaves the mobile drawer open when a popover or menu inside it already handled Escape', async () => {
    stubViewport({ lg: false })
    const { aside } = renderLayout()
    fireEvent.click(document.querySelector('button[aria-label="Open menu"]')!)
    expect(aside.className).toMatch(/(^|\s)translate-x-0(\s|$)/)

    // What a Radix layer does with an Escape it dismisses on.
    const handledByLayer = (event: KeyboardEvent) => event.preventDefault()
    document.addEventListener('keydown', handledByLayer, { capture: true })
    fireEvent.keyDown(document, { key: 'Escape' })
    document.removeEventListener('keydown', handledByLayer, { capture: true })
    expect(aside.className).toMatch(/(^|\s)translate-x-0(\s|$)/)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(aside.className).toMatch(/-translate-x-full/)
  })
})
