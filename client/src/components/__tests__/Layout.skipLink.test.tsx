import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { HashRouter, useLocation } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { UnsavedChangesProvider, useUnsavedChangesGuard } from '@/contexts/UnsavedChangesContext'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'

// "Skip to content" was a plain <a href="#main-content">. The public demo
// runs under HashRouter, which read that fragment as a route and showed the
// 404 page; and with unsaved edits the leave-page guard took it for another
// page and asked "Leave without saving?". It now moves focus to the main
// content without touching the address.

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

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname}</output>
}

function Dirty() {
  useUnsavedChangesGuard(true)
  return null
}

beforeEach(() => {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [{ id: 1, name: 'Knox', isRemote: false, isActive: true }] } as never)
  vi.mocked(serverApi.getStatus).mockResolvedValue({ running: true } as never)
  vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)
  vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0 } as never)
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({ updateAvailable: false } as never)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.2.19' }) })))
  window.location.hash = '#/settings'
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('Layout: Skip to content', () => {
  it('focuses the content and stays on the page under the demo\'s HashRouter, without asking', async () => {
    render(
      <HashRouter>
        <ConfirmProvider>
          <UnsavedChangesProvider>
            <SocketContext.Provider value={null}>
              <Layout>
                <Dirty />
                <Where />
              </Layout>
            </SocketContext.Provider>
          </UnsavedChangesProvider>
        </ConfirmProvider>
      </HashRouter>,
    )
    await screen.findByText('Knox')
    expect(screen.getByTestId('where').textContent).toBe('/settings')

    fireEvent.click(screen.getByRole('link', { name: 'Skip to content' }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(window.location.hash).toBe('#/settings')
    expect(screen.getByTestId('where').textContent).toBe('/settings')
    expect(document.activeElement).toBe(document.getElementById('main-content'))
  })
})
