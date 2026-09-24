import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { SocketContext } from '@/contexts/SocketContext'
import Debug from '../Debug'
import { apiFetch } from '@/lib/api'

// bug-hunt-2026-09-18 (round 10, activeServerChanged race sweep continued):
// fetchDiagnostics runs on mount, on a 30s poll, AND on activeServerChanged
// (round 9's fix, diagnosticsGuard) -- same race shape as Dashboard's
// fetchStatus: a manual/poll call for the server that was active a moment
// ago, still in flight, could resolve AFTER the activeServerChanged-
// triggered call for the NEW server and silently overwrite it.

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

// Debug.tsx reads the socket via useContext(SocketContext) directly, not a
// useSocket() hook -- render with the real SocketContext.Provider (same
// pattern as Servers.updateStatusUnknown.test.tsx) rather than mocking the
// context module. Handler registry lives outside React so
// emitActiveServerChanged() can reach it independent of re-renders.
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

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

function diagnosticsFixture(overall: 'ok' | 'fail') {
  return {
    timestamp: '2026-09-18T00:00:00.000Z',
    overall,
    summary: {
      ok: overall === 'ok' ? 5 : 3,
      warn: 0,
      fail: overall === 'fail' ? 2 : 0,
      info: 0,
      skip: 0,
    },
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

describe('Debug.tsx: an older, slower diagnostics response must not overwrite a newer one', () => {
  it('keeps the newer overall verdict when an earlier in-flight fetchDiagnostics resolves AFTER the activeServerChanged fetch', async () => {
    let diagnosticsCallCount = 0
    let resolveStaleDiagnostics: (value: Response) => void = () => {}
    const staleDiagnostics = new Promise<Response>((resolve) => { resolveStaleDiagnostics = resolve })

    mockedApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/debug/diagnostics')) {
        diagnosticsCallCount += 1
        // Call #1 (mount): resolves fast -- this page renders its Tabs UI
        // unconditionally regardless of this settling, so it's safe to be
        // the one that resolves normally rather than held open.
        if (diagnosticsCallCount === 1) return jsonResponse(diagnosticsFixture('ok'))
        // Call #2 (a manual "Rerun" click, standing in for a slow poll
        // tick): held open, for whichever server was active when issued.
        if (diagnosticsCallCount === 2) return staleDiagnostics
        // Call #3 (activeServerChanged): resolves immediately with a
        // different overall verdict, so a wrongly-applied stale response is
        // visibly distinguishable.
        return jsonResponse(diagnosticsFixture('fail'))
      }
      // Every other mount-time fetch (system/health/logs/logs-files/
      // crash-logs/performance) -- generic empty success so those unrelated
      // fetchers don't error and spam reportClientError during the test.
      return jsonResponse({})
    })

    renderDebug()
    expect(await screen.findByText('All systems operational')).toBeInTheDocument()
    expect(diagnosticsCallCount).toBe(1)

    const rerunButton = await screen.findByRole('button', { name: /re-run/i })
    fireEvent.click(rerunButton)
    await waitFor(() => expect(diagnosticsCallCount).toBe(2))

    await act(async () => { emitActiveServerChanged() })
    await waitFor(() => expect(diagnosticsCallCount).toBe(3))
    expect(await screen.findByText('Issues need attention')).toBeInTheDocument()

    // The stale call #2 finally lands, arriving strictly after call #3's
    // already-applied, newer response.
    await act(async () => { resolveStaleDiagnostics(jsonResponse(diagnosticsFixture('ok'))) })

    // The bug: unfixed code has nothing gating this late apply, so it
    // silently reverts the overall verdict back to "ok" even though the
    // server is confirmed unhealthy by the newer response.
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Issues need attention')).toBeInTheDocument()
    expect(screen.queryByText('All systems operational')).not.toBeInTheDocument()
  })
})
