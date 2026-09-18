import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Debug from '../Debug'
import { apiFetch } from '@/lib/api'

// UX sense-check (2026-09-18): the page header always shows two download
// buttons -- "Support Bundle (.zip)" and "Full Log (.txt)" -- on every tab,
// with no explanation of what each actually contains. The Logs tab's own
// "one-click support bundle" card spells this out right next to its
// (differently-labelled) button ("Panel logs · Zomboid server logs · crash
// dumps · diagnostics, all in a single .zip."), but a first-time operator
// looking at the persistent header action -- visible before they ever reach
// the Logs tab -- had no way to tell that the bundle is everything and the
// full log is only the panel's own log, not the Zomboid server's. Fixed by
// adding a Tooltip to each header button using the same "what's actually in
// it" wording.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'moderator', capabilities: [] },
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderDebug() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Debug />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

describe('Debug > header actions: Support Bundle / Full Log buttons explain what they contain', () => {
  it('shows a tooltip on the Support Bundle button naming everything the zip contains', async () => {
    mockedApiFetch.mockImplementation(async () => jsonResponse({}))

    renderDebug()

    const button = await screen.findByRole('button', { name: /support bundle/i })
    fireEvent.focus(button)

    expect(
      await screen.findByText(
        /panel logs.*zomboid server logs.*crash dumps.*diagnostics/i,
      ),
    ).toBeInTheDocument()
  })

  it('shows a tooltip on the Full Log button clarifying it is the panel log only, not Zomboid server logs', async () => {
    mockedApiFetch.mockImplementation(async () => jsonResponse({}))

    renderDebug()

    const button = await screen.findByRole('button', { name: /full log/i })
    fireEvent.focus(button)

    expect(
      await screen.findByText(/this panel's own application log only/i),
    ).toBeInTheDocument()
  })
})
