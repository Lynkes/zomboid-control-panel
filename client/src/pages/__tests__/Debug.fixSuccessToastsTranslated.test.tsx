import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { SocketContext } from '@/contexts/SocketContext'
import Debug from '../Debug'
import { apiFetch, modsApi } from '@/lib/api'

// Diagnostics fix success toasts showed the server's English `message` first,
// so their translated fallbacks never appeared in any other language. They
// are now built from the result's fields in the reader's language.

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
  return {
    ...actual,
    apiFetch: vi.fn(),
    modsApi: { ...actual.modsApi, repairMapEntries: vi.fn(), deduplicateModIds: vi.fn() },
  }
})

const toastMock = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastMock, dismiss: vi.fn(), toasts: [] }),
}))

const fakeSocket = {
  connected: true,
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
} as unknown as Parameters<typeof SocketContext.Provider>[0]['value']

const mockedApiFetch = vi.mocked(apiFetch)

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

function diagnostics() {
  return {
    timestamp: '2026-10-20T00:00:00.000Z',
    overall: 'fail',
    summary: { ok: 0, warn: 1, fail: 1, info: 0, skip: 0 },
    categories: { mods: { label: 'Mods', order: 1 } },
    checks: [
      { id: 'mods.maps', label: 'Map= entries', status: 'fail', severity: 'warning', message: 'Invalid Map= entries', category: 'mods' },
      { id: 'mods.duplicates', label: 'Duplicate mod entries', status: 'warn', severity: 'warning', message: 'Duplicates', category: 'mods' },
    ],
    durationMs: 5,
  }
}

function renderDebug() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <SocketContext.Provider value={fakeSocket}>
            <Debug />
          </SocketContext.Provider>
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function lastToastDescription() {
  return String(toastMock.mock.calls.at(-1)![0].description)
}

describe('Debug.tsx: diagnostics fix success toasts are translated', () => {
  it('describes a Map= repair from its result, not the server\'s English message', async () => {
    mockedApiFetch.mockImplementation(async (endpoint: string) =>
      endpoint.startsWith('/debug/diagnostics') ? jsonResponse(diagnostics()) : jsonResponse({}),
    )
    vi.mocked(modsApi.repairMapEntries).mockResolvedValue({
      success: true,
      removed: ['BadMap'],
      added: ['Muldraugh, KY'],
      remaining: ['Muldraugh, KY'],
      message: 'SERVER ENGLISH',
    })

    renderDebug()
    fireEvent.click(await screen.findByRole('button', { name: 'Repair Map=' }))

    await waitFor(() => expect(modsApi.repairMapEntries).toHaveBeenCalled())
    await waitFor(() => expect(toastMock).toHaveBeenCalled())
    const description = lastToastDescription()
    expect(description).not.toContain('SERVER ENGLISH')
    expect(description).toContain('Invalid map entries removed (1): BadMap.')
    expect(description).toContain('Missing map entries added (1): Muldraugh, KY.')
  })

  it('describes a deduplication with no duplicates without a restart hint', async () => {
    mockedApiFetch.mockImplementation(async (endpoint: string) =>
      endpoint.startsWith('/debug/diagnostics') ? jsonResponse(diagnostics()) : jsonResponse({}),
    )
    vi.mocked(modsApi.deduplicateModIds).mockResolvedValue({
      success: true,
      removed: [],
      removedCount: 0,
      remaining: 3,
      message: 'SERVER ENGLISH',
    })

    renderDebug()
    fireEvent.click(await screen.findByRole('button', { name: 'Deduplicate' }))

    await waitFor(() => expect(modsApi.deduplicateModIds).toHaveBeenCalled())
    await waitFor(() => expect(toastMock).toHaveBeenCalled())
    expect(lastToastDescription()).toBe('No duplicate mod IDs found. No changes needed.')
  })
})
