import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'

// The account row (name and Sign out) lives in the expanded footer only, and
// the collapsed icon rail is remembered between visits, so a collapsed
// sidebar left no way to sign out. The rail now carries its own button.

const auth = vi.hoisted(() => ({
  authEnabled: true,
  user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] } as { id: string; username: string; role: string; capabilities: string[] } | null,
  logout: vi.fn(),
}))

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    authEnabled: auth.authEnabled,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: auth.logout,
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

function stubDesktop() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 1024px)',
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
  return within(aside.lastElementChild as HTMLElement)
}

beforeEach(() => {
  auth.authEnabled = true
  auth.user = { id: 'u1', username: 'someone', role: 'admin', capabilities: [] }
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [] } as never)
  vi.mocked(serverApi.getStatus).mockResolvedValue({ running: false } as never)
  vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)
  vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0 } as never)
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({ updateAvailable: false } as never)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.2.19' }) })))
  stubDesktop()
  localStorage.setItem('sidebarCollapsed', 'true')
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  auth.logout.mockClear()
  vi.unstubAllGlobals()
})

describe('Layout: signing out from the collapsed icon rail', () => {
  it('offers a Sign out button in the rail and signs out when it is pressed', async () => {
    const footer = renderLayout()
    expect(await footer.findByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()
    fireEvent.click(footer.getByRole('button', { name: 'Sign out' }))
    // After the unsaved-changes check (nothing unsaved here), which is async.
    await waitFor(() => expect(auth.logout).toHaveBeenCalledTimes(1))
  })

  it('shows no Sign out button in the rail when sign-in is off', async () => {
    auth.authEnabled = false
    const footer = renderLayout()
    await footer.findByRole('button', { name: 'Expand sidebar' })
    expect(footer.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
  })

  it('shows no Sign out button in the rail without a signed-in user', async () => {
    auth.user = null
    const footer = renderLayout()
    await footer.findByRole('button', { name: 'Expand sidebar' })
    expect(footer.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
  })

  it('keeps a single Sign out button in the expanded footer', async () => {
    localStorage.setItem('sidebarCollapsed', 'false')
    const footer = renderLayout()
    await footer.findByRole('button', { name: 'Collapse sidebar' })
    expect(footer.getAllByRole('button', { name: 'Sign out' })).toHaveLength(1)
    expect(footer.getByText('someone')).toBeInTheDocument()
  })

  it('names the signed-in user in the rail tooltip, where the name is not shown', async () => {
    const footer = renderLayout()
    const button = await footer.findByRole('button', { name: 'Sign out' })
    fireEvent.focus(button)
    const tips = await within(document.body).findAllByText('someone')
    expect(tips.length).toBeGreaterThan(0)
  })
})
