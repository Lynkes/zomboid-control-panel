import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { SocketContext } from '@/contexts/SocketContext'
import enDebug from '@/locales/en/debug.json'
import Debug from '../Debug'
import { apiFetch } from '@/lib/api'

// v1.4.1 (spec §A9/§A14.6): Server Files audit rows reach Debug > Activity
// as source "files" (server/routes/debug.js merges them into "all"). The tab
// labels them with common.sourceFiles and counts them like the other sources.

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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Debug > Activity: Server Files rows', () => {
  it('shows a files row with the Files source label', async () => {
    mockedApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/debug/activity')) {
        return jsonResponse({
          entries: [{
            id: 'fa1',
            source: 'files',
            action: 'files.write',
            detail: 'kate: data:Server/servertest.ini',
            success: true,
            timestamp: '2026-09-29T12:00:00.000Z',
          }],
        })
      }
      return jsonResponse({})
    })

    render(
      <MemoryRouter>
        <TooltipProvider>
          <ConfirmProvider>
            <SocketContext.Provider value={null}>
              <Debug />
            </SocketContext.Provider>
          </ConfirmProvider>
        </TooltipProvider>
      </MemoryRouter>,
    )

    fireEvent.mouseDown(await screen.findByRole('tab', { name: enDebug.tabs.activity }), { button: 0 })

    expect(await screen.findByText('files.write')).toBeInTheDocument()
    expect(screen.getByText(enDebug.common.sourceFiles, { selector: '[data-badge-variant]' })).toBeInTheDocument()
    await waitFor(() => {
      expect(mockedApiFetch.mock.calls.some(([endpoint]) => String(endpoint).startsWith('/debug/activity?limit=200&source=all'))).toBe(true)
    })
  })
})
