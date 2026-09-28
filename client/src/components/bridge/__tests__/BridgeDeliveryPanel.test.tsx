import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { panelBridgeApi, serverApi, serverFilesApi } from '@/lib/api'
import { DELIVERY_STATES, type DeliveryStatus } from '@/lib/bridgeDeliveryTypes'
import en from '@/locales/en/bridgeDelivery.json'
import enSettings from '@/locales/en/settings.json'
import ar from '@/locales/ar/bridgeDelivery.json'
import { BridgeDeliveryPanel } from '../BridgeDeliveryPanel'
import { makeLocalStatus, makePlan, makeWorkshopStatus, WORKSHOP_ID } from './deliveryFixtures'

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
    panelBridgeApi: {
      ...actual.panelBridgeApi,
      getDelivery: vi.fn(),
      planDelivery: vi.fn(),
      applyDelivery: vi.fn(),
      installModAuto: vi.fn(),
    },
    serverApi: { ...actual.serverApi, start: vi.fn(), restart: vi.fn() },
    serverFilesApi: { ...actual.serverFilesApi, saveIni: vi.fn() },
  }
})

const getDelivery = vi.mocked(panelBridgeApi.getDelivery)
const planDelivery = vi.mocked(panelBridgeApi.planDelivery)
const installModAuto = vi.mocked(panelBridgeApi.installModAuto)
const restart = vi.mocked(serverApi.restart)
const start = vi.mocked(serverApi.start)
const saveIni = vi.mocked(serverFilesApi.saveIni)

function renderPanel(status: DeliveryStatus, props: { playerCount?: number | null } = {}) {
  getDelivery.mockResolvedValue(status)
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <BridgeDeliveryPanel activeServerId="srv-1" iniFileName="servertest.ini" playerCount={props.playerCount ?? null} />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

async function panelReady() {
  return screen.findByText(en.appliesTo.replace('{{server}}', 'Main Server'))
}

function option(method: 'local' | 'workshop') {
  return screen.getByTestId(`bridge-delivery-option-${method}`)
}

// DisabledReason's tooltip trigger is the focusable span around the
// disabled button (see DisabledReason.tsx).
async function expectDisabledReason(button: HTMLElement, reason: string) {
  expect(button).toBeDisabled()
  fireEvent.focus(button.parentElement!)
  expect((await screen.findAllByText(reason)).length).toBeGreaterThan(0)
}

beforeEach(() => {
  mockCan = () => true
})

afterEach(async () => {
  cleanup()
  vi.clearAllMocks()
  if (i18n.language !== 'en') await i18n.changeLanguage('en')
})

describe('BridgeDeliveryPanel: every DeliveryState renders its own copy', () => {
  it.each(DELIVERY_STATES)('%s', async (state) => {
    const base = state.startsWith('local') ? makeLocalStatus() : makeWorkshopStatus()
    renderPanel({ ...base, state })
    await panelReady()
    const callout = document.querySelector(`[data-state="${state}"]`) as HTMLElement
    expect(callout, `no callout for ${state}`).not.toBeNull()
    const copy = en.state[state as keyof typeof en.state] as { title: string; body: string }
    const version = base.live?.version ?? ''
    expect(within(callout).getByText(copy.title.replace('{{version}}', version))).toBeInTheDocument()
    expect(within(callout).getByText(copy.body.replace('{{version}}', version))).toBeInTheDocument()
  })
})

describe('BridgeDeliveryPanel: option cards and Workshop availability', () => {
  it('marks the current method and puts the switch on the other card', async () => {
    renderPanel(makeLocalStatus())
    await panelReady()
    expect(within(option('local')).getByText(en.current)).toBeInTheDocument()
    expect(within(option('local')).queryByRole('button', { name: en.action.switchToLocal })).toBeNull()
    expect(within(option('workshop')).getByRole('button', { name: en.action.switchToWorkshop })).toBeEnabled()
  })

  it('not published: the Workshop switch is disabled and says why', async () => {
    renderPanel(
      makeLocalStatus({
        release: { ...makeLocalStatus().release, status: 'not-published', workshopId: null, preview: true },
        effectiveWorkshopId: null,
        switchAvailability: {
          toWorkshop: { available: false, reason: 'notPublished', warnings: [] },
          toLocal: { available: false, reason: 'sameMethod', warnings: [] },
        },
      }),
    )
    await panelReady()
    const card = option('workshop')
    expect(within(card).getByText(en.unavailable.notPublished)).toBeInTheDocument()
    await expectDisabledReason(within(card).getByRole('button', { name: en.action.switchToWorkshop }), en.unavailable.notPublished)
  })

  it('noSteam blocks the switch with its own reason', async () => {
    renderPanel(
      makeLocalStatus({
        switchAvailability: {
          toWorkshop: { available: false, reason: 'noSteam', warnings: [] },
          toLocal: { available: false, reason: 'sameMethod', warnings: [] },
        },
      }),
    )
    await panelReady()
    expect(within(option('workshop')).getByText(en.unavailable.noSteam)).toBeInTheDocument()
    expect(within(option('workshop')).getByRole('button', { name: en.action.switchToWorkshop })).toBeDisabled()
  })

  it('gameVersionUnsupported names the version the server reports', async () => {
    renderPanel(
      makeLocalStatus({
        live: { alive: true, version: '1.7.70', delivery: 'loose', workshopId: null, startedAt: 1, gameVersion: '41.78.16' },
        switchAvailability: {
          toWorkshop: { available: false, reason: 'gameVersionUnsupported', warnings: [] },
          toLocal: { available: false, reason: 'sameMethod', warnings: [] },
        },
      }),
    )
    await panelReady()
    expect(
      within(option('workshop')).getByText(en.unavailable.gameVersionUnsupported.replace('{{version}}', '41.78.16')),
    ).toBeInTheDocument()
  })

  it('shows Preview while the maintainer has not live-verified the item, Recommended after', async () => {
    renderPanel(makeLocalStatus({ release: { ...makeLocalStatus().release, preview: true } }))
    await panelReady()
    expect(within(option('workshop')).getByText(en.preview)).toBeInTheDocument()
    expect(within(option('workshop')).queryByText(en.recommended)).toBeNull()
    cleanup()

    renderPanel(makeLocalStatus())
    await panelReady()
    expect(within(option('workshop')).getByText(en.recommended)).toBeInTheDocument()
  })

  it('flags the PANEL_BRIDGE_WORKSHOP_ID test override', async () => {
    renderPanel(makeLocalStatus({ release: { ...makeLocalStatus().release, source: 'env', preview: true } }))
    await panelReady()
    expect(within(option('workshop')).getByText(en.testOverride)).toBeInTheDocument()
  })

  it('opens the preview dialog (a dry-run plan) from the Workshop card', async () => {
    planDelivery.mockResolvedValue(makePlan())
    renderPanel(makeLocalStatus())
    await panelReady()
    fireEvent.click(within(option('workshop')).getByRole('button', { name: en.action.switchToWorkshop }))
    await screen.findByRole('dialog')
    expect(planDelivery).toHaveBeenCalledWith({ serverId: 'srv-1', method: 'workshop' })
  })
})

describe('BridgeDeliveryPanel: the Lua integrity check', () => {
  it('shows the #168 warning in Local mode while the check is off', async () => {
    renderPanel(makeLocalStatus())
    await panelReady()
    const warning = screen.getByTestId('bridge-delivery-checksum-off')
    expect(within(warning).getByText(en.checksumOff.title)).toBeInTheDocument()
    expect(within(warning).getByText(en.checksumOff.body)).toBeInTheDocument()
    expect(within(warning).getByRole('button', { name: en.action.switchToWorkshop })).toBeEnabled()
  })

  it('shows the #168 warning for a guided Local server too (checksum unknown)', async () => {
    renderPanel(makeLocalStatus({ access: 'guided', disk: null, state: 'local-unverified', checksum: { ...makeLocalStatus().checksum, current: null } }))
    await panelReady()
    expect(screen.getByTestId('bridge-delivery-checksum-off')).toBeInTheDocument()
  })

  it('replaces the #168 warning with the "players can\'t join" callout when the check is on in Local mode', async () => {
    saveIni.mockResolvedValue({ success: true, message: 'ok', path: 'x', settings: {} })
    renderPanel(
      makeLocalStatus({ checksum: { current: true, canTurnOn: false, turnOnBlockers: ['notWorkshop', 'alreadyOn'], playersBlocked: true, requiresLinuxAck: false } }),
    )
    await panelReady()
    expect(screen.queryByTestId('bridge-delivery-checksum-off')).toBeNull()
    const blocked = screen.getByTestId('bridge-delivery-players-blocked')
    expect(within(blocked).getByText(en.playersBlocked.title)).toBeInTheDocument()
    fireEvent.click(within(blocked).getByRole('button', { name: en.playersBlocked.turnOff }))
    await waitFor(() => expect(saveIni).toHaveBeenCalledWith({ DoLuaChecksum: 'false' }))
  })

  it('confirmed Workshop delivery offers to turn the check back on, with the §4.3 wording', async () => {
    renderPanel(makeWorkshopStatus())
    await panelReady()
    const offer = screen.getByTestId('bridge-delivery-checksum-offer')
    expect(within(offer).getByText(en.checksumOffer.title)).toBeInTheDocument()
    expect(within(offer).getByText(en.security.sentence)).toBeInTheDocument()
    fireEvent.click(within(offer).getByRole('button', { name: en.checksumOffer.turnOn }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: en.checksumOffer.ackNonAdmin })).toBeInTheDocument()
  })

  it('blocks the offer while old loose files are still in the game folder', async () => {
    renderPanel(
      makeWorkshopStatus({
        disk: { ...makeWorkshopStatus().disk!, looseFiles: [{ path: 'media/lua/server/PanelBridge.lua', kind: 'server', recognized: true }] },
        checksum: { current: false, canTurnOn: false, turnOnBlockers: ['looseFilesPresent'], playersBlocked: false, requiresLinuxAck: false },
      }),
    )
    await panelReady()
    expect(screen.getByTestId('bridge-delivery-leftovers')).toHaveTextContent('media/lua/server/PanelBridge.lua')
    const offer = screen.getByTestId('bridge-delivery-checksum-offer')
    await expectDisabledReason(
      within(offer).getByRole('button', { name: en.checksumOffer.turnOn }),
      en.checksumOffer.blockers.looseFilesPresent,
    )
  })

  it('keeps "Turn it off again" reachable while the check is on with Workshop delivery', async () => {
    saveIni.mockResolvedValue({ success: true, message: 'ok', path: 'x', settings: {} })
    renderPanel(makeWorkshopStatus({ state: 'workshop-not-loaded', checksum: { current: true, canTurnOn: false, turnOnBlockers: ['notConfirmed', 'alreadyOn'], playersBlocked: false, requiresLinuxAck: false } }))
    await panelReady()
    const on = screen.getByTestId('bridge-delivery-checksum-on')
    fireEvent.click(within(on).getByRole('button', { name: en.checksumOffer.turnOff }))
    await waitFor(() => expect(saveIni).toHaveBeenCalledWith({ DoLuaChecksum: 'false' }))
  })
})

describe('BridgeDeliveryPanel: failure states and their actions', () => {
  it('start-failed shows the log evidence and the rollback CTA, which opens the switch-back preview', async () => {
    planDelivery.mockResolvedValue(makePlan({ from: 'workshop', to: 'local', steps: [{ kind: 'recordMethod', method: 'local', servers: ['Main Server'] }] }))
    const line = `Workshop: onItemNotDownloaded itemID=${WORKSHOP_ID} result=9`
    renderPanel(
      makeWorkshopStatus({
        state: 'workshop-start-failed',
        serverRunning: false,
        live: null,
        lastStartFailure: { kind: 'itemDownload', line, result: 9, logMtime: '2026-10-02T10:05:00.000Z' },
      }),
    )
    await panelReady()
    const callout = document.querySelector('[data-state="workshop-start-failed"]') as HTMLElement
    expect(within(callout).getByText(line)).toBeInTheDocument()
    expect(within(callout).getByText(en.state.causes.startFailed)).toBeInTheDocument()
    fireEvent.click(within(callout).getByRole('button', { name: en.action.switchToLocalAndStart }))
    await screen.findByRole('dialog')
    expect(planDelivery).toHaveBeenCalledWith({ serverId: 'srv-1', method: 'local' })
    // The server is stopped, so the dialog's primary is "switch and start".
    expect(await screen.findByRole('button', { name: en.dialog.applyStart })).toBeInTheDocument()
  })

  it('warns when Steam reports the item unavailable', async () => {
    renderPanel(makeWorkshopStatus({ steamReportsUnavailable: true }))
    await panelReady()
    expect(screen.getByTestId('bridge-delivery-steam-unavailable')).toHaveTextContent(en.banner.steamUnavailable)
  })

  it('local-workshop-loaded explains the mismatch', async () => {
    renderPanel(makeLocalStatus({ state: 'local-workshop-loaded', live: { alive: true, version: '1.7.71', delivery: 'workshop', workshopId: WORKSHOP_ID, startedAt: 1, gameVersion: '42.20.0' } }))
    await panelReady()
    expect(screen.getByText(en.state['local-workshop-loaded'].body)).toBeInTheDocument()
  })

  it('restart-needed restarts with a 5-minute warning when players are online', async () => {
    restart.mockResolvedValue({})
    renderPanel(makeWorkshopStatus({ state: 'workshop-restart-needed' }), { playerCount: 3 })
    await panelReady()
    expect(screen.getByText(en.action.restartWarningNote)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: en.action.restartNow }))
    await waitFor(() => expect(restart).toHaveBeenCalledWith(5))
  })

  it('workshop-stopped offers Start server', async () => {
    start.mockResolvedValue({})
    renderPanel(makeWorkshopStatus({ state: 'workshop-stopped', serverRunning: false, live: null }))
    await panelReady()
    fireEvent.click(screen.getByRole('button', { name: en.action.startServer }))
    await waitFor(() => expect(start).toHaveBeenCalled())
  })

  it('local-update-pending runs the existing install endpoint for this server', async () => {
    installModAuto.mockResolvedValue({ success: true, message: 'updated', path: 'x', serverName: 'Main Server' })
    renderPanel(makeLocalStatus({ state: 'local-update-pending' }))
    await panelReady()
    fireEvent.click(screen.getByRole('button', { name: en.action.updateNow }))
    await waitFor(() => expect(installModAuto).toHaveBeenCalledWith('srv-1'))
  })

  it('shows the standing update note in Workshop mode, by auto-restart setting', async () => {
    renderPanel(makeWorkshopStatus({ modAutoRestart: false }))
    await panelReady()
    expect(screen.getByText(en.banner.autoRestartOff)).toBeInTheDocument()
    cleanup()
    renderPanel(makeWorkshopStatus({ modAutoRestart: true }))
    await panelReady()
    expect(screen.getByText(en.banner.autoRestartOn)).toBeInTheDocument()
  })

  it('offers a retry when the status cannot be loaded', async () => {
    getDelivery.mockRejectedValueOnce(new Error('boom'))
    render(
      <MemoryRouter>
        <TooltipProvider>
          <BridgeDeliveryPanel activeServerId="srv-1" iniFileName={null} playerCount={null} />
        </TooltipProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText(en.loadFailed)).toBeInTheDocument()
    getDelivery.mockResolvedValue(makeLocalStatus())
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await panelReady()
  })
})

describe('BridgeDeliveryPanel: guided access (remote / hosted)', () => {
  it('shows the manual Workshop steps with copyable values until the heartbeat confirms', async () => {
    renderPanel(makeWorkshopStatus({ access: 'guided', disk: null, serverRunning: null, state: 'workshop-restart-needed', checksum: { current: null, canTurnOn: false, turnOnBlockers: ['notConfirmed'], playersBlocked: false, requiresLinuxAck: false } }))
    await panelReady()
    const steps = screen.getByTestId('bridge-guided-steps')
    expect(within(steps).getByText(en.guided.intro)).toBeInTheDocument()
    expect(within(steps).getByRole('button', { name: `Copy ;ZomboidControlPanelBridge` })).toBeInTheDocument()
    expect(within(steps).getByRole('button', { name: `Copy ;${WORKSHOP_ID}` })).toBeInTheDocument()
    expect(within(steps).getByRole('button', { name: 'Copy media/lua/server/PanelBridge.lua' })).toBeInTheDocument()
    expect(within(steps).getByText(en.guided.keepChecksumOff)).toBeInTheDocument()
    // Unknown lifecycle on a remote host: no start/restart buttons.
    expect(screen.queryByRole('button', { name: en.action.restartNow })).toBeNull()
  })

  it('hides the manual steps once confirmed, and the offer needs no serverfiles.manage for instructions', async () => {
    mockCan = (capability) => capability !== 'serverfiles.manage'
    renderPanel(makeWorkshopStatus({ access: 'guided', disk: null, checksum: { current: null, canTurnOn: true, turnOnBlockers: [], playersBlocked: false, requiresLinuxAck: false } }))
    await panelReady()
    expect(screen.queryByTestId('bridge-guided-steps')).toBeNull()
    expect(screen.getByRole('button', { name: en.checksumOffer.turnOn })).toBeEnabled()
  })
})

describe('BridgeDeliveryPanel: permissions', () => {
  it('every switch/install button explains a missing bridge.setup', async () => {
    mockCan = (capability) => capability !== 'bridge.setup'
    renderPanel(makeLocalStatus({ state: 'local-update-pending' }))
    await panelReady()
    await expectDisabledReason(screen.getByRole('button', { name: en.action.updateNow }), enSettings.permissions.noBridgeSetup)
    for (const button of screen.getAllByRole('button', { name: en.action.switchToWorkshop })) expect(button).toBeDisabled()
    fireEvent.click(screen.getAllByRole('button', { name: en.action.switchToWorkshop })[0])
    expect(planDelivery).not.toHaveBeenCalled()
  })

  it('the checksum buttons explain a missing serverfiles.manage', async () => {
    mockCan = (capability) => capability !== 'serverfiles.manage'
    renderPanel(makeWorkshopStatus())
    await panelReady()
    await expectDisabledReason(screen.getByRole('button', { name: en.checksumOffer.turnOn }), en.checksumOffer.needsServerFiles)
  })

  it('start/restart explain a missing server.control', async () => {
    mockCan = (capability) => capability !== 'server.control'
    renderPanel(makeWorkshopStatus({ state: 'workshop-restart-needed' }))
    await panelReady()
    await expectDisabledReason(screen.getByRole('button', { name: en.action.restartNow }), en.needsServerControl)
  })

  it('renders nothing and fetches nothing for a role that can read none of it', async () => {
    mockCan = () => false
    const { container } = renderPanel(makeLocalStatus())
    await new Promise((r) => setTimeout(r, 0))
    expect(container.querySelector('[data-testid="bridge-delivery-panel"]')).toBeNull()
    expect(getDelivery).not.toHaveBeenCalled()
  })
})

describe('BridgeDeliveryPanel: RTL (ar)', () => {
  it('renders in Arabic with the document in RTL', async () => {
    await i18n.changeLanguage('ar')
    expect(document.documentElement.dir).toBe('rtl')
    renderPanel(makeLocalStatus())
    expect(await screen.findByText(ar.sectionTitle)).toBeInTheDocument()
    expect(screen.getByText(ar.local.title)).toBeInTheDocument()
  })

  // Physical left/right utilities flip wrong under dir="rtl"; every new
  // component here uses logical ones (ms-/me-/ps-/pe-/start-/end-/
  // text-start). A source scan covers every branch, rendered or not.
  it('uses no physical left/right spacing or alignment classes', () => {
    const dir = path.resolve(process.cwd(), 'src/components')
    const files = [
      'bridge/BridgeDeliveryPanel.tsx',
      'bridge/BridgeDeliverySwitchDialog.tsx',
      'bridge/BridgeChecksumDialog.tsx',
      'bridge/BridgeGuidedSteps.tsx',
      'mods/BridgeManagedBadge.tsx',
    ]
    const PHYSICAL =
      /^-?(?:(?:ml|mr|pl|pr|left|right|space-x|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br)-[\w./[\]%]+|border-l|border-r|rounded-l|rounded-r|text-left|text-right)$/
    const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g
    const offenders: string[] = []
    for (const file of files) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8')
      for (const [, , literal] of source.matchAll(STRING_LITERAL)) {
        for (const token of literal.split(/\s+/)) {
          // Drop variant prefixes (sm:, hover:, [&>svg]:) to test the utility itself.
          const utility = token.slice(token.lastIndexOf(':') + 1)
          if (PHYSICAL.test(utility)) offenders.push(`${file}: ${token}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
