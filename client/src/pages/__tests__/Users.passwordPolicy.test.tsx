import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Users from '../Users'
import { usersApi, permissionsApi } from '@/lib/api'
import en from '../../locales/en/users.json'
import enErrors from '../../locales/en/errors.json'
import { exceedsPasswordMaxBytes, meetsPasswordMinLength } from '@/lib/passwordPolicy'

// SECURITY (2026-10-20, access-control audit): a new panel password needs at
// least 10 characters and at most 72 bytes (server/services/passwordPolicy.js
// decides; the form says so before sending).

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    usersApi: { ...actual.usersApi, list: vi.fn(), create: vi.fn() },
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('lib/passwordPolicy', () => {
  it('counts characters for the minimum and UTF-8 bytes for the maximum', () => {
    expect(meetsPasswordMinLength('123456789')).toBe(false)
    expect(meetsPasswordMinLength('1234567890')).toBe(true)
    expect(exceedsPasswordMaxBytes('a'.repeat(72))).toBe(false)
    expect(exceedsPasswordMaxBytes('a'.repeat(73))).toBe(true)
    expect(exceedsPasswordMaxBytes('é'.repeat(37))).toBe(true)
  })
})

describe('Users: create account form', () => {
  async function fillForm(password: string) {
    vi.mocked(usersApi.list).mockResolvedValue({ users: [] } as never)
    vi.mocked(permissionsApi.getRoles).mockResolvedValue({
      roles: [{ id: 'role-moderator', name: 'moderator', capabilities: [], isSeeded: true, createdAt: '', memberCount: 0 }],
    } as never)
    render(
      <MemoryRouter>
        <TooltipProvider>
          <ConfirmProvider>
            <Users />
          </ConfirmProvider>
        </TooltipProvider>
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('button', { name: en.toolbar.addUser }))
    fireEvent.change(await screen.findByLabelText(en.createDialog.usernameLabel), { target: { value: 'newbie' } })
    fireEvent.change(screen.getByLabelText(en.createDialog.passwordLabel), { target: { value: password } })
    fireEvent.change(screen.getByLabelText(en.createDialog.confirmPasswordLabel), { target: { value: password } })
    fireEvent.click(screen.getByRole('button', { name: en.createDialog.create }))
  }

  it('says the hint with the new minimum', async () => {
    expect(en.createDialog.passwordHint).toContain('10')
  })

  it('refuses a 9-character password before sending it', async () => {
    await fillForm('Short-9ch')
    expect(await screen.findByText(enErrors.PASSWORD_TOO_SHORT)).toBeInTheDocument()
    expect(usersApi.create).not.toHaveBeenCalled()
  })

  it('refuses one longer than 72 bytes before sending it', async () => {
    await fillForm('é'.repeat(40))
    expect(await screen.findByText(enErrors.PASSWORD_TOO_LONG_BYTES)).toBeInTheDocument()
    expect(usersApi.create).not.toHaveBeenCalled()
  })
})
