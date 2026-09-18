import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SocketContext } from '@/contexts/SocketContext'
import type { Socket } from 'socket.io-client'
import ServerSetup, { INSTALL_INFLIGHT_KEY } from '../ServerSetup'
import { serverApi, serversApi } from '@/lib/api'
import enServerSetup from '../../locales/en/serverSetup.json'

// 2026-08-26 install-failure hunt (finding #7) + god's follow-up dispatch:
// install:complete/install:log are heard by exactly one file in the whole
// client (this one), and a tab closed or reloaded mid-download loses the
// eventual outcome entirely -- no persisted state, no way back. This file
// covers the two CLIENT-side fixes from that dispatch:
//   1. The resume banner: a marker left by a previous page load is surfaced
//      on remount instead of silently forgotten.
//   2. The create-vs-activate split (finding #2): a server that WAS created
//      but failed to auto-activate must never be reported as "failed to
//      create server entry" -- that told the operator the whole thing failed
//      when only the auto-switch-active-server step had.

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, create: vi.fn(), activate: vi.fn() },
    // install-events-cross-install-contamination fix, 2026-09-18: handleInstall
    // now only accepts an install:complete broadcast whose installPath matches
    // what THIS wizard instance itself POSTed -- so the "create-vs-activate
    // messaging" tests below must drive a real handleInstall() call (mocked to
    // resolve) instead of firing install:complete cold, or the fixed filter
    // (correctly) drops their fake broadcast as an unrecognized install.
    serverApi: { ...actual.serverApi, install: vi.fn() },
  }
})

// Radix's Slider (RAM sliders on full-wizard step3) measures its own DOM node
// via ResizeObserver, which jsdom does not implement -- same stub as
// ServerSetup.capabilityGating.test.tsx. Needed now that the helper below
// drives through step3 to reach the Install button.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

// jsdom doesn't implement scrollIntoView either -- the install-log
// auto-scroll effect calls it once handleInstall's addLog() populates `logs`.
Element.prototype.scrollIntoView = vi.fn()

// bug-hunt-2026-08-27: ServerSetup.tsx gained its first useAuth() call for
// capability gating -- outside an AuthProvider that throws, which this file
// never wrapped in one because it never needed one before. can() fails open
// (returns true) so none of the assertions below, none of which are about
// capability gating, are affected by it.
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

// useToast's own store is a module-level singleton (memoryState, not React
// state) with no reset hook -- toasts from an earlier test in this same file
// would otherwise still be sitting in the DOM (TOAST_LIMIT=5) when the next
// test's <Toaster/> renders, making "the wrong toast did NOT appear"
// unprovable. Mock it with a plain spy instead, cleared per test.
const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const create = vi.mocked(serversApi.create)
const activate = vi.mocked(serversApi.activate)
const install = vi.mocked(serverApi.install)

// Minimal fake matching only what ServerSetup actually calls (on/off) --
// real socket.io-client is not needed to prove these two behaviors.
function createFakeSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const socket = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler)
    }),
    emit: vi.fn(),
  }
  return {
    socket: socket as unknown as Socket,
    trigger: (event: string, data?: unknown) => {
      listeners.get(event)?.forEach((h) => h(data))
    },
  }
}

function renderServerSetup(socket: Socket | null = null) {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={socket}>
        <TooltipProvider>
          <ServerSetup />
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  create.mockReset()
  activate.mockReset()
  install.mockReset()
  toastSpy.mockClear()
})

// Drives a real handleInstall() call (POST /server/install mocked to resolve)
// for the given installPath/serverName, so installOperationPathRef is set
// exactly the way production sets it before install:complete/install:log can
// ever be accepted -- see the cross-install contamination fix's own comment
// in ServerSetup.tsx. Uses the resume-marker shortcut (Continue setup) to
// land directly on full-wizard step 2 with installPath/serverName prefilled,
// skipping step 1's SteamCMD-detection gate entirely (irrelevant here since
// POST /server/install itself is mocked).
async function reachFullInstallButton(installPath: string, serverName: string, socket: Socket) {
  localStorage.setItem(
    INSTALL_INFLIGHT_KEY,
    JSON.stringify({ installPath, serverName, startedAt: Date.now() }),
  )
  renderServerSetup(socket)

  await screen.findByText(enServerSetup.resumeBanner.title)
  fireEvent.click(screen.getByRole('button', { name: enServerSetup.resumeBanner.continueButton }))

  await screen.findByText(enServerSetup.full.step2.title)
  fireEvent.click(screen.getByRole('button', { name: enServerSetup.common.nextStepButton }))

  await screen.findByText(enServerSetup.full.step3.title)
  fireEvent.change(screen.getByPlaceholderText(enServerSetup.common.adminPasswordPlaceholder), {
    target: { value: 'adminpass123' },
  })
  fireEvent.click(screen.getByRole('button', { name: enServerSetup.common.nextStepButton }))

  await screen.findByText(enServerSetup.full.step4.title)
  install.mockResolvedValue({ success: true, message: 'Installation started', installPath, branch: 'public' } as Awaited<ReturnType<typeof serverApi.install>>)
  fireEvent.click(screen.getByRole('button', { name: enServerSetup.full.step4.installButton }))

  // handleInstall's own await (serverApi.install, mocked above) must settle
  // and set installOperationPathRef before the test fires install:complete.
  await waitFor(() => expect(install).toHaveBeenCalled())
}

describe('ServerSetup -- resume banner for an install left running by a previous page load', () => {
  it('shows nothing when no marker was left behind', async () => {
    renderServerSetup()
    await screen.findByText(enServerSetup.modeSelect.title)
    expect(screen.queryByText(enServerSetup.resumeBanner.title)).not.toBeInTheDocument()
  })

  it('surfaces a fresh marker with the install path it names, and Dismiss clears it for good', async () => {
    localStorage.setItem(
      INSTALL_INFLIGHT_KEY,
      JSON.stringify({ installPath: '/srv/pz-fresh', serverName: 'fresh-server', startedAt: Date.now() - 60_000 }),
    )
    renderServerSetup()

    await screen.findByText(enServerSetup.resumeBanner.title)
    expect(screen.getByText(/\/srv\/pz-fresh/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: enServerSetup.resumeBanner.dismissButton }))

    expect(screen.queryByText(enServerSetup.resumeBanner.title)).not.toBeInTheDocument()
    expect(localStorage.getItem(INSTALL_INFLIGHT_KEY)).toBeNull()
  })

  it('treats a marker older than the stale threshold as gone, not as "still running"', async () => {
    localStorage.setItem(
      INSTALL_INFLIGHT_KEY,
      JSON.stringify({ installPath: '/srv/pz-old', serverName: 'old-server', startedAt: Date.now() - 7 * 60 * 60 * 1000 }),
    )
    renderServerSetup()

    // Give the mount effect a tick, then confirm the banner never appears
    // and the stale marker was cleaned up rather than left to nag forever.
    await screen.findByText(enServerSetup.modeSelect.title)
    expect(screen.queryByText(enServerSetup.resumeBanner.title)).not.toBeInTheDocument()
    expect(localStorage.getItem(INSTALL_INFLIGHT_KEY)).toBeNull()
  })

  it('Continue setup pre-fills the install path/server name and drops straight into the full wizard', async () => {
    localStorage.setItem(
      INSTALL_INFLIGHT_KEY,
      JSON.stringify({ installPath: '/srv/pz-continue', serverName: 'continue-server', startedAt: Date.now() - 60_000 }),
    )
    renderServerSetup()

    await screen.findByText(enServerSetup.resumeBanner.title)
    fireEvent.click(screen.getByRole('button', { name: enServerSetup.resumeBanner.continueButton }))

    // Landed past the mode-select screen (its title is gone) and the install
    // path field carries the marker's value forward instead of starting blank.
    await waitFor(() => expect(screen.queryByText(enServerSetup.modeSelect.title)).not.toBeInTheDocument())
    expect(screen.getByDisplayValue('/srv/pz-continue')).toBeInTheDocument()
  })
})

describe('ServerSetup -- install:complete create-vs-activate messaging (finding #2)', () => {
  const successPayload = {
    success: true,
    message: 'Server installed successfully',
    installPath: '/srv/pz',
    serverName: 'myserver',
    rconPort: 27015,
    serverPort: 16261,
    minMemory: 4,
    maxMemory: 8,
  }

  it('reports registration failure (not activation failure) when create() itself throws', async () => {
    create.mockRejectedValue(new Error('db write failed'))
    const fake = createFakeSocket()
    await reachFullInstallButton(successPayload.installPath, successPayload.serverName, fake.socket)

    fake.trigger('install:complete', successPayload)

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: enServerSetup.toasts.registerFailedTitle }),
      ),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: enServerSetup.toasts.activateFailedTitle }),
    )
    expect(activate).not.toHaveBeenCalled()
  })

  it('reports activation failure specifically -- not "failed to create" -- when create() succeeds but activate() throws', async () => {
    create.mockResolvedValue({ server: { id: 42 } } as unknown as Awaited<ReturnType<typeof serversApi.create>>)
    activate.mockRejectedValue(new Error('activate failed'))
    const fake = createFakeSocket()
    await reachFullInstallButton(successPayload.installPath, successPayload.serverName, fake.socket)

    fake.trigger('install:complete', successPayload)

    // The bug this covers: this used to say "Server files installed, but
    // registration failed" here, even though the server WAS registered.
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: enServerSetup.toasts.activateFailedTitle }),
      ),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: enServerSetup.toasts.registerFailedTitle }),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: enServerSetup.toasts.serverInstalledTitle }),
    )
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('reports full success when both create() and activate() succeed', async () => {
    create.mockResolvedValue({ server: { id: 42 } } as unknown as Awaited<ReturnType<typeof serversApi.create>>)
    activate.mockResolvedValue({ server: { id: 42 } } as unknown as Awaited<ReturnType<typeof serversApi.activate>>)
    const fake = createFakeSocket()
    await reachFullInstallButton(successPayload.installPath, successPayload.serverName, fake.socket)

    fake.trigger('install:complete', successPayload)

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: enServerSetup.toasts.serverInstalledTitle }),
      ),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: enServerSetup.toasts.registerFailedTitle }),
    )
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: enServerSetup.toasts.activateFailedTitle }),
    )
  })

  it('clears the in-flight marker as soon as an outcome is heard, success or failure', async () => {
    create.mockRejectedValue(new Error('db write failed'))
    const fake = createFakeSocket()
    // reachFullInstallButton's own handleInstall call already writes a fresh
    // in-flight marker for this installPath (see writeInstallInFlightMarker
    // at its call site in ServerSetup.tsx) -- this test only needs to prove
    // it gets cleared once install:complete lands.
    await reachFullInstallButton(successPayload.installPath, successPayload.serverName, fake.socket)
    expect(localStorage.getItem(INSTALL_INFLIGHT_KEY)).not.toBeNull()

    fake.trigger('install:complete', { ...successPayload, success: false, message: 'boom' })

    await waitFor(() => expect(localStorage.getItem(INSTALL_INFLIGHT_KEY)).toBeNull())
  })
})

// install-events-cross-install-contamination, 2026-09-18: POST /install's
// concurrency guard is scoped per installPath, so two operators (or one
// operator running two setup wizards in two tabs) can genuinely run two
// installs at once -- install:log/install:complete used to carry no
// identifier at all, so whichever wizard was open received every event
// regardless of which install it belonged to. Same shape, same fix, as
// Servers.steamEventsCrossServerContamination.test.tsx proves for
// Servers.tsx's steam:* events.
describe('ServerSetup -- install:log/install:complete are scoped to the install this wizard started', () => {
  it("ignores a different install's log line and completion event, then still resolves correctly on its own matching event", async () => {
    create.mockResolvedValue({ server: { id: 42 } } as unknown as Awaited<ReturnType<typeof serversApi.create>>)
    activate.mockResolvedValue({ server: { id: 42 } } as unknown as Awaited<ReturnType<typeof serversApi.activate>>)
    const fake = createFakeSocket()
    await reachFullInstallButton('/srv/pz-a', 'server-a', fake.socket)

    // An unrelated, concurrently-running install to a DIFFERENT path
    // ('/srv/pz-b') sends its own log line -- must never surface in this
    // wizard, which only ever started an install to '/srv/pz-a'.
    fake.trigger('install:log', { type: 'stdout', text: 'unrelated-install-b-line', installPath: '/srv/pz-b' })
    expect(screen.queryByText(/unrelated-install-b-line/)).not.toBeInTheDocument()

    // The unrelated install now completes -- this must NOT be mistaken for
    // this wizard's own result (no toast, no server registration attempt).
    fake.trigger('install:complete', {
      success: true,
      message: 'Server installed successfully',
      installPath: '/srv/pz-b',
      serverName: 'server-b',
    })
    expect(create).not.toHaveBeenCalled()
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: enServerSetup.toasts.serverInstalledTitle }),
    )

    // This wizard's own matching completion event still resolves normally --
    // the fix doesn't just drop everything, only what doesn't match.
    fake.trigger('install:complete', {
      success: true,
      message: 'Server installed successfully',
      installPath: '/srv/pz-a',
      serverName: 'server-a',
      rconPort: 27015,
      serverPort: 16261,
      minMemory: 4,
      maxMemory: 8,
    })
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: enServerSetup.toasts.serverInstalledTitle }),
      ),
    )
    expect(create).toHaveBeenCalledTimes(1)
  })
})
