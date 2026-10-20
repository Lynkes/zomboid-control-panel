import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Debug from '../Debug'
import { apiFetch } from '@/lib/api'

// UX restructure (slice D, screenshot pass): Diagnostics › Logs opened with a
// row of five stat tiles (Total / Errors / Warnings / Info / Debug) that were
// also the level filter, plus a second level dropdown in the toolbar; on a
// phone the tiles pushed the log a full screen down. The level filter is now
// one segmented control in the toolbar, each level with its count.

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

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

const LOGS = [
  { level: 'error', message: 'RCON connection refused', timestamp: '2026-10-20T10:00:00.000Z', source: 'rcon' },
  { level: 'warn', message: 'Mod update check slow', timestamp: '2026-10-20T10:01:00.000Z', source: 'mods' },
  { level: 'info', message: 'Server started', timestamp: '2026-10-20T10:02:00.000Z', source: 'server' },
  { level: 'info', message: 'Player joined', timestamp: '2026-10-20T10:03:00.000Z', source: 'server' },
]

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Diagnostics › Logs: one level filter with counts', () => {
  it('counts each level in the toolbar filter and filters the log by it', async () => {
    mockedApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/debug/logs')) return jsonResponse({ logs: LOGS })
      return jsonResponse({})
    })
    render(
      <MemoryRouter initialEntries={['/debug?tab=logs']}>
        <TooltipProvider>
          <ConfirmProvider>
            <Debug />
          </ConfirmProvider>
        </TooltipProvider>
      </MemoryRouter>,
    )

    const filter = await screen.findByRole('radiogroup', { name: 'Level' })
    await waitFor(() => expect(within(filter).getByRole('radio', { name: /All Levels/ })).toHaveTextContent('4'))
    expect(within(filter).getByRole('radio', { name: /Errors/ })).toHaveTextContent('1')
    expect(within(filter).getByRole('radio', { name: /Info/ })).toHaveTextContent('2')
    // No second level control, and no stat tiles doubling as filters.
    expect(screen.queryByRole('button', { name: /^Filter: / })).not.toBeInTheDocument()

    expect(await screen.findByText('Player joined')).toBeInTheDocument()
    fireEvent.click(within(filter).getByRole('radio', { name: /Errors/ }))
    await waitFor(() => expect(screen.queryByText('Player joined')).not.toBeInTheDocument())
    expect(screen.getByText('RCON connection refused')).toBeInTheDocument()
    expect(within(filter).getByRole('radio', { name: /Errors/ })).toHaveAttribute('aria-checked', 'true')
  })
})
