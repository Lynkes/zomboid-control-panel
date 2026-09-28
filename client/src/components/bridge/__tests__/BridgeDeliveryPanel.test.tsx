import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { ApiError, panelBridgeApi, serverApi, serverFilesApi } from '@/lib/api'
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

function renderPanel(
  status: DeliveryStatus,
  props: { playerCount?: number | null; activeServerId?: string | null } = {},
) {
  getDelivery.mockResolvedValue(status)
  return renderPanelOnly(props)
}

// Same providers as the app (App.tsx): the block's restart asks through
// the app-wide ConfirmProvider.
function renderPanelOnly(props: { playerCount?: number | null; activeServerId?: string | null; iniFileName?: string | null } = {}) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <BridgeDeliveryPanel
            activeServerId={props.activeServerId === undefined ? 'srv-1' : props.activeServerId}
            iniFileName={props.iniFileName === undefined ? 'servertest.ini' : props.iniFileName}
            playerCount={props.playerCount ?? null}
          />
        </ConfirmProvider>
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

describe('BridgeDeliveryPanel: local-ok claims only what its state was decided on', () => {
  // Panel updated while the game server kept running: the file on disk is
  // 1.7.70 (so the server says local-ok), the heartbeat still says 1.7.60.
  const liveOlder = { alive: true, version: '1.7.60', delivery: 'loose' as const, workshopId: null, startedAt: 1, gameVersion: '42.20.0' }

  it('automatic: the version on disk, plus the restart that loads it', async () => {
    renderPanel(makeLocalStatus({ live: liveOlder }))
    await panelReady()
    const callout = document.querySelector('[data-state="local-ok"]') as HTMLElement
    expect(within(callout).getByText(en.state['local-ok'].title)).toBeInTheDocument()
    expect(within(callout).getByText(en.state['local-ok'].body.replace('{{version}}', '1.7.70'))).toBeInTheDocument()
    expect(
      within(callout).getByText(
        en.state['local-ok'].restartToLoad.replace('{{running}}', '1.7.60').replace('{{version}}', '1.7.70'),
      ),
    ).toBeInTheDocument()
    expect(within(callout).queryByText(/1\.7\.60\.$/)).toBeNull()
    expect(callout).not.toHaveTextContent('Up to date')
  })

  it('automatic, same version running: no restart note', async () => {
    renderPanel(makeLocalStatus())
    await panelReady()
    const callout = document.querySelector('[data-state="local-ok"]') as HTMLElement
    expect(within(callout).queryByText(/still reports/)).toBeNull()
  })

  it('says "Installed by the panel." rather than "v—" when there is no version to show', async () => {
    renderPanel(makeLocalStatus({ bundledVersion: null }))
    await panelReady()
    const callout = document.querySelector('[data-state="local-ok"]') as HTMLElement
    expect(within(callout).getByText(en.state['local-ok'].bodyNoVersion)).toBeInTheDocument()
    expect(callout).not.toHaveTextContent('v—')
  })

  it('guided: only that the bridge is reporting in, with the version it reports', async () => {
    renderPanel(makeLocalStatus({ access: 'guided', disk: null, live: liveOlder, checksum: { ...makeLocalStatus().checksum, current: null } }))
    await panelReady()
    const callout = document.querySelector('[data-state="local-ok"]') as HTMLElement
    expect(within(callout).getByText(en.state['local-ok'].titleGuided)).toBeInTheDocument()
    expect(within(callout).getByText(en.state['local-ok'].bodyGuided.replace('{{version}}', '1.7.60'))).toBeInTheDocument()
    expect(within(callout).queryByText(en.state['local-ok'].title)).toBeNull()
    expect(within(callout).queryByText(/still reports/)).toBeNull()
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

  it('noSteam on a shared game folder names the servers that share it (any of them can be the one)', async () => {
    renderPanel(
      makeLocalStatus({
        sharedWith: [{ id: 'srv-2', name: 'GOG Copy' }],
        switchAvailability: {
          toWorkshop: { available: false, reason: 'noSteam', warnings: [] },
          toLocal: { available: false, reason: 'sameMethod', warnings: [] },
        },
      }),
    )
    await panelReady()
    expect(
      within(option('workshop')).getByText(en.unavailable.noSteamShared.replace('{{servers}}', 'GOG Copy')),
    ).toBeInTheDocument()
    expect(within(option('workshop')).queryByText(en.unavailable.noSteam)).toBeNull()
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
    expect(within(offer).getByText(en.checksumOffer.body)).toBeInTheDocument()
    expect(within(offer).getByText(en.security.sentence)).toBeInTheDocument()
    // The card makes no promise the Linux caveat (ackLinux) could break.
    expect(en.checksumOffer.body).not.toMatch(/can join/i)
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

  // Server Config › INI warns about exactly this (§4.12
  // workshopUnconfirmed); the block must not show it as a green tick.
  it.each(['workshop-restart-needed', 'workshop-waiting', 'workshop-not-loaded'] as const)(
    'check on while %s is a warning, not a success',
    async (state) => {
      renderPanel(makeWorkshopStatus({ state, checksum: { current: true, canTurnOn: false, turnOnBlockers: ['notConfirmed', 'alreadyOn'], playersBlocked: false, requiresLinuxAck: false } }))
      await panelReady()
      const on = screen.getByTestId('bridge-delivery-checksum-on')
      expect(on).toHaveAttribute('data-tone', 'warning')
      expect(within(on).getByText(en.checksumOffer.isOn)).toBeInTheDocument()
      expect(within(on).getByText(en.checksumOffer.onUnconfirmedBody)).toBeInTheDocument()
      expect(within(on).getByRole('button', { name: en.checksumOffer.turnOff })).toBeEnabled()
    },
  )

  it('check on while confirmed is the quiet, expected outcome', async () => {
    renderPanel(makeWorkshopStatus({ checksum: { current: true, canTurnOn: false, turnOnBlockers: ['alreadyOn'], playersBlocked: false, requiresLinuxAck: false } }))
    await panelReady()
    const on = screen.getByTestId('bridge-delivery-checksum-on')
    expect(on).toHaveAttribute('data-tone', 'ok')
    expect(within(on).queryByText(en.checksumOffer.onUnconfirmedBody)).toBeNull()
    expect(within(on).getByRole('button', { name: en.checksumOffer.turnOff })).toBeEnabled()
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

  it('after "Switch, restart later" back to panel-installed: the note and the restart that finishes the switch', async () => {
    restart.mockResolvedValue({ success: true, message: 'ok' })
    renderPanel(
      makeLocalStatus({
        switch: { to: 'local', at: '2026-10-02T10:00:00.000Z', by: 'admin', bridgeStartedAt: 1, workshopId: null },
        restartedSinceSwitch: false,
        live: { alive: true, version: '1.7.71', delivery: 'workshop', workshopId: WORKSHOP_ID, startedAt: 1, gameVersion: '42.20.0' },
      }),
      { playerCount: 0 },
    )
    await panelReady()
    const callout = document.querySelector('[data-state="local-ok"]') as HTMLElement
    expect(within(callout).getByTestId('bridge-delivery-restart-after-switch')).toHaveTextContent(en.state.restartAfterLocalSwitch)
    fireEvent.click(within(callout).getByRole('button', { name: en.action.restartNow }))
    fireEvent.click(await screen.findByRole('button', { name: en.confirmRestart.confirm }))
    await waitFor(() => expect(restart).toHaveBeenCalledWith(0))
  })

  it('start-failed because Steam was unreachable says so and offers a start, not the switch back', async () => {
    start.mockResolvedValue({ success: true, message: 'ok' })
    const line = 'Failed to connect to Steam servers'
    renderPanel(
      makeWorkshopStatus({
        state: 'workshop-start-failed',
        serverRunning: false,
        live: null,
        lastStartFailure: { kind: 'steamUnreachable', line, result: null, logMtime: '2026-10-02T10:05:00.000Z' },
      }),
    )
    await panelReady()
    const callout = document.querySelector('[data-state="workshop-start-failed"]') as HTMLElement
    expect(within(callout).getByText(en.state['workshop-start-failed'].bodySteamUnreachable)).toBeInTheDocument()
    expect(within(callout).getByText(en.state.causes.steamUnreachable)).toBeInTheDocument()
    expect(within(callout).queryByText(en.state['workshop-start-failed'].body)).toBeNull()
    expect(within(callout).getByText(line)).toBeInTheDocument()
    expect(within(callout).queryByRole('button', { name: en.action.switchToLocalAndStart })).toBeNull()
    fireEvent.click(within(callout).getByRole('button', { name: en.action.startServer }))
    await waitFor(() => expect(start).toHaveBeenCalled())
    expect(planDelivery).not.toHaveBeenCalled()
  })

  it('warns when Steam reports the item unavailable', async () => {
    renderPanel(makeWorkshopStatus({ steamReportsUnavailable: true }))
    await panelReady()
    expect(screen.getByTestId('bridge-delivery-steam-unavailable')).toHaveTextContent(en.banner.steamUnavailable)
  })

  it('local-workshop-loaded explains the mismatch, and the manual fix while there is no switch back', async () => {
    const workshopLive = { alive: true, version: '1.7.71', delivery: 'workshop' as const, workshopId: WORKSHOP_ID, startedAt: 1, gameVersion: '42.20.0' }
    renderPanel(makeLocalStatus({ state: 'local-workshop-loaded', live: workshopLive }))
    await panelReady()
    expect(screen.getByText(en.state['local-workshop-loaded'].body)).toBeInTheDocument()
    const hint = screen.getByTestId('bridge-delivery-state-hint')
    expect(hint).toHaveTextContent('remove ZomboidControlPanelBridge from Mods= and the PanelBridge item ID from WorkshopItems=')
    expect(within(hint).getByText('ZomboidControlPanelBridge').tagName).toBe('CODE')
    cleanup()

    renderPanel(
      makeLocalStatus({
        state: 'local-workshop-loaded',
        live: workshopLive,
        switchAvailability: {
          toWorkshop: { available: true, reason: null, warnings: [] },
          toLocal: { available: true, reason: null, warnings: [] },
        },
      }),
    )
    await panelReady()
    expect(screen.queryByTestId('bridge-delivery-state-hint')).toBeNull()
  })

  it('names the leftover files as a list in the UI language', async () => {
    renderPanel(
      makeWorkshopStatus({
        disk: {
          ...makeWorkshopStatus().disk!,
          looseFiles: [
            { path: 'media/lua/server/PanelBridge.lua', kind: 'server', recognized: true },
            { path: 'media/lua/client/PanelBridgeClient.lua', kind: 'client', recognized: true },
          ],
        },
      }),
    )
    await panelReady()
    expect(screen.getByTestId('bridge-delivery-leftovers')).toHaveTextContent(
      '\u2066media/lua/server/PanelBridge.lua\u2069 and \u2066media/lua/client/PanelBridgeClient.lua\u2069',
    )
  })

  // What the server really sends: absolute paths under the game folder
  // (bridgeDisk joins them onto installDir). Named relative to the folder,
  // each in a left-to-right isolate, so an RTL sentence can't move the
  // leading "/" to the wrong end, and the banner wraps instead of
  // overflowing at phone width.
  it.each([
    ['en', '/pz-server', ['/pz-server/media/lua/server/PanelBridge.lua', '/pz-server/media/lua/client/PanelBridgeClient.lua']],
    ['ar', '/pz-server', ['/pz-server/media/lua/server/PanelBridge.lua', '/pz-server/media/lua/client/PanelBridgeClient.lua']],
    ['en', 'D:\\PZServer\\', ['d:\\pzserver\\media\\lua\\server\\PanelBridge.lua', 'D:\\PZServer\\media\\lua\\client\\PanelBridgeClient.lua']],
  ])('names absolute leftover paths relative to the game folder, isolated LTR (%s, %s)', async (language, installDir, paths) => {
    if (language !== 'en') await i18n.changeLanguage(language)
    renderPanel(
      makeWorkshopStatus({
        disk: {
          ...makeWorkshopStatus().disk!,
          installDir,
          looseFiles: paths.map((p, i) => ({ path: p, kind: i === 0 ? ('server' as const) : ('client' as const), recognized: true })),
        },
      }),
    )
    const banner = await screen.findByTestId('bridge-delivery-leftovers')
    const text = banner.textContent ?? ''
    const sep = installDir.startsWith('/') ? '/' : '\\'
    expect(text).toContain(`\u2066${['media', 'lua', 'server', 'PanelBridge.lua'].join(sep)}\u2069`)
    expect(text).toContain(`\u2066${['media', 'lua', 'client', 'PanelBridgeClient.lua'].join(sep)}\u2069`)
    expect(text).not.toContain(installDir.startsWith('/') ? '/pz-server' : 'PZServer')
    expect(banner.querySelector('.break-words')).not.toBeNull()
  })

  it('never calls the panel-installed file a leftover on a panel-installed server', async () => {
    // makeLocalStatus() lists media/lua/server/PanelBridge.lua on disk: there
    // it IS the installed bridge.
    renderPanel(makeLocalStatus())
    await panelReady()
    expect(screen.queryByTestId('bridge-delivery-leftovers')).toBeNull()
  })
})

// A restart disconnects everyone on the server, so the block's "Restart
// now" asks first, like every other restart in the panel.
describe('BridgeDeliveryPanel: "Restart now" asks first', () => {
  async function clickRestart() {
    fireEvent.click(screen.getByRole('button', { name: en.action.restartNow }))
    return screen.findByRole('alertdialog')
  }

  it('players online: confirms with the 5-minute warning, then restarts with it', async () => {
    restart.mockResolvedValue({})
    renderPanel(makeWorkshopStatus({ state: 'workshop-restart-needed' }), { playerCount: 3 })
    await panelReady()
    expect(screen.getByText(en.action.restartWarningNote)).toBeInTheDocument()
    const dialog = await clickRestart()
    expect(within(dialog).getByText(en.confirmRestart.title.replace('{{server}}', 'Main Server'))).toBeInTheDocument()
    expect(within(dialog).getByText(en.confirmRestart.playersOnline)).toBeInTheDocument()
    expect(restart).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: en.confirmRestart.confirm }))
    await waitFor(() => expect(restart).toHaveBeenCalledWith(5))
  })

  // workshop-not-loaded after the grace period: the bridge isn't reporting,
  // so nothing says the server is empty.
  it('player count unknown: still the 5-minute warning, never an instant kick', async () => {
    restart.mockResolvedValue({})
    renderPanel(
      makeWorkshopStatus({ state: 'workshop-not-loaded', live: { ...makeWorkshopStatus().live!, alive: false } }),
      { playerCount: null },
    )
    await panelReady()
    expect(screen.getByText(en.action.restartWarningNote)).toBeInTheDocument()
    const dialog = await clickRestart()
    expect(within(dialog).getByText(en.confirmRestart.playersUnknown)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: en.confirmRestart.confirm }))
    await waitFor(() => expect(restart).toHaveBeenCalledWith(5))
    expect(restart).not.toHaveBeenCalledWith(0)
  })

  it('nobody online: says so and restarts right away', async () => {
    restart.mockResolvedValue({})
    renderPanel(makeWorkshopStatus({ state: 'workshop-restart-needed' }), { playerCount: 0 })
    await panelReady()
    expect(screen.queryByText(en.action.restartWarningNote)).toBeNull()
    const dialog = await clickRestart()
    expect(within(dialog).getByText(en.confirmRestart.nobodyOnline)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: en.confirmRestart.confirm }))
    await waitFor(() => expect(restart).toHaveBeenCalledWith(0))
  })

  it('cancel restarts nothing', async () => {
    renderPanel(makeWorkshopStatus({ state: 'workshop-restart-needed' }), { playerCount: 3 })
    await panelReady()
    const dialog = await clickRestart()
    fireEvent.click(within(dialog).getByRole('button', { name: en.dialog.cancel }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(restart).not.toHaveBeenCalled()
  })
})

describe('BridgeDeliveryPanel: start, install, and loading the status', () => {
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
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: en.toast.installed, variant: 'success' })))
  })

  it('an install the server answers with success:false is reported as a failure, not "up to date"', async () => {
    installModAuto.mockResolvedValue({ success: false, message: '', error: 'Disk full', path: 'x', serverName: 'Main Server' })
    renderPanel(makeLocalStatus({ state: 'local-not-installed' }))
    await panelReady()
    fireEvent.click(screen.getByRole('button', { name: en.action.installNow }))
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: en.toast.installFailed, description: 'Disk full', variant: 'destructive' }),
      ),
    )
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ title: en.toast.installed }))
  })

  it('an install the server is still finishing (504 STILL_RUNNING) is an info toast, not a failure', async () => {
    installModAuto.mockRejectedValue(
      new ApiError('Installing PanelBridge is taking longer than usual and continues in the background.', {
        status: 504,
        code: 'PANELBRIDGE_INSTALL_STILL_RUNNING',
      }),
    )
    renderPanel(makeLocalStatus({ state: 'local-not-installed' }))
    await panelReady()
    fireEvent.click(screen.getByRole('button', { name: en.action.installNow }))
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: en.toast.installStillRunning })),
    )
    const call = toastMock.mock.calls.find(([arg]) => arg?.title === en.toast.installStillRunning)?.[0]
    expect(call?.variant).toBeUndefined()
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ title: en.toast.installFailed }))
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
    renderPanelOnly({ iniFileName: null })
    expect(await screen.findByText(en.loadFailed)).toBeInTheDocument()
    getDelivery.mockResolvedValue(makeLocalStatus())
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await panelReady()
  })

  // lib/demo.ts's catch-all answer. It used to reach the renderer as a
  // "status" and throw, taking all of Settings down with it.
  it('a 200 that is not a delivery status shows the load error, not a crash', async () => {
    getDelivery.mockResolvedValueOnce({ success: true, demo: true } as unknown as DeliveryStatus)
    renderPanelOnly()
    expect(await screen.findByText(en.loadFailed)).toBeInTheDocument()
    expect(screen.getByText(en.unexpectedResponse)).toBeInTheDocument()
    expect(document.querySelector('[data-state]')).toBeNull()
    getDelivery.mockResolvedValue(makeLocalStatus())
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await panelReady()
  })

  it('keeps the last status when a refresh fails, and says it may be out of date', async () => {
    saveIni.mockResolvedValue({ success: true, message: 'ok', path: 'x', settings: {} })
    renderPanel(
      makeLocalStatus({ checksum: { current: true, canTurnOn: false, turnOnBlockers: ['notWorkshop', 'alreadyOn'], playersBlocked: true, requiresLinuxAck: false } }),
    )
    await panelReady()
    expect(screen.queryByTestId('bridge-delivery-refresh-failed')).toBeNull()
    // Every mutation refetches; this one fails.
    getDelivery.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: en.playersBlocked.turnOff }))
    const notice = await screen.findByTestId('bridge-delivery-refresh-failed')
    expect(notice).toHaveTextContent(en.refreshFailed)
    // The last answer is still on screen, not replaced by the load error.
    expect(screen.getByTestId('bridge-delivery-players-blocked')).toBeInTheDocument()
    expect(screen.queryByText(en.loadFailed)).toBeNull()
    getDelivery.mockResolvedValue(makeLocalStatus())
    fireEvent.click(within(notice).getByRole('button', { name: en.retry }))
    await waitFor(() => expect(screen.queryByTestId('bridge-delivery-refresh-failed')).toBeNull())
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

  it("doesn't name an .ini from the page's server list when that list disagrees with the status", async () => {
    const guided = makeWorkshopStatus({ access: 'guided', disk: null, serverRunning: null, state: 'workshop-restart-needed', checksum: { current: null, canTurnOn: false, turnOnBlockers: ['notConfirmed'], playersBlocked: false, requiresLinuxAck: false } })
    // The page still thinks srv-2 is active; the server answered for srv-1.
    renderPanel(guided, { activeServerId: 'srv-2' })
    await panelReady()
    const first = within(screen.getByTestId('bridge-guided-steps')).getAllByRole('listitem')[0]
    expect(first).toHaveTextContent(`In ${en.guided.iniFallback}, add`)
    expect(first).not.toHaveTextContent('servertest.ini')
    cleanup()

    renderPanel(guided, { activeServerId: 'srv-1' })
    await panelReady()
    expect(within(screen.getByTestId('bridge-guided-steps')).getAllByRole('listitem')[0]).toHaveTextContent('In servertest.ini, add')
  })

  // The panel can't read a guided server's ini, so the offer stays up after
  // the operator turned the check on by hand and "Turn it off again" never
  // appears: the card says how to turn it off and links Server Config › INI.
  it('the guided offer says how to turn the check off again, with the Server Config link', async () => {
    renderPanel(makeWorkshopStatus({ access: 'guided', disk: null, checksum: { current: null, canTurnOn: true, turnOnBlockers: [], playersBlocked: false, requiresLinuxAck: true } }))
    await panelReady()
    const hint = within(screen.getByTestId('bridge-delivery-checksum-offer')).getByTestId('bridge-delivery-checksum-guided-off')
    expect(hint).toHaveTextContent(en.checksumOffer.guidedTurnOffHint)
    expect(within(hint).getByRole('link', { name: en.checksumOffer.openServerConfig })).toHaveAttribute(
      'href',
      '/server-config?tab=ini&search=DoLuaChecksum',
    )
    expect(screen.queryByRole('button', { name: en.checksumOffer.turnOff })).toBeNull()
    cleanup()

    renderPanel(makeWorkshopStatus())
    await panelReady()
    expect(screen.queryByTestId('bridge-delivery-checksum-guided-off')).toBeNull()
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

  // A bare "Mods=" before Arabic text shows as "=Mods": the "=" sits between
  // a Latin run and an RTL one and resolves right-to-left. Outside <code
  // dir="ltr"> the Arabic copy puts a LEFT-TO-RIGHT MARK after the "=".
  it('keeps every bare Mods= / WorkshopItems= in the Arabic copy left-to-right', () => {
    const strings: string[] = []
    const walk = (node: unknown) => {
      if (typeof node === 'string') strings.push(node)
      else if (node && typeof node === 'object') Object.values(node).forEach(walk)
    }
    walk(ar)
    const offenders = strings
      .map((s) => s.replace(/<code>.*?<\/code>/g, ''))
      .filter((s) => /(Mods|WorkshopItems)=(?!\u200e)[\s\u0600-\u06FF]/.test(s))
    expect(offenders).toEqual([])
    expect(ar.unavailable.iniDuplicateKeys).toContain('Mods=\u200e')
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
