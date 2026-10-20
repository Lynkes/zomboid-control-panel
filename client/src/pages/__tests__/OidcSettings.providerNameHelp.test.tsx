import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import OidcSettings from '../OidcSettings'
import { oidcSettingsApi } from '@/lib/api'

// The Display name help said: Shown on the login screen's button --
// "Continue with {{name}}". The placeholder was never filled in, so every
// language showed the raw {{name}}. It now shows the name typed, or "SSO",
// what the sign-in button itself falls back to.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    oidcSettingsApi: { ...actual.oidcSettingsApi, get: vi.fn(), update: vi.fn(), testConnection: vi.fn() },
  }
})

const SAVED = {
  issuerUrl: '',
  clientId: '',
  redirectUri: '',
  scope: 'openid email profile',
  providerName: '',
  allowInsecureHttp: false,
  clientSecretConfigured: false,
  configured: false,
  envOverrides: { issuerUrl: false, clientId: false, redirectUri: false, scope: false, providerName: false, allowInsecureHttp: false, clientSecret: false },
  suggestedRedirectUri: 'https://panel.example/api/auth/oidc/callback',
  providerFieldsEditable: true,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings › Single Sign-On: Display name help', () => {
  it('names the button the way the sign-in screen will, never a raw {{name}}', async () => {
    vi.mocked(oidcSettingsApi.get).mockResolvedValue(SAVED as never)
    render(
      <MemoryRouter>
        <TooltipProvider>
          <OidcSettings embedded />
        </TooltipProvider>
      </MemoryRouter>,
    )

    const name = await screen.findByLabelText('Display name')
    expect(screen.getByText('Shown on the login screen\'s button — "Continue with SSO".')).toBeInTheDocument()
    expect(screen.queryByText(/\{\{name\}\}/)).not.toBeInTheDocument()

    fireEvent.change(name, { target: { value: 'Keycloak' } })
    expect(screen.getByText('Shown on the login screen\'s button — "Continue with Keycloak".')).toBeInTheDocument()
  })
})
