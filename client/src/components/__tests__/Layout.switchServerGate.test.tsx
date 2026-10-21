import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { UnsavedChangesProvider } from '@/contexts/UnsavedChangesContext'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'

// Making another server active is POST /servers/:id/activate, which needs
// servers.manage. The active-server menu offered every server to every role,
// and a role without it got a bare "Switch failed" toast. The other servers
// are now listed but disabled, with the reason, and nothing is sent.

const auth = vi.hoisted(() => ({ can: (_capability: string) => true }))

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    authEnabled: false,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => auth.can(capability),
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
  vi.mocked(serversApi.getAll).mockResolvedValue({
    servers: [
      { id: 1, name: 'Knox', isRemote: false, isActive: true },
      { id: 2, name: 'Rosewood', isRemote: false, isActive: false },
    ],
  } as never)
  vi.mocked(serversApi.activate).mockResolvedValue({} as never)
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
  auth.can = () => true
})

function renderShell() {
  return render(
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
}

async function openServerMenu() {
  const strip = (await screen.findByText('Knox')).closest('button')!
  fireEvent.pointerDown(strip, { button: 0, ctrlKey: false })
  return screen.findByRole('menu')
}

describe('Layout: switching the active server needs servers.manage', () => {
  it('lists the other servers disabled, says why, and sends nothing', async () => {
    auth.can = (capability) => capability !== 'servers.manage'
    renderShell()
    const menu = await openServerMenu()
    expect(within(menu).getByText(/servers\.manage/)).toBeInTheDocument()
    const rosewood = within(menu).getByRole('menuitem', { name: /Rosewood/ })
    expect(rosewood).toHaveAttribute('data-disabled')
    fireEvent.click(rosewood)
    expect(serversApi.activate).not.toHaveBeenCalled()
  })

  it('switches for a role that has it', async () => {
    renderShell()
    const menu = await openServerMenu()
    expect(within(menu).queryByText(/servers\.manage/)).not.toBeInTheDocument()
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Rosewood/ }))
    expect(serversApi.activate).toHaveBeenCalledWith(2)
  })
})
