import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Users from '../Users'
import { usersApi, permissionsApi, type ManagedUserAccount } from '@/lib/api'

// SECURITY (2026-10-08, #13): linked SSO identities used to be invisible and
// could only be removed by deleting the account, and a successful link said
// nothing about WHOSE identity was linked -- an admin with a live provider
// session could link their own identity to someone else's account unaware.

const toastSpy = vi.hoisted(() => vi.fn())

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    usersApi: { ...actual.usersApi, list: vi.fn(), unlinkExternalIdentities: vi.fn() },
    permissionsApi: { ...actual.permissionsApi, getRoles: vi.fn() },
  }
})

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'current-admin', username: 'admin', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

const listUsers = vi.mocked(usersApi.list)
const unlink = vi.mocked(usersApi.unlinkExternalIdentities)
const getRoles = vi.mocked(permissionsApi.getRoles)

const alice: ManagedUserAccount = {
  id: 'u1',
  username: 'alice',
  role: 'moderator',
  roleId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLogin: null,
  externalIdentities: [
    { issuer: 'https://sso.example', subject: '••••4321', email: 'alice@example.com', linkedAt: '2026-10-01T00:00:00.000Z' },
  ],
}

function renderUsers() {
  return render(
    <MemoryRouter>
      <ConfirmProvider>
        <Users />
      </ConfirmProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  toastSpy.mockReset()
  getRoles.mockReset().mockResolvedValue({ roles: [] })
  listUsers.mockReset().mockResolvedValue({ users: [alice] })
  unlink.mockReset()
})

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('Users -- linked SSO identities', () => {
  it('lists the linked address and unlinks it after confirmation', async () => {
    unlink.mockResolvedValue({ success: true, user: { id: 'u1', username: 'alice' }, removed: 1 })
    renderUsers()

    expect(await screen.findByText('SSO: alice@example.com')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Unlink SSO from alice' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlink SSO' }))

    await waitFor(() => expect(unlink).toHaveBeenCalledWith('u1'))
    await waitFor(() => expect(screen.queryByText('SSO: alice@example.com')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Unlink SSO from alice' })).not.toBeInTheDocument()
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'SSO unlinked' }))
  })

  it('names the linked address in the success toast after a link', async () => {
    window.history.replaceState(null, '', '/settings?tab=users&oidcSuccess=linked&linkedUser=u1')
    renderUsers()

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'SSO linked',
          description: expect.stringContaining('alice@example.com'),
        }),
      ),
    )
    // Read once, then dropped from the address bar.
    expect(window.location.search).toBe('?tab=users')
  })
})
