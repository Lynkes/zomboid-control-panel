import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import Events from '../Events'
import { playersApi, panelBridgeApi } from '@/lib/api'

// 2026-08-30, panelbridge-total-audit-2026-08-30 (Finding C): Events.tsx used
// to branch on `result?.persisted === false` / `result.persistReason` to show
// a "won't survive a restart" warning toast. Neither restoreUtilities nor
// shutOffUtilities has ever set either field (only an unstructured debug
// string array), so `notPersisted` was permanently false and this warning
// path could never fire in production -- it silently promised a check that
// wasn't happening. This test proves the dead branch is gone: even if a
// response somehow carries `persisted: false` (a malformed/future payload),
// the client no longer special-cases it and falls through to the ordinary
// success toast, matching what every real response has always produced.

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    playersApi: { ...actual.playersApi, getPlayers: vi.fn() },
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getStatus: vi.fn(),
      getClimateFloats: vi.fn(),
      getGameTime: vi.fn(),
      getUtilitiesStatus: vi.fn(),
      restoreUtilities: vi.fn(),
      shutOffUtilities: vi.fn(),
      sendCommand: vi.fn(),
    },
  }
})

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver

const getPlayers = vi.mocked(playersApi.getPlayers)
const getStatus = vi.mocked(panelBridgeApi.getStatus)
const getClimateFloats = vi.mocked(panelBridgeApi.getClimateFloats)
const getGameTime = vi.mocked(panelBridgeApi.getGameTime)
const getUtilitiesStatus = vi.mocked(panelBridgeApi.getUtilitiesStatus)
const shutOffUtilities = vi.mocked(panelBridgeApi.shutOffUtilities)
const sendCommand = vi.mocked(panelBridgeApi.sendCommand)

function renderEvents() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <Events />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function openUtilitiesSection() {
  const nav = await screen.findByText('Power and water')
  nav.click()
  await screen.findByText('power & water grid')
}

beforeEach(() => {
  getPlayers.mockReset().mockResolvedValue({ players: [] } as never)
  getStatus.mockReset().mockResolvedValue({ modConnected: true } as never)
  getGameTime.mockReset().mockResolvedValue({ success: false } as never)
  getClimateFloats.mockReset().mockResolvedValue({ success: false } as never)
  shutOffUtilities.mockReset()
  sendCommand.mockReset().mockResolvedValue({ success: false } as never)
  toastSpy.mockReset()
  // 2026-08-31 (paired-buttons operator request): the Power/Water controls
  // are now a single Switch reflecting utilitiesStatus.powerOn/waterOn, and
  // the switch disables itself while that state is unknown -- so this test
  // (which only cares about the toast on the ACTION's own response) needs a
  // real, resolved status here to make the switch interactable at all. This
  // was `success: false` before the toggle conversion, when the click target
  // was a plain always-enabled Button.
  getUtilitiesStatus.mockReset().mockResolvedValue({
    success: true,
    data: {
      hydroPowerOn: true,
      powerOn: true,
      waterOn: true,
      elecShut: '1',
      waterShut: '9',
      elecShutModifier: 15,
      waterShutModifier: 2147483647,
      currentWorldDay: 3.7,
      nightsSurvived: 2,
    },
  } as never)
})

describe('Events -- the dead persisted/persistReason branch no longer influences the utilities toast (Finding C)', () => {
  it('shows the ordinary success toast even when the response carries persisted: false', async () => {
    shutOffUtilities.mockResolvedValue({
      success: true,
      message: 'Utilities shut off',
      power: true,
      water: false,
      hydroPowerOn: false, // matches the requested state -- no power mismatch
      persisted: false,
      persistReason: 'SandboxVars write did not stick',
      debug: ['FINAL isHydroPowerOn=false'],
    } as never)

    renderEvents()
    await openUtilitiesSection()

    // Power/Water are a single state-reflecting Switch each, not a
    // Restore/Shut Off button pair (2026-08-31, paired-buttons operator
    // request); powerOn is mocked true above, so the switch starts checked
    // and clicking it fires a shut-off.
    const switches = await screen.findAllByRole('switch', { name: /power|water/i })
    switches[0].click()

    await waitFor(() => expect(shutOffUtilities).toHaveBeenCalledWith(true, false))
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalled()
      const call = toastSpy.mock.calls.at(-1)
      expect(call?.[0].variant).toBe('success')
      expect(call?.[0].description).not.toMatch(/SandboxVars write did not stick/)
    })
  })
})
