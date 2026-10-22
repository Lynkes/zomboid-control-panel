import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SocketContext } from '@/contexts/SocketContext'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { UnsavedChangesProvider, useUnsavedChangesGuard } from '@/contexts/UnsavedChangesContext'
import Layout from '../Layout'
import { serversApi, serverApi, updateApi, modsApi, panelUpdateApi } from '@/lib/api'

// Sign out replaces the whole app with the sign-in screen, without a page
// load (so no beforeunload either): with a page holding unsaved edits, the
// sidebar's Sign out button dropped them without the "Leave without
// saving?" question every link and shortcut asks.

const logout = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout,
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

function Dirty({ dirty }: { dirty: boolean }) {
  useUnsavedChangesGuard(dirty)
  return null
}

function renderShell({ dirty }: { dirty: boolean }) {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <ConfirmProvider>
        <UnsavedChangesProvider>
          <SocketContext.Provider value={null}>
            <Layout>
              <Dirty dirty={dirty} />
            </Layout>
          </SocketContext.Provider>
        </UnsavedChangesProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [{ id: 1, name: 'Knox', isRemote: false, isActive: true }] } as never)
  vi.mocked(serverApi.getStatus).mockResolvedValue({ running: true } as never)
  vi.mocked(updateApi.getStatus).mockResolvedValue({} as never)
  vi.mocked(modsApi.getStatus).mockResolvedValue({ updatesAvailable: 0 } as never)
  vi.mocked(panelUpdateApi.getStatus).mockResolvedValue({ updateAvailable: false } as never)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.2.19' }) })))
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('Layout: Sign out with unsaved edits', () => {
  it('asks first, keeps the session on "Keep editing", signs out on "Discard and leave"', async () => {
    renderShell({ dirty: true })
    await screen.findByText('Knox')

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    let dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Leave without saving?')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    await act(async () => {})
    expect(logout).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard and leave' }))
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
  })

  it('asks from the collapsed rail\'s Sign out too', async () => {
    localStorage.setItem('sidebarCollapsed', 'true')
    renderShell({ dirty: true })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    expect(logout).not.toHaveBeenCalled()
  })

  it('signs out straight away when nothing is unsaved', async () => {
    renderShell({ dirty: false })
    await screen.findByText('Knox')
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
