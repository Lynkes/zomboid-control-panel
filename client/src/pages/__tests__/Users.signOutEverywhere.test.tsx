import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Users from '../Users'
import { usersApi, permissionsApi, type ManagedUserAccount } from '@/lib/api'

// Auth audit 2026-10-08 (#10): a users.manage holder can sign another account
// out of every browser and device without touching its password or role
// (POST /api/auth/users/:id/sessions/revoke). The server already enforced it;
// this is the Users page button that calls it.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    usersApi: { ...actual.usersApi, list: vi.fn(), revokeSessions: vi.fn() },
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
const revokeSessions = vi.mocked(usersApi.revokeSessions)

function makeUser(id: string, username: string): ManagedUserAccount {
  return { id, username, role: 'moderator', roleId: null, createdAt: '2026-01-01T00:00:00.000Z', lastLogin: null }
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
  vi.mocked(permissionsApi.getRoles).mockReset().mockResolvedValue({ roles: [] })
  listUsers.mockReset().mockResolvedValue({
    users: [makeUser('current-admin', 'admin'), makeUser('u2', 'bob')],
  })
  revokeSessions.mockReset().mockResolvedValue({ success: true, user: { id: 'u2', username: 'bob' } })
})

describe('Users -- sign an account out everywhere', () => {
  it('asks first, then signs that account out', async () => {
    renderUsers()

    fireEvent.click(await screen.findByRole('button', { name: 'Sign bob out everywhere' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Sign bob out everywhere?')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }))

    await waitFor(() => expect(revokeSessions).toHaveBeenCalledWith('u2'))
  })

  it('does nothing when the confirmation is cancelled', async () => {
    renderUsers()

    fireEvent.click(await screen.findByRole('button', { name: 'Sign bob out everywhere' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(revokeSessions).not.toHaveBeenCalled()
  })

  it('offers no such button on your own row (Settings > Security has it)', async () => {
    renderUsers()

    await screen.findByRole('button', { name: 'Sign bob out everywhere' })
    expect(screen.queryByRole('button', { name: 'Sign admin out everywhere' })).not.toBeInTheDocument()
  })
})
