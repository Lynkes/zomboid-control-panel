import {
  BRIDGE_MOD_ID,
  type BridgeManaged,
  type ChecksumBlocker,
  type DeliveryBlockReason,
  type DeliveryMethod,
  type DeliveryPlanResponse,
  type DeliveryState,
  type DeliveryStatus,
  type DeliveryStep,
  type DeliveryWarning,
} from './bridgeDeliveryTypes'

// Maps the server-computed PanelBridge delivery status (GET
// /panel-bridge/delivery) to copy keys and actions. Nothing here re-derives
// a state, an availability or a checksum rule: the server owns all of them
// (server/services/bridgeDelivery.js getDeliveryStatus), and a second
// client-side copy of that logic would drift from it the first time either
// side changed. Every key below lives in the `bridgeDelivery` namespace.

export type DeliveryAction =
  | 'switchToWorkshop'
  | 'switchToLocal'
  | 'switchToLocalAndStart'
  | 'restartNow'
  | 'startServer'
  | 'installNow'
  | 'updateNow'

// `ok` and `neutral` both render as the neutral callout (DESIGN.md has only
// warning and neutral callouts); `ok` additionally gets the success icon.
export type DeliveryTone = 'ok' | 'neutral' | 'warning'

export interface DeliveryStateView {
  tone: DeliveryTone
  titleKey: string
  bodyKey: string
  causesKey: string | null
  // The spec's primary actions for the state (§4.5), before lifecycle and
  // option-card de-duplication -- see resolveStateActions().
  actions: readonly DeliveryAction[]
}

export const DELIVERY_STATE_VIEWS: Readonly<Record<DeliveryState, DeliveryStateView>> = {
  'local-ok': { tone: 'ok', titleKey: 'state.local-ok.title', bodyKey: 'state.local-ok.body', causesKey: null, actions: [] },
  'local-update-pending': {
    tone: 'neutral',
    titleKey: 'state.local-update-pending.title',
    bodyKey: 'state.local-update-pending.body',
    causesKey: null,
    actions: ['updateNow'],
  },
  'local-not-installed': {
    tone: 'warning',
    titleKey: 'state.local-not-installed.title',
    bodyKey: 'state.local-not-installed.body',
    causesKey: null,
    actions: ['installNow'],
  },
  'local-unverified': {
    tone: 'neutral',
    titleKey: 'state.local-unverified.title',
    bodyKey: 'state.local-unverified.body',
    causesKey: null,
    actions: [],
  },
  'local-workshop-loaded': {
    tone: 'warning',
    titleKey: 'state.local-workshop-loaded.title',
    bodyKey: 'state.local-workshop-loaded.body',
    causesKey: null,
    actions: ['switchToWorkshop', 'switchToLocal'],
  },
  'workshop-restart-needed': {
    tone: 'neutral',
    titleKey: 'state.workshop-restart-needed.title',
    bodyKey: 'state.workshop-restart-needed.body',
    causesKey: null,
    actions: ['restartNow', 'startServer'],
  },
  'workshop-waiting': {
    tone: 'neutral',
    titleKey: 'state.workshop-waiting.title',
    bodyKey: 'state.workshop-waiting.body',
    causesKey: null,
    actions: [],
  },
  'workshop-confirmed': {
    tone: 'ok',
    titleKey: 'state.workshop-confirmed.title',
    bodyKey: 'state.workshop-confirmed.body',
    causesKey: null,
    actions: [],
  },
  'workshop-not-loaded': {
    tone: 'warning',
    titleKey: 'state.workshop-not-loaded.title',
    bodyKey: 'state.workshop-not-loaded.body',
    causesKey: 'state.causes.notLoaded',
    actions: ['restartNow', 'switchToLocal'],
  },
  'workshop-stopped': {
    tone: 'neutral',
    titleKey: 'state.workshop-stopped.title',
    bodyKey: 'state.workshop-stopped.body',
    causesKey: null,
    actions: ['startServer'],
  },
  'workshop-start-failed': {
    tone: 'warning',
    titleKey: 'state.workshop-start-failed.title',
    bodyKey: 'state.workshop-start-failed.body',
    causesKey: 'state.causes.startFailed',
    actions: ['switchToLocalAndStart'],
  },
  'workshop-id-unknown': {
    tone: 'warning',
    titleKey: 'state.workshop-id-unknown.title',
    bodyKey: 'state.workshop-id-unknown.body',
    causesKey: null,
    actions: ['switchToLocal'],
  },
}

export function getDeliveryStateView(state: DeliveryState): DeliveryStateView {
  return DELIVERY_STATE_VIEWS[state]
}

export const DELIVERY_ACTION_KEYS: Readonly<Record<DeliveryAction, string>> = {
  switchToWorkshop: 'action.switchToWorkshop',
  switchToLocal: 'action.switchToLocal',
  switchToLocalAndStart: 'action.switchToLocalAndStart',
  restartNow: 'action.restartNow',
  startServer: 'action.startServer',
  installNow: 'action.installNow',
  updateNow: 'action.updateNow',
}

export function switchActionFor(target: DeliveryMethod): DeliveryAction {
  return target === 'workshop' ? 'switchToWorkshop' : 'switchToLocal'
}

// The state's action row, as rendered. Two filters, both presentation-only:
//  - Start/restart need a known lifecycle: restart only while the server is
//    known to run, start only while it is known to be stopped. `null`
//    (remote/SFTP, where the panel can't see the process) shows neither --
//    those servers are restarted from the host's own dashboard.
//  - A switch to the non-current method is already the primary button on
//    that method's option card right below, so it isn't repeated here. The
//    one that survives is local-workshop-loaded's "Switch to panel-installed"
//    (the current method's card has no switch button), and only while the
//    server says that switch is available -- `sameMethod` there means the
//    server has no cleanup to offer, and a button that can only fail would
//    be worse than none.
export function resolveStateActions(status: DeliveryStatus): DeliveryAction[] {
  const view = DELIVERY_STATE_VIEWS[status.state]
  return view.actions.filter((action) => {
    switch (action) {
      case 'restartNow':
        return status.serverRunning === true
      case 'startServer':
        return status.serverRunning === false
      case 'switchToWorkshop':
      case 'switchToLocal': {
        const target: DeliveryMethod = action === 'switchToWorkshop' ? 'workshop' : 'local'
        if (target !== status.method) return false
        const availability = target === 'workshop' ? status.switchAvailability.toWorkshop : status.switchAvailability.toLocal
        return availability.available
      }
      case 'switchToLocalAndStart':
        return status.switchAvailability.toLocal.available
      default:
        return true
    }
  })
}

// {{version}} for the local-ok / workshop-confirmed copy: what the live
// heartbeat reports, else what the panel bundles (automatic local access
// where the file on disk is current by definition of local-ok).
export function getStateVersion(status: DeliveryStatus): string {
  return status.live?.version ?? status.bundledVersion ?? '—'
}

export function getBlockReasonKey(reason: DeliveryBlockReason): string {
  return `unavailable.${reason}`
}

export function getWarningKey(warning: DeliveryWarning): string {
  return `warn.${warning}`
}

export function getChecksumBlockerKey(blocker: ChecksumBlocker): string {
  return `checksumOffer.blockers.${blocker}`
}

// Params every block reason / warning template can ask for. Supplying the
// whole set to each key is harmless (i18next ignores unused params) and
// keeps callers from needing a per-key switch.
export function getAvailabilityParams(
  status: DeliveryStatus,
  sharedWith: DeliveryStatus['sharedWith'] = status.sharedWith,
): Record<string, string> {
  return {
    version: status.live?.gameVersion ?? '—',
    servers: sharedWith.map((s) => s.name).join(', '),
  }
}

export interface DeliveryStepView {
  key: string
  params: Record<string, string>
  // Rendered next to the step, outside the translated sentence, so a
  // profile name can never be parsed as markup by <Trans>.
  serverName: string | null
}

export function describeDeliveryStep(step: DeliveryStep): DeliveryStepView {
  switch (step.kind) {
    case 'iniAdd':
    case 'iniRemove':
      return {
        key: `step.${step.kind}`,
        params: { value: step.value, iniKey: step.key, file: step.file },
        serverName: step.serverName,
      }
    case 'iniSet':
      return { key: 'step.iniSet', params: { file: step.file }, serverName: step.serverName }
    case 'archiveFile':
      return {
        key: step.recognized ? 'step.archiveFile' : 'step.archiveFileUnrecognized',
        params: { file: step.file },
        serverName: null,
      }
    case 'installFile':
      return step.version
        ? { key: 'step.installFile', params: { file: step.file, version: step.version }, serverName: null }
        : { key: 'step.installFileNoVersion', params: { file: step.file }, serverName: null }
    case 'recordMethod':
      return {
        key: step.method === 'workshop' ? 'step.recordMethodWorkshop' : 'step.recordMethodLocal',
        params: {},
        serverName: null,
      }
  }
}

// §5.4 `manual.removeFiles` for a switch to the Workshop. Only used to
// re-show the guided steps on a guided server that is already on the
// Workshop (the switch preview itself always uses the server's `manual`).
export const GUIDED_BRIDGE_FILES = [
  'media/lua/server/PanelBridge.lua',
  'media/lua/client/PanelBridgeClient.lua',
] as const

export type GuidedManual = NonNullable<DeliveryPlanResponse['manual']>

// The ini values a guided (remote/hosted) Workshop server must carry, for
// the standing reminder shown until the heartbeat confirms. The values are
// the contract's mod id and the server-computed effectiveWorkshopId; the
// client decides nothing here.
export function getGuidedWorkshopManual(status: DeliveryStatus): GuidedManual {
  return {
    modsEntry: BRIDGE_MOD_ID,
    workshopItemsEntry: status.effectiveWorkshopId,
    removeFiles: [...GUIDED_BRIDGE_FILES],
    setChecksumFalse: false,
  }
}

// Server Config › INI callout for DoLuaChecksum (§4.12). `delivery` is null
// when GET /panel-bridge/delivery failed or hasn't answered; that falls
// back to the local behaviour, which is the safe one (it only ever warns).
export type LuaChecksumCallout = 'localBlocked' | 'workshopNote' | 'workshopUnconfirmed'

export function resolveLuaChecksumCallout(
  delivery: { method: DeliveryMethod; state: DeliveryState } | null,
  editorValue: string | undefined,
): LuaChecksumCallout | null {
  const on = editorValue?.trim().toLowerCase() === 'true'
  const method = delivery?.method ?? 'local'
  if (method === 'local') return on ? 'localBlocked' : null
  const confirmed = delivery?.state === 'workshop-confirmed'
  if (confirmed) return on ? null : 'workshopNote'
  return on ? 'workshopUnconfirmed' : null
}

// Mods page: whether an "Active on server" row is the bridge's own entry,
// which the server keeps in Mods=/WorkshopItems= while on the Workshop
// (GET /api/mods/current-config `bridgeManaged`, §4.11).
export function isBridgeManagedMod(
  bridgeManaged: BridgeManaged | null | undefined,
  workshopId: string | null | undefined,
  modIds: readonly string[],
): boolean {
  if (!bridgeManaged) return false
  if (workshopId && workshopId === bridgeManaged.workshopId) return true
  return modIds.includes(bridgeManaged.modId)
}
