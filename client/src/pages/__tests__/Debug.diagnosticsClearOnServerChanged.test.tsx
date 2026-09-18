import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { SocketContext } from '@/contexts/SocketContext'
import Debug from '../Debug'
import { apiFetch, modsApi } from '@/lib/api'

// pz-bughunt round 18 (the narrower server-switch races flagged in round
// 17): the "mods.numericInMods"/"mods.orphanWorkshop" diagnostics checks
// carry their own metadata (numericInMods/orphanWorkshop id lists) scanned
// against whichever server was active when the diagnostics run finished.
// handleDiagnosticsFix reads those ids straight off the rendered check and
// writes them via modsApi.batchToggleModIds/resolveOrphanWorkshop, which
// resolve "the active server" server-side with no id sent -- same shape as
// the round-17 sweep. fetchDiagnostics() already refetches unconditionally
// on activeServerChanged (read-only data, no unsaved-edit risk), but a Fix
// click during that refetch's own in-flight window would still write the
// OLD server's ids into the NEW one. Fixed the same way as Mods.tsx's
// race-window class this same round: clear diagnostics outright on the
// switch, so the stale check (and its Fix button) can't be clicked at all.

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
    modsApi: { ...actual.modsApi, batchToggleModIds: vi.fn() },
  }
})

// Debug.tsx reads the socket via useContext(SocketContext) directly, same
// harness as Debug.activeServerRaceOrder.test.tsx.
const socketHandlers = new Map<string, Set<(...args: unknown[]) => void>>()
const fakeSocket = {
  connected: true,
  on: (event: string, handler: (...args: unknown[]) => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: (...args: unknown[]) => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
  emit: vi.fn(),
} as unknown as Parameters<typeof SocketContext.Provider>[0]['value']

function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const mockedApiFetch = vi.mocked(apiFetch)
const batchToggleModIds = vi.mocked(modsApi.batchToggleModIds)

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

function diagnosticsWithNumericCheck() {
  return {
    timestamp: '2026-09-18T00:00:00.000Z',
    overall: 'fail',
    summary: { ok: 4, warn: 0, fail: 1, info: 0, skip: 0 },
    categories: { mods: { label: 'Mods', order: 1 } },
    checks: [
      {
        id: 'mods.numericInMods',
        label: 'Numeric IDs in Mods=',
        status: 'fail',
        severity: 'warning',
        message: 'Two numeric IDs found in Mods=',
        category: 'mods',
        meta: { numericInMods: ['111', '222'] },
      },
    ],
    durationMs: 5,
  }
}

function emptyDiagnostics() {
  return {
    timestamp: '2026-09-18T00:00:01.000Z',
    overall: 'ok',
    summary: { ok: 5, warn: 0, fail: 0, info: 0, skip: 0 },
    categories: {},
    checks: [],
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
  socketHandlers.clear()
})

describe('Debug.tsx: activeServerChanged clears diagnostics before the refetch lands', () => {
  it('removes the numeric-IDs Fix button immediately, before a new diagnostics response arrives', async () => {
    let diagnosticsCallCount = 0
    let resolveSecondDiagnostics: (value: Response) => void = () => {}
    const secondDiagnostics = new Promise<Response>((resolve) => { resolveSecondDiagnostics = resolve })

    mockedApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/debug/diagnostics')) {
        diagnosticsCallCount += 1
        if (diagnosticsCallCount === 1) return jsonResponse(diagnosticsWithNumericCheck())
        // The activeServerChanged-triggered refetch -- held open so the
        // test can assert on the gap between the switch and this landing.
        return secondDiagnostics
      }
      return jsonResponse({})
    })
    batchToggleModIds.mockResolvedValue({ changed: 2 } as never)

    renderDebug()
    const fixButton = await screen.findByRole('button', { name: /strip 2 numeric ids/i })
    expect(fixButton).toBeInTheDocument()

    act(() => { emitActiveServerChanged() })
    await waitFor(() => expect(diagnosticsCallCount).toBe(2))

    // The stale check (and its Fix button) is gone immediately -- there's
    // nothing left to click that could still write against the new server.
    expect(screen.queryByRole('button', { name: /strip 2 numeric ids/i })).not.toBeInTheDocument()
    expect(batchToggleModIds).not.toHaveBeenCalled()

    await act(async () => { resolveSecondDiagnostics(jsonResponse(emptyDiagnostics())) })
  })
})
