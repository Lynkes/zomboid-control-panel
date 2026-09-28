import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { copyText } from '@/lib/utils'
import en from '@/locales/en/bridgeDelivery.json'
import { BridgeGuidedSteps } from '../BridgeGuidedSteps'
import { WORKSHOP_ID } from './deliveryFixtures'

const toastMock = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastMock, dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return { ...actual, copyText: vi.fn() }
})

const copy = vi.mocked(copyText)

const manual = {
  modsEntry: 'ZomboidControlPanelBridge',
  workshopItemsEntry: WORKSHOP_ID,
  removeFiles: ['media/lua/server/PanelBridge.lua', 'media/lua/client/PanelBridgeClient.lua'],
  setChecksumFalse: false,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BridgeGuidedSteps', () => {
  it('lists the five Workshop steps with the exact values to paste', () => {
    render(<BridgeGuidedSteps to="workshop" manual={manual} iniFileName="servertest.ini" />)
    const items = within(screen.getByTestId('bridge-guided-steps')).getAllByRole('listitem')
    expect(items).toHaveLength(5)
    expect(items[0]).toHaveTextContent('In servertest.ini, add ;ZomboidControlPanelBridge to the end of the Mods= line.')
    expect(items[1]).toHaveTextContent(`Add ;${WORKSHOP_ID} to the end of WorkshopItems=`)
    expect(within(items[2]).getByRole('button', { name: 'Copy media/lua/client/PanelBridgeClient.lua' })).toBeInTheDocument()
    expect(items[3]).toHaveTextContent('-nosteam')
    expect(screen.getByText(en.guided.keepChecksumOff)).toBeInTheDocument()
  })

  it('falls back to a generic file name when the ini name is unknown', () => {
    render(<BridgeGuidedSteps to="workshop" manual={manual} iniFileName={null} />)
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent(`In ${en.guided.iniFallback}, add`)
  })

  it('copies a value and confirms it on the button', async () => {
    copy.mockResolvedValue(true)
    render(<BridgeGuidedSteps to="workshop" manual={manual} iniFileName="servertest.ini" />)
    fireEvent.click(screen.getByRole('button', { name: `Copy ;${WORKSHOP_ID}` }))
    await waitFor(() => expect(copy).toHaveBeenCalledWith(`;${WORKSHOP_ID}`))
    expect(await screen.findByRole('button', { name: en.action.copied })).toBeInTheDocument()
  })

  it('says so when the browser refuses the copy', async () => {
    copy.mockResolvedValue(false)
    render(<BridgeGuidedSteps to="workshop" manual={manual} iniFileName="servertest.ini" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy ;ZomboidControlPanelBridge' }))
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: en.action.copyFailed })))
  })

  it('values render left-to-right even inside an RTL sentence', () => {
    render(<BridgeGuidedSteps to="workshop" manual={manual} iniFileName="servertest.ini" />)
    for (const code of screen.getByTestId('bridge-guided-steps').querySelectorAll('code')) {
      expect(code).toHaveAttribute('dir', 'ltr')
    }
  })
})
