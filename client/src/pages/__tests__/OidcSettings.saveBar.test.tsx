import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import OidcSettings from '../OidcSettings'
import { oidcSettingsApi } from '@/lib/api'

// UX restructure (slice D): Settings › Single Sign-On had a plain Save button
// that was always enabled and nothing that said the form held edits, so
// leaving the tab or the page dropped them silently. It now has the shared
// save bar: it appears only once a field differs from what was loaded,
// counts the changed fields, saves just those, and Discard puts them back.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    oidcSettingsApi: { ...actual.oidcSettingsApi, get: vi.fn(), update: vi.fn(), testConnection: vi.fn() },
  }
})

const getSettings = vi.mocked(oidcSettingsApi.get)
const updateSettings = vi.mocked(oidcSettingsApi.update)

const SAVED = {
  issuerUrl: 'https://accounts.google.com',
  clientId: 'panel-client',
  redirectUri: 'https://panel.example/api/auth/oidc/callback',
  scope: 'openid email profile',
  providerName: 'Google',
  allowInsecureHttp: false,
  clientSecretConfigured: true,
  configured: true,
  envOverrides: { issuerUrl: false, clientId: false, redirectUri: false, scope: false, providerName: false, allowInsecureHttp: false, clientSecret: false },
  suggestedRedirectUri: 'https://panel.example/api/auth/oidc/callback',
  providerFieldsEditable: true,
}

function renderSso() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <OidcSettings embedded />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings › Single Sign-On: one save bar', () => {
  it('shows nothing to save until a field changes', async () => {
    getSettings.mockResolvedValue(SAVED as never)
    renderSso()
    expect(await screen.findByLabelText('Display name')).toHaveValue('Google')
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.getByText('Single sign-on is configured')).toBeInTheDocument()
  })

  it('saves only the changed field, and Discard puts an edit back', async () => {
    getSettings.mockResolvedValue(SAVED as never)
    updateSettings.mockResolvedValue({ success: true } as never)
    renderSso()

    const name = await screen.findByLabelText('Display name')
    fireEvent.change(name, { target: { value: 'Company SSO' } })
    expect(await screen.findByText('Unsaved changes: 1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.getByLabelText('Display name')).toHaveValue('Google'))
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Company SSO' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ providerName: 'Company SSO' }))
  })
})
