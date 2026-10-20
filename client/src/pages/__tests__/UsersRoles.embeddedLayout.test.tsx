import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Users from '../Users'
import RolesPermissions from '../RolesPermissions'
import { permissionsApi, usersApi } from '@/lib/api'

// UX restructure (slice D): inside Settings, Users and Roles & Permissions
// sit under Settings' own header ("Settings › Users"), so while they load
// they show a compact skeleton, not a second page header; once loaded each
// list is one card that carries its own add button.

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

function renderEmbedded(node: React.ReactNode) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>{node}</ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings › Users and Roles & Permissions while loading', () => {
  it('Users shows a compact skeleton with no second page header', () => {
    listUsers.mockReturnValue(new Promise(() => {}))
    getRoles.mockReturnValue(new Promise(() => {}))
    renderEmbedded(<Users embedded />)
    expect(screen.getByRole('status', { name: 'Loading accounts…' })).toBeInTheDocument()
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.queryByText('Users')).not.toBeInTheDocument()
  })

  it('Roles & Permissions shows a compact skeleton with no second page header', () => {
    getCapabilities.mockReturnValue(new Promise(() => {}))
    getRoles.mockReturnValue(new Promise(() => {}))
    listUsers.mockReturnValue(new Promise(() => {}))
    renderEmbedded(<RolesPermissions embedded />)
    expect(screen.getByRole('status', { name: 'Loading roles and capabilities…' })).toBeInTheDocument()
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })
})

describe('Settings › Users and Roles & Permissions once loaded', () => {
  it('Users: one accounts card with the add button and a "…" menu per row', async () => {
    listUsers.mockResolvedValue({
      users: [
        { id: 'current-admin', username: 'admin', role: 'admin', roleId: null, createdAt: '2026-01-01T00:00:00.000Z', lastLogin: null },
        { id: 'u2', username: 'bob', role: 'moderator', roleId: null, createdAt: '2026-01-01T00:00:00.000Z', lastLogin: null },
      ],
    })
    getRoles.mockResolvedValue({ roles: [] })
    renderEmbedded(<Users embedded />)

    const card = (await screen.findByRole('heading', { name: 'Panel accounts', level: 2 })).closest('section')!
    expect(card).toContainElement(screen.getByRole('button', { name: 'Add User' }))
    expect(screen.getByRole('button', { name: 'Actions for bob' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
  })

  it('Roles & Permissions: sticky capability column pins to the start edge (right in Arabic)', async () => {
    getCapabilities.mockResolvedValue({
      groups: [{ group: 'Server', capabilities: [{ key: 'server.start', label: 'Start the server', description: 'Start it' }] }],
    } as never)
    getRoles.mockResolvedValue({
      roles: [{ id: 'r1', name: 'admin', capabilities: ['server.start'], isSeeded: true, memberCount: 1 }],
    } as never)
    listUsers.mockResolvedValue({ users: [] })
    renderEmbedded(<RolesPermissions embedded />)

    const capabilityCell = (await screen.findByText('Start the server')).closest('td')!
    expect(capabilityCell.className).toContain('start-0')
    expect(capabilityCell.className).not.toContain('left-0')
    expect(screen.getByRole('columnheader', { name: 'Capability' }).className).toContain('start-0')
    expect(screen.getByRole('heading', { name: 'Capabilities by role', level: 2 })).toBeInTheDocument()
  })
})
