import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Debug from '../Debug'
import { apiFetch } from '@/lib/api'

// UX restructure (2026-10-20): Diagnostics' nine tabs moved from one
// overflowing horizontal strip into the shared sub-nav rail (Now / History /
// System), and the selected tab now lives in ?tab= -- a reload keeps it, and
// other pages (the palette, Settings' "Open in Diagnostics") can link
// straight to one. Before, the tab was component state only: /debug?tab=logs
// opened Checks & Fixes. A manual fix also navigates in-app now, to the
// Settings tab that holds the fix.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
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
  return { ...actual, apiFetch: vi.fn() }
})

const mockedApiFetch = vi.mocked(apiFetch)

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

const diagnosticsFixture = {
  timestamp: '2026-10-20T00:00:00.000Z',
  overall: 'fail',
  summary: { ok: 0, warn: 0, fail: 1, info: 0, skip: 0 },
  categories: { storage: { label: 'Storage', order: 1 } },
  checks: [
    {
      id: 'db.exists',
      label: 'Database file',
      status: 'fail',
      severity: 'critical',
      message: 'db.json was not found.',
      category: 'storage',
    },
  ],
  durationMs: 5,
}

let currentLocation = ''
function LocationProbe() {
  const location = useLocation()
  currentLocation = `${location.pathname}${location.search}`
  return null
}

function renderDebug(entry: string) {
  mockedApiFetch.mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith('/debug/diagnostics')) return jsonResponse(diagnosticsFixture)
    return jsonResponse({})
  })
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TooltipProvider>
        <ConfirmProvider>
          <Debug />
          <LocationProbe />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  currentLocation = ''
})

describe('Diagnostics: the selected tab lives in ?tab=', () => {
  it('opens the tab named in ?tab= (a deep link or a reload)', async () => {
    renderDebug('/debug?tab=logs')
    const logs = await screen.findByRole('tab', { name: /^logs$/i })
    expect(logs).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /checks & fixes/i })).toHaveAttribute('aria-selected', 'false')
  })

  it('falls back to Checks & Fixes for an unknown ?tab=', async () => {
    renderDebug('/debug?tab=nope')
    expect(await screen.findByRole('tab', { name: /checks & fixes/i })).toHaveAttribute('aria-selected', 'true')
  })

  it('writes the tab picked on the rail back to ?tab=', async () => {
    renderDebug('/debug')
    const tab = await screen.findByRole('tab', { name: /live status/i })
    // Radix tabs switch on mousedown, not click.
    fireEvent.mouseDown(tab, { button: 0 })
    await waitFor(() => expect(tab).toHaveAttribute('aria-selected', 'true'))
    expect(currentLocation).toBe('/debug?tab=health')
  })

  it('switches tabs from the phone-width select too', async () => {
    renderDebug('/debug')
    const select = await screen.findByRole('combobox', { name: /diagnostics sections/i })
    fireEvent.change(select, { target: { value: 'crashes' } })
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /crashes/i })).toHaveAttribute('aria-selected', 'true'),
    )
    expect(currentLocation).toBe('/debug?tab=crashes')
  })

  it('groups the rail into Now, History and System', async () => {
    renderDebug('/debug')
    const tablist = await screen.findByRole('tablist', { name: /diagnostics sections/i })
    expect(tablist).toHaveTextContent('Now')
    expect(tablist).toHaveTextContent('History')
    expect(tablist).toHaveTextContent('System')
  })
})

describe('Diagnostics: a manual fix opens the Settings tab that holds it', () => {
  it('db.exists goes to Settings › General in-app, not bare /settings', async () => {
    renderDebug('/debug')
    const fix = await screen.findByRole('button', { name: /open settings/i })
    fireEvent.click(fix)
    await waitFor(() => expect(currentLocation).toBe('/settings?tab=general'))
  })
})
