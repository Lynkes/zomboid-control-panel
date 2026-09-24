import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { SocketContext } from '@/contexts/SocketContext'
import Debug from '../Debug'
import { apiFetch } from '@/lib/api'
import errorsEn from '../../locales/en/errors.json'

// bug-hunt-2026-09-18 (round 14, raw result.error sweep): POST
// /api/debug/paths never attaches a `code` today (server/routes/debug.js's
// /paths route -> utils/paths.js's setDataPaths(), both grepped clean of any
// `code:`/`ErrorCode` reference) -- but handleSavePaths' failure toast is
// still routed through getUserErrorMessage() rather than showing data.error
// unconditionally, matching the Console.tsx fix from round 13. This proves
// two things: a coded failure (simulated here since none exists on this path
// today) IS translated, and the existing uncoded/bucket-C behavior is
// unchanged.

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

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const fakeSocket = {
  connected: true,
  on: () => {},
  off: () => {},
  emit: vi.fn(),
} as unknown as Parameters<typeof SocketContext.Provider>[0]['value']

const mockedApiFetch = vi.mocked(apiFetch)

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
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

async function openChangePaths() {
  const environmentTab = await screen.findByRole('tab', { name: /environment/i })
  fireEvent.mouseDown(environmentTab)
  fireEvent.click(environmentTab)
  const changePathsButton = await screen.findByRole('button', { name: /change paths/i })
  fireEvent.click(changePathsButton)
}

async function saveNewDataDir(value: string) {
  const dataDirInput = await screen.findByLabelText(/data directory/i)
  fireEvent.change(dataDirInput, { target: { value } })
  const saveButton = screen.getByRole('button', { name: /save/i })
  fireEvent.click(saveButton)
}

describe('Debug.tsx: a failed path update translates a server error code instead of showing raw prose unconditionally', () => {
  it('shows the translated message when the response carries a registered code', async () => {
    mockedApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/debug/paths')) {
        return jsonResponse({
          error: 'Zomboid data folder is not writable: /opt/panel/data',
          code: 'WRITABLE_PATH_DATA_BAREMETAL',
          params: { path: '/opt/panel/data' },
        })
      }
      return jsonResponse({})
    })

    renderDebug()
    await openChangePaths()
    await saveNewDataDir('/opt/panel/data')

    const expected = errorsEn.WRITABLE_PATH_DATA_BAREMETAL.replace('{{path}}', '/opt/panel/data')
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ description: expected, variant: 'destructive' }),
      ),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Zomboid data folder is not writable: /opt/panel/data',
      }),
    )
  })

  it('still shows the raw validation text unchanged when the response carries no code (bucket C, today\'s real shape)', async () => {
    mockedApiFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/debug/paths')) {
        return jsonResponse({ error: 'Path targets a protected system directory' })
      }
      return jsonResponse({})
    })

    renderDebug()
    await openChangePaths()
    await saveNewDataDir('/etc')

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Path targets a protected system directory',
          variant: 'destructive',
        }),
      ),
    )
  })
})
