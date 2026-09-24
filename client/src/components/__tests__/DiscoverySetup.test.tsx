import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DiscoverySetup } from '../DiscoverySetup'
import { serversApi, type DiscoveredMount } from '@/lib/api'

function renderDiscoverySetup(props: ComponentProps<typeof DiscoverySetup>) {
  return render(
    <TooltipProvider>
      <DiscoverySetup {...props} />
    </TooltipProvider>,
  )
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, createFromDiscovery: vi.fn(), activate: vi.fn() },
  }
})

// bug-hunt-2026-09-18 (round 18b): DiscoverySetup now reads useAuth().can()
// to gate its own Create button (servers.manage) -- default every existing
// test in this file to a permitted user so their pre-existing behavior is
// unchanged; the permission-gated case gets its own describe block below
// with a per-test override.
const canMock = vi.hoisted(() => vi.fn(() => true))
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ can: canMock }),
}))

const createFromDiscovery = vi.mocked(serversApi.createFromDiscovery)
const activate = vi.mocked(serversApi.activate)

const mount: DiscoveredMount = {
  installPath: '/pz-server',
  dataPath: '/pz-data',
  source: 'known-path',
  serverNames: ['servertest'],
  hasStartScript: true,
  hasPanelBridge: false,
}

beforeEach(() => {
  createFromDiscovery.mockReset()
  activate.mockReset()
  canMock.mockReset().mockReturnValue(true)
})

describe('DiscoverySetup', () => {
  it('renders nothing when there is no mount', () => {
    const { container } = renderDiscoverySetup({ open: true, onOpenChange: vi.fn(), mount: null })
    expect(container).toBeEmptyDOMElement()
  })

  it('pre-fills the display name from the discovered server name', () => {
    renderDiscoverySetup({ open: true, onOpenChange: vi.fn(), mount })
    expect(screen.getByDisplayValue('servertest')).toBeInTheDocument()
  })

  it('sends the real accented display name the operator typed, not the auto-filled default', async () => {
    createFromDiscovery.mockResolvedValue({ server: { id: 7 } as any, message: 'ok' })
    activate.mockResolvedValue({ server: { id: 7 } as any, message: 'ok' })
    const onCreated = vi.fn()
    renderDiscoverySetup({ open: true, onOpenChange: vi.fn(), mount, onCreated })

    const input = screen.getByDisplayValue('servertest')
    fireEvent.change(input, { target: { value: 'Serveur de Aurélie 日本語' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))

    await waitFor(() => expect(createFromDiscovery).toHaveBeenCalledTimes(1))
    expect(createFromDiscovery).toHaveBeenCalledWith({
      installPath: '/pz-server',
      dataPath: '/pz-data',
      serverName: 'servertest',
      name: 'Serveur de Aurélie 日本語',
    })
  })

  it('activates the newly created server and reports it before closing', async () => {
    createFromDiscovery.mockResolvedValue({ server: { id: 7, name: 'x' } as any, message: 'ok' })
    activate.mockResolvedValue({ server: { id: 7, name: 'x' } as any, message: 'ok' })
    const onCreated = vi.fn()
    const onOpenChange = vi.fn()
    renderDiscoverySetup({ open: true, onOpenChange, mount, onCreated })

    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))

    await waitFor(() => expect(activate).toHaveBeenCalledWith(7))
    expect(onCreated).toHaveBeenCalledWith({ id: 7, name: 'x' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('a failed create surfaces the real error and does not close the dialog or call onCreated', async () => {
    createFromDiscovery.mockRejectedValue(new Error('install path is not readable'))
    const onCreated = vi.fn()
    const onOpenChange = vi.fn()
    renderDiscoverySetup({ open: true, onOpenChange, mount, onCreated })

    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('install path is not readable')
    expect(onCreated).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
  })

  it('Cancel closes without creating anything', () => {
    const onOpenChange = vi.fn()
    renderDiscoverySetup({ open: true, onOpenChange, mount })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(createFromDiscovery).not.toHaveBeenCalled()
  })

  // bug-hunt-2026-09-18 (round 18b): POST /create-from-discovery now
  // requires servers.manage (round 18) -- this dialog's own Create button
  // had no matching client-side check at all, so a servers.discover-only
  // user could fill the form out completely and only discover the refusal
  // as a 403 at the very last step. This is the SECOND, independent layer
  // (Servers.tsx's own Connect button is fixed separately) -- it must hold
  // even if this dialog is ever reached some other way.
  describe('without servers.manage', () => {
    beforeEach(() => {
      canMock.mockImplementation((capability: string) => capability !== 'servers.manage')
    })

    it('disables the Create button and never calls createFromDiscovery when clicked', () => {
      renderDiscoverySetup({ open: true, onOpenChange: vi.fn(), mount })

      const addButton = screen.getByRole('button', { name: 'Add server' })
      expect(addButton).toBeDisabled()

      fireEvent.click(addButton)
      expect(createFromDiscovery).not.toHaveBeenCalled()
    })
  })
})
