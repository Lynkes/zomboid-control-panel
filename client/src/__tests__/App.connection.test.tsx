import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { useToast } from '@/components/ui/use-toast'

// How App.tsx turns socket.io events into the connection notice and toasts.
// The socket is a hand-driven fake; Layout is reduced to the two connection
// components so nothing else in the shell has to be stubbed.

const hoisted = vi.hoisted(() => ({
  socket: null as unknown,
  auth: { authEnabled: true },
  // One identity for every render, as the real AuthProvider keeps: App's
  // socket effect depends on it and reconnects whenever it changes.
  getToken: () => 'token',
}))

vi.mock('socket.io-client', () => ({
  io: () => hoisted.socket,
}))

vi.mock('@/contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    authEnabled: hoisted.auth.authEnabled,
    statusCheckFailed: false,
    statusCheckCode: null,
    retryAuthCheck: vi.fn(),
    getToken: hoisted.getToken,
  }),
}))

vi.mock('@/components/Layout', async () => {
  const { ConnectionStatus, ConnectionAnnouncer } = await import('@/components/ConnectionStatus')
  return {
    default: ({ children }: { children: React.ReactNode }) => (
      <div>
        <ConnectionAnnouncer />
        <ConnectionStatus showLabel />
        {children}
      </div>
    ),
  }
})

type Handler = (...args: unknown[]) => void

function createFakeSocket() {
  const socketHandlers = new Map<string, Handler[]>()
  const managerHandlers = new Map<string, Handler[]>()
  const register = (map: Map<string, Handler[]>) => (event: string, handler: Handler) => {
    map.set(event, [...(map.get(event) ?? []), handler])
  }
  const socket = {
    active: true,
    auth: null as unknown,
    connect: vi.fn(),
    close: vi.fn(),
    emit: vi.fn(),
    on: (event: string, handler: Handler) => {
      register(socketHandlers)(event, handler)
      return socket
    },
    off: vi.fn(),
    io: { on: register(managerHandlers) },
  }
  return {
    socket,
    fire: (event: string, ...args: unknown[]) => act(() => socketHandlers.get(event)?.forEach((h) => h(...args))),
    fireManager: (event: string, ...args: unknown[]) => act(() => managerHandlers.get(event)?.forEach((h) => h(...args))),
  }
}

async function renderApp() {
  const { default: App } = await import('@/App')
  return render(
    <MemoryRouter initialEntries={['/nowhere']}>
      <App />
    </MemoryRouter>,
  )
}

// The socket is created after a dynamic import(), so wait for its handlers.
async function connected(fake: ReturnType<typeof createFakeSocket>) {
  await vi.waitFor(() => expect(fake.socket.connect).toHaveBeenCalled())
}

const DOWN = /Live Updates Unavailable/

// The screen-reader live region (the toast list has status roles of its own).
const announcer = (container: HTMLElement) => container.querySelector('p[role="status"]')

let fake: ReturnType<typeof createFakeSocket>

beforeEach(() => {
  fake = createFakeSocket()
  hoisted.socket = fake.socket
  hoisted.auth.authEnabled = true
})

afterEach(async () => {
  cleanup()
  // The toast store is module-wide: close what this test raised, or the next
  // one starts with it on screen.
  const toasts = renderHook(() => useToast())
  act(() => toasts.result.current.dismiss())
  toasts.unmount()
  vi.unstubAllEnvs()
  if (i18n.language !== 'en') await i18n.changeLanguage('en')
})

describe('App: connection messages follow the interface language', () => {
  // The Retry popover shows the stored reason as its technical detail.
  async function openNoticeText() {
    fireEvent.click(await screen.findByRole('button', { name: /Live Updates Unavailable|Live-Updates nicht verfügbar/ }))
    return (await screen.findByRole('dialog')).textContent ?? ''
  }

  it('toasts and explains a lost connection in English', async () => {
    await renderApp()
    await connected(fake)
    fake.fireManager('reconnect_failed')
    expect(await screen.findByText('Connection Lost')).toBeInTheDocument()
    expect(screen.getByText(/Unable to reconnect automatically/)).toBeInTheDocument()
    expect(await openNoticeText()).toContain('Technical detail: Failed to reconnect after multiple attempts')
  })

  it('toasts and explains a lost connection in German', async () => {
    await i18n.changeLanguage('de')
    await renderApp()
    await connected(fake)
    fake.fireManager('reconnect_failed')
    expect(await screen.findByText('Verbindung verloren')).toBeInTheDocument()
    expect(screen.queryByText('Connection Lost')).not.toBeInTheDocument()
    expect(screen.queryByText(/Unable to reconnect automatically/)).not.toBeInTheDocument()
    const popover = await openNoticeText()
    expect(popover).toContain('Wiederverbindung nach mehreren Versuchen fehlgeschlagen')
    expect(popover).not.toContain('Failed to reconnect')
  })

  it('says the server closed the connection in the interface language', async () => {
    await i18n.changeLanguage('fr')
    await renderApp()
    await connected(fake)
    fake.fire('connect')
    fake.fire('disconnect', 'io server disconnect')
    fireEvent.click(await screen.findByRole('button', { name: /indisponibles/ }))
    expect((await screen.findByRole('dialog')).textContent).toContain('Le serveur a fermé la connexion')
  })

  it('labels a refused connection with a translated fallback instead of English', async () => {
    await i18n.changeLanguage('es')
    await renderApp()
    await connected(fake)
    fake.socket.active = false
    // An error with no message of its own is what falls back to the label.
    fake.fire('connect_error', new Error(''))
    fireEvent.click(await screen.findByRole('button', { name: /no disponibles/ }))
    const popover = (await screen.findByRole('dialog')).textContent ?? ''
    expect(popover).toContain('Error de conexión')
    expect(popover).not.toContain('Connection error')
  })

  it('toasts a restored connection in the interface language', async () => {
    await i18n.changeLanguage('de')
    await renderApp()
    await connected(fake)
    fake.fire('connect_error', new Error('xhr poll error'))
    fake.fire('connect')
    expect(await screen.findByText('Wieder verbunden')).toBeInTheDocument()
    expect(screen.getByText('Die Verbindung zum Server wurde wiederhergestellt')).toBeInTheDocument()
  })

  it('does not drop the socket when the language is switched', async () => {
    await renderApp()
    await connected(fake)
    await act(async () => {
      await i18n.changeLanguage('de')
    })
    expect(fake.socket.close).not.toHaveBeenCalled()
  })
})

describe('App: the reconnect attempt counter', () => {
  async function openNotice() {
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnecting...' }))
    return screen.findByRole('dialog')
  }

  it('counts the retry after a refused token as attempt 1, not attempt 0', async () => {
    await renderApp()
    await connected(fake)
    fake.socket.active = false
    fake.fire('connect_error', new Error('Invalid or expired token'))
    expect(await openNotice()).toHaveTextContent('Attempt 1/10')
  })

  it('counts the first automatic retry as attempt 1 before socket.io reports it', async () => {
    await renderApp()
    await connected(fake)
    fake.fire('connect_error', new Error('xhr poll error'))
    expect(await openNotice()).toHaveTextContent('Attempt 1/10')
  })

  it('follows the attempt number socket.io reports afterwards', async () => {
    await renderApp()
    await connected(fake)
    fake.fire('connect_error', new Error('xhr poll error'))
    fake.fireManager('reconnect_attempt', 4)
    expect(await openNotice()).toHaveTextContent('Attempt 4/10')
  })
})

describe('App: the live-update notice', () => {
  it('stays hidden while the first connect is under way instead of flashing "Live Updates Unavailable"', async () => {
    const { container } = await renderApp()
    await connected(fake)
    expect(screen.queryByRole('button', { name: DOWN })).not.toBeInTheDocument()
    expect(announcer(container)).toBeEmptyDOMElement()
  })

  it('stays hidden once the first connect succeeds', async () => {
    await renderApp()
    await connected(fake)
    fake.fire('connect')
    expect(screen.queryByRole('button', { name: DOWN })).not.toBeInTheDocument()
  })

  it('shows after the connection is refused for good', async () => {
    await renderApp()
    await connected(fake)
    fake.socket.active = false
    fake.fire('connect_error', new Error('websocket error'))
    expect(await screen.findByRole('button', { name: DOWN })).toBeInTheDocument()
  })

  it('shows after the reconnect attempts run out', async () => {
    await renderApp()
    await connected(fake)
    fake.fireManager('reconnect_failed')
    expect(await screen.findByRole('button', { name: DOWN })).toBeInTheDocument()
  })

  it('shows after an established connection drops', async () => {
    await renderApp()
    await connected(fake)
    fake.fire('connect')
    fake.fire('disconnect', 'transport error')
    expect(await screen.findByRole('button', { name: DOWN })).toBeInTheDocument()
  })

  it('never shows in the public demo, which opens no socket', async () => {
    vi.stubEnv('VITE_DEMO_MODE', 'true')
    const { container } = await renderApp()
    // No socket in the demo: give App a beat to (not) create one.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(fake.socket.connect).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: DOWN })).not.toBeInTheDocument()
    expect(announcer(container)).toBeNull()
  })
})
