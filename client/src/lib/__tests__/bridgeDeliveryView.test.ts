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
  getBlockReasonKey,
  getChecksumBlockerKey,
  getGuidedWorkshopManual,
  getStateVersion,
  getWarningKey,
  isBridgeManagedMod,
  resolveLuaChecksumCallout,
  resolveStateActions,
} from '../bridgeDeliveryView'
import { makeLocalStatus, makeWorkshopStatus, WORKSHOP_ID } from '@/components/bridge/__tests__/deliveryFixtures'

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

  it('local install states offer the existing install endpoint', () => {
    expect(resolveStateActions(makeLocalStatus({ state: 'local-update-pending' }))).toEqual(['updateNow'])
    expect(resolveStateActions(makeLocalStatus({ state: 'local-not-installed' }))).toEqual(['installNow'])
  })
})

describe('getStateVersion', () => {
  it('prefers the live heartbeat, then the bundled version, then a dash', () => {
    expect(getStateVersion(makeWorkshopStatus())).toBe('1.7.71')
    expect(getStateVersion(makeLocalStatus({ live: null }))).toBe('1.7.70')
    expect(getStateVersion(makeLocalStatus({ live: null, bundledVersion: null }))).toBe('—')
  })
})

describe('getGuidedWorkshopManual', () => {
  it('uses the contract mod id and the server-computed Workshop id', () => {
    expect(getGuidedWorkshopManual(makeWorkshopStatus({ access: 'guided', disk: null }))).toEqual({
      modsEntry: 'ZomboidControlPanelBridge',
      workshopItemsEntry: WORKSHOP_ID,
      removeFiles: ['media/lua/server/PanelBridge.lua', 'media/lua/client/PanelBridgeClient.lua'],
      setChecksumFalse: false,
    })
  })
})

describe('resolveLuaChecksumCallout (Server Config › INI, spec §4.12)', () => {
  it.each([
    [{ method: 'local', state: 'local-ok' }, 'true', 'localBlocked'],
    [{ method: 'local', state: 'local-ok' }, 'false', null],
    [{ method: 'workshop', state: 'workshop-confirmed' }, 'false', 'workshopNote'],
    [{ method: 'workshop', state: 'workshop-confirmed' }, 'true', null],
    [{ method: 'workshop', state: 'workshop-restart-needed' }, 'true', 'workshopUnconfirmed'],
    [{ method: 'workshop', state: 'workshop-not-loaded' }, 'false', null],
  ] as const)('%o with DoLuaChecksum=%s -> %s', (delivery, value, expected) => {
    expect(resolveLuaChecksumCallout(delivery, value)).toBe(expected)
  })

  it('falls back to local behaviour when the delivery status is unknown', () => {
    expect(resolveLuaChecksumCallout(null, 'TRUE')).toBe('localBlocked')
    expect(resolveLuaChecksumCallout(null, 'false')).toBeNull()
    expect(resolveLuaChecksumCallout(null, undefined)).toBeNull()
  })
})

describe('isBridgeManagedMod', () => {
  const managed = { modId: 'ZomboidControlPanelBridge', workshopId: WORKSHOP_ID }

  it('matches the bridge row by Workshop id or by mod id', () => {
    expect(isBridgeManagedMod(managed, WORKSHOP_ID, [])).toBe(true)
    expect(isBridgeManagedMod(managed, '999', ['ZomboidControlPanelBridge'])).toBe(true)
  })

  it('matches nothing else, and nothing at all while the server is not on the Workshop', () => {
    expect(isBridgeManagedMod(managed, '999', ['SomeOtherMod'])).toBe(false)
    expect(isBridgeManagedMod(null, WORKSHOP_ID, ['ZomboidControlPanelBridge'])).toBe(false)
  })
})
