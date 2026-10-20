import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import i18n from '@/i18n'

// Old addresses and the 404 page, through App's real <Routes>:
// - /serverconfig, /chunk-cleaner, /dashboard, /users, /roles and /sso
//   redirected without the rest of the address, so a bookmark such as
//   /serverconfig?tab=sandbox opened the first tab;
// - "Page Not Found" was hard-coded English.
// The pages themselves are stand-ins (the registry's loaders are replaced),
// and the socket is never opened (demo mode).

vi.mock('@/lib/demo', async () => {
  const actual = await vi.importActual<typeof import('@/lib/demo')>('@/lib/demo')
  return { ...actual, isDemoMode: () => true }
})

vi.mock('@/contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    authEnabled: false,
    statusCheckFailed: false,
    statusCheckCode: null,
    retryAuthCheck: vi.fn(),
    getToken: () => 'token',
  }),
}))

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search + location.hash}</output>
}

vi.mock('@/components/Layout', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>
      <Where />
      {children}
    </div>
  ),
}))

vi.mock('@/lib/navigation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/navigation')>('@/lib/navigation')
  return {
    ...actual,
    ROUTES: actual.ROUTES.map((route) => ({
      ...route,
      load: async () => ({ default: () => <p>page {route.path}</p> }),
    })),
  }
})

async function renderAt(entry: string) {
  const { default: App } = await import('@/App')
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <App />
    </MemoryRouter>,
  )
}

afterEach(async () => {
  cleanup()
  if (i18n.language !== 'en') await i18n.changeLanguage('en')
})

describe('App: old addresses keep the rest of the address', () => {
  it.each([
    ['/serverconfig?tab=sandbox', '/server-config?tab=sandbox'],
    ['/chunk-cleaner?x=1#top', '/chunks?x=1#top'],
    ['/dashboard?from=discord', '/?from=discord'],
    ['/roles?from=docs', '/settings?from=docs&tab=roles'],
    // The target's own tab wins over a stale one.
    ['/users?tab=roles', '/settings?tab=users'],
  ])('%s opens %s', async (from, to) => {
    await renderAt(from)
    expect(await screen.findByText(/^page /)).toBeInTheDocument()
    expect(screen.getByTestId('where').textContent).toBe(to)
  })
})

describe('App: the 404 page', () => {
  it('speaks the interface language', async () => {
    await i18n.changeLanguage('de')
    await renderAt('/nowhere')
    expect(await screen.findByRole('heading', { name: 'Seite nicht gefunden' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Zum Dashboard' })).toHaveAttribute('href', '/')
    expect(screen.queryByText('Page Not Found')).not.toBeInTheDocument()
  })
})
