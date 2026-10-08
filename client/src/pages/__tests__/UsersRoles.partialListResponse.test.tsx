import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Users from '../Users'
import RolesPermissions from '../RolesPermissions'
import { permissionsApi, usersApi } from '@/lib/api'

// The public demo (VITE_DEMO_MODE) answered GET /auth/users,
// /permissions/roles and /permissions/capabilities with its catch-all reply,
// which had none of their lists: Settings > Users crashed on roles.map() and
// Settings > Roles & Permissions on roles.length. A reply without the list
// now reads as an empty one.

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

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    usersApi: { ...actual.usersApi, list: vi.fn() },
    permissionsApi: { ...actual.permissionsApi, getRoles: vi.fn(), getCapabilities: vi.fn() },
  }
})

const listUsers = vi.mocked(usersApi.list)
const getRoles = vi.mocked(permissionsApi.getRoles)
const getCapabilities = vi.mocked(permissionsApi.getCapabilities)

// What the demo's catch-all sent: a 200 with none of the expected fields.
const CATCH_ALL = { success: true, demo: true } as never

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings > Users and Roles & Permissions: a reply without its list', () => {
  it('Users renders an empty account table', async () => {
    listUsers.mockResolvedValue(CATCH_ALL)
    getRoles.mockResolvedValue(CATCH_ALL)
    render(
      <MemoryRouter>
        <ConfirmProvider>
          <Users />
        </ConfirmProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('columnheader', { name: 'Account' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add user/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument()
  })

  it('Roles & Permissions renders an empty matrix and no accounts', async () => {
    getCapabilities.mockResolvedValue(CATCH_ALL)
    getRoles.mockResolvedValue(CATCH_ALL)
    listUsers.mockResolvedValue(CATCH_ALL)
    render(
      <MemoryRouter>
        <TooltipProvider>
          <RolesPermissions />
        </TooltipProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('button', { name: /new role/i })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('No user accounts found.')).toBeInTheDocument())
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})
