import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import RolesPermissions from '../RolesPermissions'
import { permissionsApi, usersApi, type CapabilityGroup, type RoleInfo } from '@/lib/api'

// pz-pam-r23: renaming a seeded (built-in) role ALWAYS fails server-side
// (ROLE_SEEDED_RENAME_REFUSED -- see commit ce889972 and
// permissions.js's updateRole()), but the Rename button gave no hint of
// that -- it stayed fully enabled, opened the rename dialog, and only
// failed once the operator typed a name and hit Save. This proves it now
// carries aria-disabled + a DisabledReason tooltip and refuses to open the
// dialog for a seeded role, WITHOUT using the disabled attribute -- the
// button must stay focusable, since it's the documented focus-restore
// target after deleting a role elsewhere in the same matrix (a seeded
// role's own Delete button is genuinely `disabled`, hence unfocusable).

function renderRolesPermissions() {
  return render(
    <TooltipProvider>
      <RolesPermissions />
    </TooltipProvider>,
  )
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    permissionsApi: { ...actual.permissionsApi, getCapabilities: vi.fn(), getRoles: vi.fn(), updateRole: vi.fn() },
    usersApi: { ...actual.usersApi, list: vi.fn() },
  }
})

const getCapabilities = vi.mocked(permissionsApi.getCapabilities)
const getRoles = vi.mocked(permissionsApi.getRoles)
const updateRole = vi.mocked(permissionsApi.updateRole)
const listUsers = vi.mocked(usersApi.list)

const groups: CapabilityGroup[] = [
  { group: 'test', capabilities: [{ key: 'alpha.cap', label: 'Alpha Capability', description: 'desc a' }] },
]

const seededRole: RoleInfo = {
  id: 'admin',
  name: 'admin',
  capabilities: ['alpha.cap'],
  isSeeded: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  memberCount: 1,
}

const customRole: RoleInfo = {
  id: 'role1',
  name: 'Test Role',
  capabilities: ['alpha.cap'],
  isSeeded: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  memberCount: 0,
}

beforeEach(() => {
  getCapabilities.mockReset().mockResolvedValue({ groups })
  getRoles.mockReset().mockResolvedValue({ roles: [seededRole, customRole] })
  updateRole.mockReset()
  listUsers.mockReset().mockResolvedValue({ users: [] })
})

describe('RolesPermissions.tsx: a seeded role\'s Rename button explains itself without disabling', () => {
  it('is aria-disabled, still focusable, shows a reason, and does not open the rename dialog', async () => {
    renderRolesPermissions()

    await screen.findAllByRole('button', { name: 'Rename role' })
    const allRenameButtons = screen.getAllByRole('button', { name: 'Rename role' })
    // seeded is listed first (admin), custom second (Test Role)
    expect(allRenameButtons).toHaveLength(2)
    const [seededRenameButton, customRenameButton] = allRenameButtons

    // Not the native disabled attribute -- must stay a real focus target.
    expect(seededRenameButton).not.toBeDisabled()
    expect(seededRenameButton).toHaveAttribute('aria-disabled', 'true')
    seededRenameButton.focus()
    expect(seededRenameButton).toHaveFocus()

    // Clicking it must NOT open the rename dialog (which would only fail
    // on submit).
    fireEvent.click(seededRenameButton)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // The non-seeded role's Rename button is untouched: no aria-disabled,
    // and clicking it does open the dialog.
    expect(customRenameButton).not.toHaveAttribute('aria-disabled')
    fireEvent.click(customRenameButton)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })
})
