import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Users from '../Users'
import RolesPermissions from '../RolesPermissions'
import { permissionsApi, usersApi } from '@/lib/api'
import enErrors from '../../locales/en/errors.json'

// SECURITY (2026-10-20, access-control audit): while panel logins are off,
// account and role changes are refused (ACCOUNT_CHANGES_NEED_LOGINS) since
// they would outlive the setting. Both pages say so up front.

let authEnabled = false

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    authEnabled,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => null,
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function setUp() {
  vi.mocked(usersApi.list).mockResolvedValue({ users: [] } as never)
  vi.mocked(permissionsApi.getRoles).mockResolvedValue({ roles: [] } as never)
  vi.mocked(permissionsApi.getCapabilities).mockResolvedValue({ groups: [] } as never)
}

describe('Users and Roles & Permissions while logins are off', () => {
  it('Users explains that account changes wait for logins', async () => {
    authEnabled = false
    setUp()
    render(
      <MemoryRouter>
        <ConfirmProvider>
          <Users />
        </ConfirmProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText(enErrors.ACCOUNT_CHANGES_NEED_LOGINS)).toBeInTheDocument()
  })

  it('Roles & Permissions explains it too', async () => {
    authEnabled = false
    setUp()
    render(
      <MemoryRouter>
        <TooltipProvider>
          <RolesPermissions />
        </TooltipProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText(enErrors.ACCOUNT_CHANGES_NEED_LOGINS)).toBeInTheDocument()
  })

  it('says nothing while logins are on', async () => {
    authEnabled = true
    setUp()
    render(
      <MemoryRouter>
        <ConfirmProvider>
          <Users />
        </ConfirmProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('columnheader', { name: 'Account' })
    expect(screen.queryByText(enErrors.ACCOUNT_CHANGES_NEED_LOGINS)).not.toBeInTheDocument()
  })
})
