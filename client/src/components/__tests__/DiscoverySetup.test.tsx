import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DiscoverySetup } from '../DiscoverySetup'
import { serversApi, type DiscoveredMount } from '@/lib/api'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serversApi: { ...actual.serversApi, createFromDiscovery: vi.fn(), activate: vi.fn() },
  }
})

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
})

describe('DiscoverySetup', () => {
  it('renders nothing when there is no mount', () => {
    const { container } = render(<DiscoverySetup open onOpenChange={vi.fn()} mount={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('pre-fills the display name from the discovered server name', () => {
    render(<DiscoverySetup open onOpenChange={vi.fn()} mount={mount} />)
    expect(screen.getByDisplayValue('servertest')).toBeInTheDocument()
  })

  it('sends the real accented display name the operator typed, not the auto-filled default', async () => {
    createFromDiscovery.mockResolvedValue({ server: { id: 7 } as any, message: 'ok' })
    activate.mockResolvedValue({ server: { id: 7 } as any, message: 'ok' })
    const onCreated = vi.fn()
    render(<DiscoverySetup open onOpenChange={vi.fn()} mount={mount} onCreated={onCreated} />)

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
    render(<DiscoverySetup open onOpenChange={onOpenChange} mount={mount} onCreated={onCreated} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))

    await waitFor(() => expect(activate).toHaveBeenCalledWith(7))
    expect(onCreated).toHaveBeenCalledWith({ id: 7, name: 'x' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('a failed create surfaces the real error and does not close the dialog or call onCreated', async () => {
    createFromDiscovery.mockRejectedValue(new Error('install path is not readable'))
    const onCreated = vi.fn()
    const onOpenChange = vi.fn()
    render(<DiscoverySetup open onOpenChange={onOpenChange} mount={mount} onCreated={onCreated} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('install path is not readable')
    expect(onCreated).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
  })

  it('Cancel closes without creating anything', () => {
    const onOpenChange = vi.fn()
    render(<DiscoverySetup open onOpenChange={onOpenChange} mount={mount} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(createFromDiscovery).not.toHaveBeenCalled()
  })
})
