import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import {
  BRIDGE_MOD_ID,
  CHECKSUM_BLOCKERS,
  DELIVERY_BLOCK_REASONS,
  DELIVERY_STATES,
  DELIVERY_WARNINGS,
  type DeliveryStep,
} from '../bridgeDeliveryTypes'
import {
  DELIVERY_ACTION_KEYS,
  DELIVERY_STATE_VIEWS,
  describeDeliveryStep,
  formatList,
  getAvailabilityParams,
  getBlockReasonKey,
  getChecksumBlockerKey,
  getGuidedWorkshopManual,
  getRestartWarning,
  getRunningVersionNote,
  getStateHintKey,
  getStateVersion,
  getWarningKey,
  isBridgeManagedMod,
  isDeliveryPlanResponse,
  isDeliveryStatus,
  needsRestartAfterLocalSwitch,
  resolveLuaChecksumCallout,
  resolveStateActions,
  resolveStateCopy,
  resolveStateView,
} from '../bridgeDeliveryView'
import { makeLocalStatus, makePlan, makeWorkshopStatus, WORKSHOP_ID } from '@/components/bridge/__tests__/deliveryFixtures'

// The client maps server-computed delivery state to copy and actions and
// decides nothing else (spec §4.5, §6.9). These tests pin that mapping to
// the contract file: every value in every contract array must resolve to a
// real `bridgeDelivery:` key, so a new state/reason/warning added to
// bridgeDeliveryTypes.ts fails here instead of rendering a raw key.

const exists = (key: string) => i18n.exists(key, { ns: 'bridgeDelivery', lng: 'en' })

describe('bridgeDeliveryView: every contract value maps to an existing bridgeDelivery key', () => {
  it.each(DELIVERY_STATES)('state %s has a title, a body and an action set', (state) => {
    const view = DELIVERY_STATE_VIEWS[state]
    expect(view, `no view for ${state}`).toBeDefined()
    expect(exists(view.titleKey), view.titleKey).toBe(true)
    expect(exists(view.bodyKey), view.bodyKey).toBe(true)
    if (view.causesKey) expect(exists(view.causesKey), view.causesKey).toBe(true)
    expect(Array.isArray(view.actions)).toBe(true)
    for (const action of view.actions) expect(exists(DELIVERY_ACTION_KEYS[action]), action).toBe(true)
  })

  it('has no view for a state the contract does not define', () => {
    expect(Object.keys(DELIVERY_STATE_VIEWS).sort()).toEqual([...DELIVERY_STATES].sort())
  })

  it.each(DELIVERY_BLOCK_REASONS)('block reason %s', (reason) => {
    expect(exists(getBlockReasonKey(reason))).toBe(true)
  })

  it.each(DELIVERY_WARNINGS)('warning %s', (warning) => {
    expect(exists(getWarningKey(warning))).toBe(true)
  })

  it.each(DELIVERY_BLOCK_REASONS)('block reason %s on a shared game folder', (reason) => {
    expect(exists(getBlockReasonKey(reason, true))).toBe(true)
  })

  it.each(DELIVERY_WARNINGS)('warning %s on a shared game folder', (warning) => {
    expect(exists(getWarningKey(warning, true))).toBe(true)
  })

  it('only noSteam and customLauncher change wording on a shared game folder', () => {
    expect(getBlockReasonKey('noSteam', true)).toBe('unavailable.noSteamShared')
    expect(getWarningKey('customLauncher', true)).toBe('warn.customLauncherShared')
    expect(getBlockReasonKey('noSteam', false)).toBe('unavailable.noSteam')
    expect(getBlockReasonKey('iniNotFound', true)).toBe('unavailable.iniNotFound')
    expect(getWarningKey('serverRunning', true)).toBe('warn.serverRunning')
  })

  it.each(CHECKSUM_BLOCKERS)('checksum blocker %s', (blocker) => {
    expect(exists(getChecksumBlockerKey(blocker))).toBe(true)
  })

  it('every step kind maps to an existing key, with the values the step carries', () => {
    const steps: DeliveryStep[] = [
      { kind: 'iniAdd', key: 'Mods', value: BRIDGE_MOD_ID, file: 'a.ini', serverName: 'A' },
      { kind: 'iniRemove', key: 'WorkshopItems', value: WORKSHOP_ID, file: 'a.ini', serverName: 'A' },
      { kind: 'iniSet', key: 'DoLuaChecksum', value: 'false', before: null, file: 'a.ini', serverName: 'A' },
      { kind: 'archiveFile', file: 'x/PanelBridge.lua', fileKind: 'server', recognized: true },
      { kind: 'archiveFile', file: 'x/PanelBridgeClient.lua', fileKind: 'client', recognized: false },
      { kind: 'installFile', file: 'x/PanelBridge.lua', version: '1.7.71' },
      { kind: 'installFile', file: 'x/PanelBridge.lua', version: null },
      { kind: 'recordMethod', method: 'workshop', servers: ['A'] },
      { kind: 'recordMethod', method: 'local', servers: ['A'] },
    ]
    const keys = steps.map((step) => describeDeliveryStep(step).key)
    for (const key of keys) expect(exists(key), key).toBe(true)
    expect(new Set(keys).size).toBe(steps.length)
    expect(describeDeliveryStep(steps[0])).toEqual({
      key: 'step.iniAdd',
      params: { value: BRIDGE_MOD_ID, iniKey: 'Mods', file: 'a.ini' },
      serverName: 'A',
    })
  })
})

describe('resolveStateActions: lifecycle and option-card de-duplication only, no re-derived state', () => {
  it('workshop-restart-needed offers restart while running and start while stopped, neither when unknown', () => {
    const base = makeWorkshopStatus({ state: 'workshop-restart-needed' })
    expect(resolveStateActions({ ...base, serverRunning: true })).toEqual(['restartNow'])
    expect(resolveStateActions({ ...base, serverRunning: false })).toEqual(['startServer'])
    expect(resolveStateActions({ ...base, serverRunning: null })).toEqual([])
  })

  it('drops a switch the other option card already offers', () => {
    expect(resolveStateActions(makeWorkshopStatus({ state: 'workshop-not-loaded' }))).toEqual(['restartNow'])
    expect(resolveStateActions(makeWorkshopStatus({ state: 'workshop-id-unknown' }))).toEqual([])
  })

  it('local-workshop-loaded keeps "Switch to panel-installed" only when the server offers it', () => {
    const blocked = makeLocalStatus({ state: 'local-workshop-loaded' })
    expect(resolveStateActions(blocked)).toEqual([])
    const offered = makeLocalStatus({
      state: 'local-workshop-loaded',
      switchAvailability: {
        toWorkshop: { available: true, reason: null, warnings: [] },
        toLocal: { available: true, reason: null, warnings: [] },
      },
    })
    expect(resolveStateActions(offered)).toEqual(['switchToLocal'])
  })

  it('workshop-start-failed offers the rollback-and-start action', () => {
    expect(resolveStateActions(makeWorkshopStatus({ state: 'workshop-start-failed', serverRunning: false }))).toEqual([
      'switchToLocalAndStart',
    ])
  })

  // "Switch, restart later" back to panel-installed: the server already
  // answers with the Local state, and the running game keeps what it loaded
  // until it restarts -- the restart that finishes the switch is offered.
  it('a switch back to panel-installed the game has not restarted since adds Restart now', () => {
    const pending = makeLocalStatus({
      switch: { to: 'local', at: '2026-10-02T10:00:00.000Z', by: 'admin', bridgeStartedAt: 1, workshopId: null },
      restartedSinceSwitch: false,
      live: { alive: true, version: '1.7.71', delivery: 'workshop', workshopId: WORKSHOP_ID, startedAt: 1, gameVersion: '42.20.0' },
    })
    expect(needsRestartAfterLocalSwitch(pending)).toBe(true)
    expect(resolveStateActions(pending)).toEqual(['restartNow'])
    expect(exists('state.restartAfterLocalSwitch')).toBe(true)
    // Unknown lifecycle (guided): the note, but no button.
    expect(needsRestartAfterLocalSwitch({ ...pending, serverRunning: null })).toBe(true)
    expect(resolveStateActions({ ...pending, serverRunning: null })).toEqual([])
    // Stopped (the next start loads it), restarted already, a switch to the
    // Workshop, or a settings file that still asks for the Workshop copy.
    expect(needsRestartAfterLocalSwitch({ ...pending, serverRunning: false })).toBe(false)
    expect(needsRestartAfterLocalSwitch({ ...pending, restartedSinceSwitch: true })).toBe(false)
    expect(needsRestartAfterLocalSwitch({ ...pending, restartedSinceSwitch: null, switch: null })).toBe(false)
    expect(needsRestartAfterLocalSwitch({ ...pending, state: 'local-workshop-loaded' })).toBe(false)
    expect(needsRestartAfterLocalSwitch(makeWorkshopStatus({ state: 'workshop-restart-needed', restartedSinceSwitch: false }))).toBe(false)
    // Added once, after the state's own actions.
    expect(resolveStateActions({ ...pending, state: 'local-update-pending' })).toEqual(['updateNow', 'restartNow'])
  })

  // "Failed to connect to Steam servers" stops every Steam-mode server, the
  // panel-installed one too: no switch back as the way out, and no "launched
  // without Steam" (a -nosteam server skips the Steam block entirely).
  it('workshop-start-failed because Steam was unreachable offers a start, not the switch back', () => {
    const failed = makeWorkshopStatus({
      state: 'workshop-start-failed',
      serverRunning: false,
      lastStartFailure: { kind: 'steamUnreachable', line: 'Failed to connect to Steam servers', result: null, logMtime: '2026-10-02T10:05:00.000Z' },
    })
    expect(resolveStateActions(failed)).toEqual(['startServer'])
    const view = resolveStateView(failed)
    expect(view).toMatchObject({
      tone: 'warning',
      bodyKey: 'state.workshop-start-failed.bodySteamUnreachable',
      causesKey: 'state.causes.steamUnreachable',
    })
    for (const key of [view.titleKey, view.bodyKey, view.causesKey!]) expect(exists(key), key).toBe(true)
    expect(resolveStateCopy(failed)).toEqual({
      titleKey: 'state.workshop-start-failed.title',
      bodyKey: 'state.workshop-start-failed.bodySteamUnreachable',
      params: {},
    })
    const itemFailed = { ...failed, lastStartFailure: { ...failed.lastStartFailure!, kind: 'itemDownload' as const, result: 9 } }
    expect(resolveStateView(itemFailed)).toBe(DELIVERY_STATE_VIEWS['workshop-start-failed'])
    expect(resolveStateActions(itemFailed)).toEqual(['switchToLocalAndStart'])
    for (const key of ['state.causes.startFailed', 'state.causes.steamUnreachable']) {
      expect(i18n.t(key, { ns: 'bridgeDelivery', lng: 'en' })).not.toMatch(/without Steam/)
    }
  })

  it('local install states offer the existing install endpoint', () => {
    expect(resolveStateActions(makeLocalStatus({ state: 'local-update-pending' }))).toEqual(['updateNow'])
    expect(resolveStateActions(makeLocalStatus({ state: 'local-not-installed' }))).toEqual(['installNow'])
  })
})

describe('local-ok copy and version: only what the state was decided on', () => {
  // The game server kept running across a panel update: the boot reconcile
  // already copied 1.7.70 to disk (so the state is local-ok), but the
  // heartbeat still reports the 1.7.60 the game loaded at start.
  const liveOlder = { alive: true, version: '1.7.60', delivery: 'loose' as const, workshopId: null, startedAt: 1, gameVersion: '42.20.0' }

  it('automatic local-ok shows the file on disk (the bundled version), never the heartbeat', () => {
    expect(getStateVersion(makeLocalStatus({ live: liveOlder }))).toBe('1.7.70')
    expect(getStateVersion(makeLocalStatus({ live: null }))).toBe('1.7.70')
    expect(getStateVersion(makeLocalStatus({ live: null, bundledVersion: null }))).toBeNull()
  })

  it('guided local-ok and workshop-confirmed show the heartbeat', () => {
    expect(getStateVersion(makeLocalStatus({ access: 'guided', disk: null, live: liveOlder }))).toBe('1.7.60')
    expect(getStateVersion(makeWorkshopStatus())).toBe('1.7.71')
    expect(getStateVersion(makeWorkshopStatus({ live: null }))).toBeNull()
  })

  it('guided local-ok gets copy that only claims the bridge is running', () => {
    expect(resolveStateCopy(makeLocalStatus({ access: 'guided', disk: null }))).toEqual({
      titleKey: 'state.local-ok.titleGuided',
      bodyKey: 'state.local-ok.bodyGuided',
      params: { version: '1.7.70' },
    })
    expect(resolveStateCopy(makeLocalStatus())).toEqual({
      titleKey: 'state.local-ok.title',
      bodyKey: 'state.local-ok.body',
      params: { version: '1.7.70' },
    })
    expect(resolveStateCopy(makeWorkshopStatus())).toEqual({
      titleKey: 'state.workshop-confirmed.title',
      bodyKey: 'state.workshop-confirmed.body',
      params: { version: '1.7.71' },
    })
    for (const key of ['state.local-ok.titleGuided', 'state.local-ok.bodyGuided', 'state.local-ok.restartToLoad']) {
      expect(exists(key), key).toBe(true)
    }
  })

  // "Installed by the panel: v—." is what a missing version used to read.
  it('switches to a version-less body when the signal it reads has no version', () => {
    expect(resolveStateCopy(makeLocalStatus({ bundledVersion: null }))).toEqual({
      titleKey: 'state.local-ok.title',
      bodyKey: 'state.local-ok.bodyNoVersion',
      params: {},
    })
    expect(resolveStateCopy(makeLocalStatus({ access: 'guided', disk: null, live: { ...liveOlder, version: null } }))).toEqual({
      titleKey: 'state.local-ok.titleGuided',
      bodyKey: 'state.local-ok.bodyGuidedNoVersion',
      params: {},
    })
    expect(resolveStateCopy(makeWorkshopStatus({ live: { ...makeWorkshopStatus().live!, version: null } }))).toEqual({
      titleKey: 'state.workshop-confirmed.title',
      bodyKey: 'state.workshop-confirmed.bodyNoVersion',
      params: {},
    })
    // States whose copy has no {{version}} never ask for one.
    expect(resolveStateCopy(makeLocalStatus({ state: 'local-not-installed', bundledVersion: null })).params).toEqual({})
    for (const key of ['state.local-ok.bodyNoVersion', 'state.local-ok.bodyGuidedNoVersion', 'state.workshop-confirmed.bodyNoVersion']) {
      expect(exists(key), key).toBe(true)
      expect(i18n.t(key, { ns: 'bridgeDelivery', lng: 'en' })).not.toContain('{{')
    }
  })

  it('notes the restart that loads the new file while the running copy differs', () => {
    expect(getRunningVersionNote(makeLocalStatus({ live: liveOlder }))).toEqual({ running: '1.7.60', version: '1.7.70' })
    // Same version, no heartbeat, a stale one, a Zomboid/mods copy (which a
    // restart wouldn't replace), guided access or another state: no note.
    expect(getRunningVersionNote(makeLocalStatus())).toBeNull()
    expect(getRunningVersionNote(makeLocalStatus({ live: null }))).toBeNull()
    expect(getRunningVersionNote(makeLocalStatus({ live: { ...liveOlder, alive: false } }))).toBeNull()
    expect(getRunningVersionNote(makeLocalStatus({ live: { ...liveOlder, delivery: 'mod' } }))).toBeNull()
    expect(getRunningVersionNote(makeLocalStatus({ access: 'guided', disk: null, live: liveOlder }))).toBeNull()
    expect(getRunningVersionNote(makeLocalStatus({ state: 'local-update-pending', live: liveOlder }))).toBeNull()
  })
})

describe('getGuidedWorkshopManual', () => {
  it('uses the contract mod id and the server-computed Workshop id', () => {
    expect(getGuidedWorkshopManual(makeWorkshopStatus({ access: 'guided', disk: null }))).toEqual({
      modsEntry: 'ZCPB',
      workshopItemsEntry: WORKSHOP_ID,
      removeFiles: ['media/lua/server/PanelBridge.lua', 'media/lua/client/PanelBridgeClient.lua'],
      setChecksumFalse: false,
    })
  })
})

describe('resolveLuaChecksumCallout (Server Config › INI, spec §4.12)', () => {
  it.each([
    [{ method: 'local', state: 'local-ok', turnOnBlockers: ['notWorkshop'] }, 'true', 'localBlocked'],
    [{ method: 'local', state: 'local-ok', turnOnBlockers: ['notWorkshop'] }, 'false', null],
    [{ method: 'workshop', state: 'workshop-confirmed', turnOnBlockers: [] }, 'false', 'workshopNote'],
    [{ method: 'workshop', state: 'workshop-confirmed', turnOnBlockers: ['alreadyOn'] }, 'true', null],
    [{ method: 'workshop', state: 'workshop-restart-needed', turnOnBlockers: ['notConfirmed'] }, 'true', 'workshopUnconfirmed'],
    [{ method: 'workshop', state: 'workshop-not-loaded', turnOnBlockers: ['notConfirmed'] }, 'false', null],
  ] as const)('%o with DoLuaChecksum=%s -> %s', (delivery, value, expected) => {
    expect(resolveLuaChecksumCallout(delivery, value)).toBe(expected)
  })

  it('never says "you can turn this on" while the server has a reason against it', () => {
    const confirmed = { method: 'workshop', state: 'workshop-confirmed' } as const
    expect(resolveLuaChecksumCallout({ ...confirmed, turnOnBlockers: ['looseFilesPresent'] }, 'false')).toBeNull()
    // alreadyOn describes the saved file, not the editor: someone turning
    // it off in the editor may still be told it can go back on.
    expect(resolveLuaChecksumCallout({ ...confirmed, turnOnBlockers: ['alreadyOn'] }, 'false')).toBe('workshopNote')
  })

  // The game (and the server's getEffectiveChecksum) reads 1/0 as well as
  // true/false, and an unreadable value leaves its default, which is on.
  it.each([
    ['1', 'localBlocked'],
    [' TRUE ', 'localBlocked'],
    ['yes', 'localBlocked'],
    ['', 'localBlocked'],
    ['0', null],
    ['False', null],
  ] as const)('reads DoLuaChecksum=%j the way the game does -> %s', (value, expected) => {
    expect(resolveLuaChecksumCallout({ method: 'local', state: 'local-ok', turnOnBlockers: ['notWorkshop'] }, value)).toBe(expected)
  })

  it('a confirmed Workshop server with DoLuaChecksum=1 is already on: no "you can turn this on" note', () => {
    expect(resolveLuaChecksumCallout({ method: 'workshop', state: 'workshop-confirmed', turnOnBlockers: ['alreadyOn'] }, '1')).toBeNull()
    expect(resolveLuaChecksumCallout({ method: 'workshop', state: 'workshop-restart-needed', turnOnBlockers: ['notConfirmed'] }, '1')).toBe(
      'workshopUnconfirmed',
    )
  })

  it('falls back to local behaviour when the delivery status could not be read', () => {
    expect(resolveLuaChecksumCallout(null, 'TRUE')).toBe('localBlocked')
    expect(resolveLuaChecksumCallout(null, 'false')).toBeNull()
    expect(resolveLuaChecksumCallout(null, undefined)).toBeNull()
  })

  it('shows nothing while the delivery status has not answered yet', () => {
    expect(resolveLuaChecksumCallout(undefined, 'true')).toBeNull()
    expect(resolveLuaChecksumCallout(undefined, 'false')).toBeNull()
  })
})

describe('isBridgeManagedMod', () => {
  const managed = { modId: 'ZCPB', workshopId: WORKSHOP_ID }

  it('matches the bridge row by Workshop id or by mod id', () => {
    expect(isBridgeManagedMod(managed, WORKSHOP_ID, [])).toBe(true)
    expect(isBridgeManagedMod(managed, '999', ['ZCPB'])).toBe(true)
  })

  it('matches nothing else, and nothing at all while the server is not on the Workshop', () => {
    expect(isBridgeManagedMod(managed, '999', ['SomeOtherMod'])).toBe(false)
    expect(isBridgeManagedMod(null, WORKSHOP_ID, ['ZCPB'])).toBe(false)
  })

  // The game looks Mods= ids up exactly, case included, so `zcpb` is some
  // other mod and stays editable on the Mods page.
  it('compares the mod id exactly, like the game', () => {
    expect(isBridgeManagedMod(managed, '999', ['zcpb'])).toBe(false)
  })
})

describe('getStateHintKey', () => {
  it('gives local-workshop-loaded the manual fix while the server offers no switch back', () => {
    const loaded = makeLocalStatus({ state: 'local-workshop-loaded' })
    expect(getStateHintKey(loaded)).toBe('state.local-workshop-loaded.manualHint')
    expect(exists('state.local-workshop-loaded.manualHint')).toBe(true)
    const offered = {
      ...loaded,
      switchAvailability: { ...loaded.switchAvailability, toLocal: { available: true, reason: null, warnings: [] } },
    }
    expect(getStateHintKey(offered)).toBeNull()
    expect(getStateHintKey(makeLocalStatus())).toBeNull()
  })
})

describe('formatList / getAvailabilityParams: lists joined the way the UI language joins them', () => {
  it.each([
    ['en', 'Alpha, Beta, and Gamma'],
    ['fr', 'Alpha, Beta et Gamma'],
    ['zh-CN', 'Alpha、Beta和Gamma'],
    ['ar', 'Alpha وBeta وGamma'],
  ])('%s', (language, expected) => {
    expect(formatList(['Alpha', 'Beta', 'Gamma'], language)).toBe(expected)
  })

  it('falls back to a plain comma list for a language the runtime has no list data for', () => {
    expect(formatList(['Alpha', 'Beta'], 'ht')).toBe('Alpha, Beta')
    expect(formatList(['Alpha', 'Beta'], 'not a tag!')).toBe('Alpha, Beta')
  })

  it('names the servers that share the install in the UI language', () => {
    const status = makeLocalStatus({ sharedWith: [{ id: 'a', name: 'North' }, { id: 'b', name: 'South' }] })
    expect(getAvailabilityParams(status, 'zh-TW').servers).toBe('North和South')
    expect(getAvailabilityParams(status, 'de', [{ id: 'c', name: 'East' }]).servers).toBe('East')
  })

  it('shows the game version without the git revision Core.getVersion() appends', () => {
    const live = (gameVersion: string | null) =>
      makeLocalStatus({ live: { alive: true, version: '1.7.70', delivery: 'loose', workshopId: null, startedAt: 1, gameVersion } })
    expect(getAvailabilityParams(live('41.78.16 1a2b3c4d5e'), 'en').version).toBe('41.78.16')
    expect(getAvailabilityParams(live('42.20.4'), 'en').version).toBe('42.20.4')
    expect(getAvailabilityParams(live(null), 'en').version).toBe('—')
    expect(getAvailabilityParams(live('  '), 'en').version).toBe('—')
  })
})

describe('getRestartWarning', () => {
  it('warns players the heartbeat reports, restarts an empty server at once', () => {
    expect(getRestartWarning(makeWorkshopStatus(), 3)).toEqual({ minutes: 5, players: 'some' })
    expect(getRestartWarning(makeWorkshopStatus(), 0)).toEqual({ minutes: 0, players: 'none' })
  })

  // workshop-not-loaded after the grace period, or restart-needed on a
  // server whose bridge never connected: no heartbeat, so no count, and
  // players may still be on the server.
  it('treats an unknown count as players online, never as an empty server', () => {
    expect(getRestartWarning(makeWorkshopStatus({ live: null }), null)).toEqual({ minutes: 5, players: 'unknown' })
    expect(getRestartWarning(makeWorkshopStatus({ live: { ...makeWorkshopStatus().live!, alive: false } }), 0)).toEqual({
      minutes: 5,
      players: 'unknown',
    })
    expect(getRestartWarning(makeWorkshopStatus(), null)).toEqual({ minutes: 5, players: 'unknown' })
  })
})

describe('isDeliveryStatus / isDeliveryPlanResponse', () => {
  it('accept contract-shaped answers', () => {
    expect(isDeliveryStatus(makeLocalStatus())).toBe(true)
    expect(isDeliveryStatus(makeWorkshopStatus({ access: 'guided', disk: null, live: null }))).toBe(true)
    expect(isDeliveryPlanResponse(makePlan())).toBe(true)
    expect(isDeliveryPlanResponse(makePlan({ blocked: { reason: 'noSteam' }, steps: [], manual: null }))).toBe(true)
  })

  // lib/demo.ts answers every GET it has no route for with this body.
  it('reject the demo build catch-all and other non-contract bodies', () => {
    expect(isDeliveryStatus({ success: true, demo: true })).toBe(false)
    expect(isDeliveryPlanResponse({ success: true, message: 'Demo mode: action acknowledged (no backend connected).' })).toBe(false)
    expect(isDeliveryStatus(null)).toBe(false)
    expect(isDeliveryStatus('ok')).toBe(false)
    expect(isDeliveryStatus({ ...makeLocalStatus(), state: 'local-something-new' })).toBe(false)
    expect(isDeliveryStatus({ ...makeLocalStatus(), checksum: undefined })).toBe(false)
    expect(
      isDeliveryStatus({ ...makeLocalStatus(), switchAvailability: { toWorkshop: { available: true, reason: null, warnings: [] } } }),
    ).toBe(false)
    expect(isDeliveryPlanResponse({ ...makePlan(), steps: [{ kind: 'somethingNew' }] })).toBe(false)
    expect(isDeliveryPlanResponse({ ...makePlan(), warnings: undefined })).toBe(false)
  })
})
