import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { panelBridgeApi, serverApi, serverFilesApi } from '@/lib/api'
import type { DeliveryStatus } from '@/lib/bridgeDeliveryTypes'
import en from '@/locales/en/bridgeDelivery.json'
import { BridgeChecksumDialog } from '../BridgeChecksumDialog'
import { makeWorkshopStatus } from './deliveryFixtures'

let mockCan: (capability: string) => boolean = () => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'admin', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
  }),
}))

const toastMock = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastMock, dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    panelBridgeApi: { ...actual.panelBridgeApi, getDelivery: vi.fn() },
    serverFilesApi: { ...actual.serverFilesApi, saveIni: vi.fn() },
    serverApi: { ...actual.serverApi, start: vi.fn(), restart: vi.fn() },
  }
})

const getDelivery = vi.mocked(panelBridgeApi.getDelivery)
const saveIni = vi.mocked(serverFilesApi.saveIni)
const restart = vi.mocked(serverApi.restart)
const start = vi.mocked(serverApi.start)

function renderDialog(status: DeliveryStatus, playerCount: number | null = null) {
  const onOpenChange = vi.fn()
  const onChanged = vi.fn()
  render(
    <MemoryRouter>
      <TooltipProvider>
        <BridgeChecksumDialog open onOpenChange={onOpenChange} status={status} playerCount={playerCount} onChanged={onChanged} />
      </TooltipProvider>
    </MemoryRouter>,
  )
  return { onOpenChange, onChanged }
}

const confirmButton = () => screen.getByRole('button', { name: en.checksumOffer.confirm })
const tick = (label: string) => fireEvent.click(screen.getByRole('checkbox', { name: label }))

beforeEach(() => {
  mockCan = () => true
  saveIni.mockResolvedValue({ success: true, message: 'saved', path: 'x', settings: { DoLuaChecksum: 'true' } })
  restart.mockResolvedValue({})
  start.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BridgeChecksumDialog: required acknowledgements', () => {
  it('uses the §4.3 security sentence and never says "anti-cheat"', () => {
    renderDialog(makeWorkshopStatus())
    expect(screen.getByText(en.security.sentence)).toBeInTheDocument()
    expect(document.body.textContent?.toLowerCase()).not.toContain('anti-cheat')
  })

  it('the non-admin acknowledgement is required before anything is written', async () => {
    getDelivery.mockResolvedValue(makeWorkshopStatus())
    renderDialog(makeWorkshopStatus())
    expect(confirmButton()).toBeDisabled()
    fireEvent.focus(confirmButton().parentElement!)
    expect((await screen.findAllByText(en.checksumOffer.ackRequired)).length).toBeGreaterThan(0)
    fireEvent.click(confirmButton())
    expect(saveIni).not.toHaveBeenCalled()

    tick(en.checksumOffer.ackNonAdmin)
    expect(confirmButton()).toBeEnabled()
  })

  it('asks for the Linux acknowledgement only when requiresLinuxAck', () => {
    renderDialog(makeWorkshopStatus())
    expect(screen.queryByRole('checkbox', { name: en.checksumOffer.ackLinux })).toBeNull()
    cleanup()

    renderDialog(makeWorkshopStatus({ hostOs: 'linux', checksum: { current: false, canTurnOn: true, turnOnBlockers: [], playersBlocked: false, requiresLinuxAck: true } }))
    tick(en.checksumOffer.ackNonAdmin)
    expect(confirmButton()).toBeDisabled()
    tick(en.checksumOffer.ackLinux)
    expect(confirmButton()).toBeEnabled()
  })

  it('asks guided servers to confirm the uploaded files are gone, and only gives instructions', () => {
    renderDialog(makeWorkshopStatus({ access: 'guided', disk: null, checksum: { current: null, canTurnOn: true, turnOnBlockers: [], playersBlocked: false, requiresLinuxAck: false } }))
    expect(screen.getByText(en.checksumOffer.guidedInstructions)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: en.checksumOffer.confirm })).toBeNull()
    expect(screen.getByRole('button', { name: en.checksumOffer.openServerConfig })).toBeDisabled()
    tick(en.checksumOffer.ackNonAdmin)
    expect(screen.getByRole('button', { name: en.checksumOffer.openServerConfig })).toBeDisabled()
    tick(en.checksumOffer.ackRemoteFiles)
    const link = screen.getByRole('link', { name: en.checksumOffer.openServerConfig })
    expect(link).toHaveAttribute('href', '/server-config?tab=ini&search=DoLuaChecksum')
    expect(saveIni).not.toHaveBeenCalled()
  })

  it('the remote-files acknowledgement never shows for automatic access', () => {
    renderDialog(makeWorkshopStatus())
    expect(screen.queryByRole('checkbox', { name: en.checksumOffer.ackRemoteFiles })).toBeNull()
  })
})

describe('BridgeChecksumDialog: turning it on (automatic access)', () => {
  it('re-reads the status and writes DoLuaChecksum=true only while it still says canTurnOn', async () => {
    getDelivery.mockResolvedValue(makeWorkshopStatus())
    const { onChanged } = renderDialog(makeWorkshopStatus())
    tick(en.checksumOffer.ackNonAdmin)
    fireEvent.click(confirmButton())
    await waitFor(() => expect(saveIni).toHaveBeenCalledWith({ DoLuaChecksum: 'true' }))
    expect(getDelivery.mock.invocationCallOrder[0]).toBeLessThan(saveIni.mock.invocationCallOrder[0])
    expect(await screen.findByText(en.checksumOffer.restartPrompt)).toBeInTheDocument()
    expect(onChanged).toHaveBeenCalled()
  })

  it('refuses when the fresh status no longer allows it (a loose file came back)', async () => {
    getDelivery.mockResolvedValue(
      makeWorkshopStatus({ checksum: { current: false, canTurnOn: false, turnOnBlockers: ['looseFilesPresent'], playersBlocked: false, requiresLinuxAck: false } }),
    )
    renderDialog(makeWorkshopStatus())
    tick(en.checksumOffer.ackNonAdmin)
    fireEvent.click(confirmButton())
    expect(await screen.findByText(en.checksumOffer.noLongerAvailable)).toBeInTheDocument()
    expect(saveIni).not.toHaveBeenCalled()
  })

  it('refuses when the active server changed underneath the dialog', async () => {
    getDelivery.mockResolvedValue(makeWorkshopStatus({ serverId: 'srv-2' }))
    renderDialog(makeWorkshopStatus())
    tick(en.checksumOffer.ackNonAdmin)
    fireEvent.click(confirmButton())
    expect(await screen.findByText(en.checksumOffer.noLongerAvailable)).toBeInTheDocument()
    expect(saveIni).not.toHaveBeenCalled()
  })

  it('then offers the restart, with a warning when players are online', async () => {
    getDelivery.mockResolvedValue(makeWorkshopStatus())
    const { onOpenChange } = renderDialog(makeWorkshopStatus(), 2)
    tick(en.checksumOffer.ackNonAdmin)
    fireEvent.click(confirmButton())
    fireEvent.click(await screen.findByRole('button', { name: en.action.restartNow }))
    await waitFor(() => expect(restart).toHaveBeenCalledWith(5))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('offers Start instead when the server is stopped', async () => {
    getDelivery.mockResolvedValue(makeWorkshopStatus({ serverRunning: false }))
    renderDialog(makeWorkshopStatus({ serverRunning: false }))
    tick(en.checksumOffer.ackNonAdmin)
    fireEvent.click(confirmButton())
    fireEvent.click(await screen.findByRole('button', { name: en.action.startServer }))
    await waitFor(() => expect(start).toHaveBeenCalled())
  })

  it('without serverfiles.manage the confirm button is disabled and explains why', async () => {
    mockCan = (capability) => capability !== 'serverfiles.manage'
    renderDialog(makeWorkshopStatus())
    tick(en.checksumOffer.ackNonAdmin)
    expect(confirmButton()).toBeDisabled()
    fireEvent.focus(confirmButton().parentElement!)
    expect((await screen.findAllByText(en.checksumOffer.needsServerFiles)).length).toBeGreaterThan(0)
  })
})
