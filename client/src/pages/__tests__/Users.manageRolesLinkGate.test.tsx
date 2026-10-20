import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Users from '../Users'
import { usersApi, permissionsApi } from '@/lib/api'

// Panel Users ends with "Manage roles & permissions" (/settings?tab=roles).
// Settings hides that tab from a role without roles.manage and opens General
// for it instead, so a role that manages users but not roles followed the
// link to an unrelated page. The link now shows only to a role that has it.

const auth = vi.hoisted(() => ({ can: (_capability: string) => true }))

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'current', username: 'lead', role: 'custom', capabilities: [] },
    authEnabled: true,
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
    usersApi: { ...actual.usersApi, list: vi.fn() },
    permissionsApi: { ...actual.permissionsApi, getRoles: vi.fn() },
  }
})

function renderUsers() {
  vi.mocked(usersApi.list).mockResolvedValue({
    users: [{ id: 'u1', username: 'alice', role: 'moderator', roleId: null, createdAt: '2026-01-01T00:00:00.000Z', lastLogin: null }],
  } as never)
  vi.mocked(permissionsApi.getRoles).mockResolvedValue({ roles: [] } as never)
  return render(
    <MemoryRouter>
      <ConfirmProvider>
        <Users embedded />
      </ConfirmProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  auth.can = () => true
})

describe('Users: the link to Roles & Permissions', () => {
  it('is there for a role that manages roles', async () => {
    renderUsers()
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Manage roles/i })).toHaveAttribute('href', '/settings?tab=roles')
  })

  it('is left out for a role that manages users but not roles', async () => {
    auth.can = (capability) => capability !== 'roles.manage'
    renderUsers()
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Manage roles/i })).not.toBeInTheDocument()
  })
})
