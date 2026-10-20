import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { UnsavedChangesProvider } from '@/contexts/UnsavedChangesContext'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'

// The phone drawer was pinned with left-0 and hidden with -translate-x-full:
// in Arabic (dir="rtl") the menu button sits at the right edge and the
// desktop sidebar on the right, but the drawer still slid in from the left.
// It now starts at the inline start and, closed, moves out past that edge.
// (jsdom computes no layout: this checks the classes that do it; the
// positions were measured in a browser at 390px in both directions.)

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: null,
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
    serversApi: { ...actual.serversApi, getAll: vi.fn(), activate: vi.fn() },
    serverApi: { ...actual.serverApi, getStatus: vi.fn() },
    updateApi: { ...actual.updateApi, getStatus: vi.fn() },
    modsApi: { ...actual.modsApi, getStatus: vi.fn() },
    panelUpdateApi: { ...actual.panelUpdateApi, getStatus: vi.fn() },
  }
})

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [{ id: 1, name: 'Knox', isRemote: false, isActive: true }] } as never)
  vi.mocked(serverApi.getStatus).mockResolvedValue({ running: true } as never)
  vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)
  vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0 } as never)
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({ updateAvailable: false } as never)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.2.19' }) })))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('Layout: the phone drawer follows the reading direction', () => {
  it('is pinned to the inline start and slides out past it in both directions', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <ConfirmProvider>
          <UnsavedChangesProvider>
            <SocketContext.Provider value={null}>
              <Layout>
                <p>page</p>
              </Layout>
            </SocketContext.Provider>
          </UnsavedChangesProvider>
        </ConfirmProvider>
      </MemoryRouter>,
    )
    const drawer = screen.getByRole('complementary', { name: 'Sidebar' })
    expect(drawer).toHaveClass('start-0')
    expect(drawer).not.toHaveClass('left-0')
    // Closed: off the left edge in LTR, off the right edge in RTL.
    expect(drawer).toHaveClass('-translate-x-full', 'rtl:translate-x-full')
    // On desktop it is a column in the flow, whatever the direction.
    expect(drawer).toHaveClass('lg:translate-x-0', 'lg:rtl:translate-x-0')

    fireEvent.click(await screen.findByRole('button', { name: 'Open menu' }))
    expect(drawer).toHaveClass('translate-x-0')
    expect(drawer).not.toHaveClass('rtl:translate-x-full')
  })
})
