import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import RolesPermissions from '../RolesPermissions'
import { permissionsApi, usersApi, type CapabilityGroup, type RoleInfo } from '@/lib/api'

// security sweep 2026-10-04 (AUTHZ-1): deleteRole() now refuses moving a
// deleted role's members onto a role that grants anything the caller doesn't
// hold themselves (otherwise a roles.manage-only user could delete their own
// role with reassignTo=admin). The "Move members to" picker has to say so up
// front -- a target the server will refuse is disabled with a reason, not
// offered and then failed on Delete.

let callerCapabilities: string[] | null = ['roles.manage', 'alpha.cap']

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    can: (capability: string) => callerCapabilities === null || callerCapabilities.includes(capability),
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    permissionsApi: { ...actual.permissionsApi, getCapabilities: vi.fn(), getRoles: vi.fn(), deleteRole: vi.fn() },
    usersApi: { ...actual.usersApi, list: vi.fn() },
  }
})

const getCapabilities = vi.mocked(permissionsApi.getCapabilities)
const getRoles = vi.mocked(permissionsApi.getRoles)
const deleteRole = vi.mocked(permissionsApi.deleteRole)
const listUsers = vi.mocked(usersApi.list)

const groups: CapabilityGroup[] = [
  {
    group: 'test',
    capabilities: [
      { key: 'alpha.cap', label: 'Alpha Capability', description: 'desc a' },
      { key: 'beta.cap', label: 'Beta Capability', description: 'desc b' },
    ],
  },
]

const roles: RoleInfo[] = [
  {
    id: 'role-admin',
    name: 'admin',
    capabilities: ['roles.manage', 'alpha.cap', 'beta.cap'],
    isSeeded: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    memberCount: 1,
  },
  {
    id: 'role-helpers',
    name: 'Helpers',
    capabilities: ['alpha.cap'],
    isSeeded: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    memberCount: 2,
  },
  {
    id: 'role-viewers',
    name: 'Viewers',
    capabilities: ['alpha.cap'],
    isSeeded: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    memberCount: 0,
  },
]

// The reassign picker is a Radix Select, which calls pointer-capture and
// scrollIntoView methods jsdom doesn't have (same polyfill as
// Files.staleResults.test.tsx).
const proto = Element.prototype as unknown as Record<string, unknown>
const polyfilled = ['hasPointerCapture', 'releasePointerCapture', 'setPointerCapture', 'scrollIntoView'].filter((name) => !(name in proto))

beforeEach(() => {
  for (const name of polyfilled) proto[name] = name === 'hasPointerCapture' ? () => false : () => {}
  callerCapabilities = ['roles.manage', 'alpha.cap']
  getCapabilities.mockReset().mockResolvedValue({ groups })
  getRoles.mockReset().mockResolvedValue({ roles })
  deleteRole.mockReset()
  listUsers.mockReset().mockResolvedValue({ users: [] })
})

afterEach(() => {
  for (const name of polyfilled) delete proto[name]
})

async function openReassignPicker() {
  render(
    <TooltipProvider>
      <RolesPermissions />
    </TooltipProvider>,
  )
  // Seeded admin has no Delete button; Helpers' comes first.
  const [helpersDelete] = await screen.findAllByRole('button', { name: 'Delete role' })
  fireEvent.click(helpersDelete)
  const dialog = await screen.findByRole('dialog')
  fireEvent.pointerDown(within(dialog).getByRole('combobox'), { button: 0, ctrlKey: false, pointerType: 'mouse' })
}

describe('RolesPermissions: delete dialog only offers reassign targets the caller could grant', () => {
  it('disables a target granting a capability the caller lacks, and keeps one within reach enabled', async () => {
    await openReassignPicker()

    const adminOption = await screen.findByRole('option', { name: 'admin' })
    const viewersOption = screen.getByRole('option', { name: 'Viewers' })

    expect(adminOption).toHaveAttribute('aria-disabled', 'true')
    expect(adminOption).toHaveAttribute('data-disabled')
    expect(viewersOption).not.toHaveAttribute('aria-disabled', 'true')
    expect(viewersOption).not.toHaveAttribute('data-disabled')

    // The disabled row explains itself via the shared DisabledReason wrapper.
    expect(adminOption.closest('span[tabindex="0"]')).not.toBeNull()
  })

  it('leaves every target enabled for a caller who holds everything', async () => {
    callerCapabilities = ['roles.manage', 'alpha.cap', 'beta.cap']
    await openReassignPicker()

    const adminOption = await screen.findByRole('option', { name: 'admin' })
    expect(adminOption).not.toHaveAttribute('aria-disabled', 'true')
    expect(adminOption.closest('span[tabindex="0"]')).toBeNull()
  })
})
