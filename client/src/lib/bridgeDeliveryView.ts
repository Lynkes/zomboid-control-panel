import {
  BRIDGE_MOD_ID,
  DELIVERY_METHODS,
  DELIVERY_STATES,
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

// Title/body keys for the state callout. Only local-ok has two readings
// (§4.5, §6.9): with automatic access it means the loose file on disk
// matches the bundled one; with guided access the panel can't see that
// file at all, and local-ok only means a live heartbeat exists -- which may
// well be an old upload (the staleness alert above the block says so). So
// guided gets copy that claims no more than "it's running".
//
// The bodies that print v{{version}} have a version-less twin for when the
// signal they read has none (no bundled version embedded, an old heartbeat
// without one): "Installed by the panel." reads right, "v—" doesn't.
const VERSIONLESS_BODY_KEYS: Readonly<Record<string, string>> = {
  'state.local-ok.body': 'state.local-ok.bodyNoVersion',
  'state.local-ok.bodyGuided': 'state.local-ok.bodyGuidedNoVersion',
  'state.workshop-confirmed.body': 'state.workshop-confirmed.bodyNoVersion',
}

export interface DeliveryStateCopy {
  titleKey: string
  bodyKey: string
  params: { version?: string }
}

export function resolveStateCopy(status: DeliveryStatus): DeliveryStateCopy {
  const view = DELIVERY_STATE_VIEWS[status.state]
  const guided = status.state === 'local-ok' && status.access === 'guided'
  const titleKey = guided ? 'state.local-ok.titleGuided' : view.titleKey
  const bodyKey = guided ? 'state.local-ok.bodyGuided' : view.bodyKey
  const versionless = VERSIONLESS_BODY_KEYS[bodyKey]
  if (!versionless) return { titleKey, bodyKey, params: {} }
  const version = getStateVersion(status)
  return version ? { titleKey, bodyKey, params: { version } } : { titleKey, bodyKey: versionless, params: {} }
}

// {{version}} for the local-ok / workshop-confirmed copy, taken from the
// signal the state itself was decided on:
//  - automatic local-ok: the file on disk, which is the bundled version by
//    definition of that state. The heartbeat is NOT that file -- a game
//    server that kept running across a panel update still reports the copy
//    it loaded at start (see getRunningVersionNote);
//  - guided local-ok and workshop-confirmed: the live heartbeat.
// null when that signal carries no version (see resolveStateCopy).
export function getStateVersion(status: DeliveryStatus): string | null {
  if (status.state === 'local-ok' && status.access === 'automatic') return status.bundledVersion || null
  return status.live?.version || null
}

// An extra line under a state's body, for the one state whose remedy the
// panel can't always run itself. local-workshop-loaded means the ini still
// lists the Workshop item while the server is set to panel-installed; §4.5
// has "Switch to panel-installed" remove those entries, but while the
// server reports that switch as `sameMethod` there is no button for it
// (resolveStateActions), so the operator gets the manual edit instead.
export function getStateHintKey(status: DeliveryStatus): string | null {
  if (status.state === 'local-workshop-loaded' && !status.switchAvailability.toLocal.available) {
    return 'state.local-workshop-loaded.manualHint'
  }
  return null
}

// Automatic local-ok while the running server reports a different loose
// copy than the one now on disk: the panel refreshed the file (boot
// reconcile, "Update now") and the game only picks it up at its next start.
// Two server-reported values shown side by side, not a state -- the state
// is right, the operator only needs to know a restart is what loads it.
// `loose` only: a copy under Zomboid/mods wins over the loose file (§2.2),
// so for that one a restart would load nothing new.
export function getRunningVersionNote(status: DeliveryStatus): { running: string; version: string } | null {
  if (status.state !== 'local-ok' || status.access !== 'automatic') return null
  const live = status.live
  if (!live?.alive || live.delivery !== 'loose' || !live.version || !status.bundledVersion) return null
  if (live.version === status.bundledVersion) return null
  return { running: live.version, version: status.bundledVersion }
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

// Intl.ListFormat is ES2021; the client's TypeScript lib stops at ES2020,
// so the two members used here are typed locally.
type ListFormatConstructor = {
  new (locale: string, options: { style: 'long'; type: 'conjunction' }): { format(items: readonly string[]): string }
  supportedLocalesOf(locales: string[]): string[]
}

// A list inside a translated sentence, joined the way the UI language joins
// one ("A, B, and C", "A、B和C", "A وB"). A language the runtime has no list
// data for (ht, in current ICU builds) gets a plain comma list instead of
// the default locale's -- which would drop an English "and" into a Creole
// sentence.
export function formatList(items: readonly string[], language: string): string {
  const ListFormat = (Intl as unknown as { ListFormat?: ListFormatConstructor }).ListFormat
  try {
    if (ListFormat && ListFormat.supportedLocalesOf([language]).length > 0) {
      return new ListFormat(language, { style: 'long', type: 'conjunction' }).format(items)
    }
  } catch {
    // An unparseable language tag: fall through to the plain list.
  }
  return items.join(', ')
}

// Params every block reason / warning template can ask for. Supplying the
// whole set to each key is harmless (i18next ignores unused params) and
// keeps callers from needing a per-key switch.
export function getAvailabilityParams(
  status: DeliveryStatus,
  language: string,
  sharedWith: DeliveryStatus['sharedWith'] = status.sharedWith,
): Record<string, string> {
  return {
    version: status.live?.gameVersion ?? '—',
    servers: formatList(sharedWith.map((s) => s.name), language),
  }
}

// How much warning a restart the operator asks for from this block gives
// (the state callout's "Restart now", the checksum dialog's restart). The
// player count comes from the bridge heartbeat, so it is only known while
// the bridge is alive -- and the states that offer a restart
// (workshop-restart-needed, workshop-not-loaded) are exactly the ones where
// it often isn't. Unknown is not "empty": players may well be on a server
// whose bridge didn't load, so they get the same 5-minute warning as a
// server known to have players, never an instant kick.
//
// The switch dialog keeps §4.6's literal rule instead (warning only when
// the heartbeat reports players); its button says which one it will do.
export const RESTART_WARNING_MINUTES = 5

export interface RestartWarning {
  minutes: number
  players: 'some' | 'none' | 'unknown'
}

export function getRestartWarning(status: DeliveryStatus, playerCount: number | null): RestartWarning {
  if (status.live?.alive === true && playerCount != null) {
    return playerCount > 0 ? { minutes: RESTART_WARNING_MINUTES, players: 'some' } : { minutes: 0, players: 'none' }
  }
  return { minutes: RESTART_WARNING_MINUTES, players: 'unknown' }
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

// Server Config › INI callout for DoLuaChecksum (§4.12). The three inputs
// are distinct on purpose:
//  - undefined: GET /panel-bridge/delivery hasn't answered yet. No callout
//    at all -- falling back to Local here would flash the destructive
//    "players can't connect" alert on a confirmed Workshop server that has
//    the check on legitimately.
//  - null: the call failed. Falls back to the local behaviour, which is the
//    safe one (it only ever warns).
//  - a status: the server's method, state and checksum blockers.
export type LuaChecksumCallout = 'localBlocked' | 'workshopNote' | 'workshopUnconfirmed'

export interface LuaChecksumDelivery {
  method: DeliveryMethod
  state: DeliveryState
  turnOnBlockers: readonly ChecksumBlocker[]
}

export function resolveLuaChecksumCallout(
  delivery: LuaChecksumDelivery | null | undefined,
  editorValue: string | undefined,
): LuaChecksumCallout | null {
  if (delivery === undefined) return null
  const on = editorValue?.trim().toLowerCase() === 'true'
  const method = delivery?.method ?? 'local'
  if (method === 'local') return on ? 'localBlocked' : null
  if (delivery?.state === 'workshop-confirmed') {
    if (on) return null
    // "You can turn this on" only while the server has no reason against it
    // (I5: leftover loose files would get every player refused). alreadyOn
    // is the saved file's value, not the editor's, so it isn't a reason
    // against the note.
    const blocked = delivery.turnOnBlockers.some((blocker) => blocker !== 'alreadyOn')
    return blocked ? null : 'workshopNote'
  }
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

// Shape checks for the two /panel-bridge/delivery answers, before anything
// renders them. A 200 isn't proof of a DeliveryStatus: the public demo
// build's fetch shim (lib/demo.ts) answers every GET it has no route for
// with { success: true, demo: true }, and so would any proxy or catch-all
// in front of a panel that predates the route. Rendered as-is, that throws
// inside Settings' error boundary and replaces the whole page; rejected
// here, it becomes the block's own "couldn't load" with Try again. The
// checks cover what the UI dereferences, not every field -- a contract
// value the UI only prints can't crash it.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isAvailability(value: unknown): boolean {
  return isRecord(value) && typeof value.available === 'boolean' && Array.isArray(value.warnings)
}

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  if (!isRecord(value)) return false
  const { switchAvailability, checksum, release, live, disk } = value
  return (
    typeof value.serverId === 'string' &&
    typeof value.serverName === 'string' &&
    (DELIVERY_METHODS as readonly unknown[]).includes(value.method) &&
    (DELIVERY_STATES as readonly unknown[]).includes(value.state) &&
    (value.access === 'automatic' || value.access === 'guided') &&
    Array.isArray(value.sharedWith) &&
    isRecord(release) &&
    isRecord(switchAvailability) &&
    isAvailability(switchAvailability.toWorkshop) &&
    isAvailability(switchAvailability.toLocal) &&
    isRecord(checksum) &&
    Array.isArray(checksum.turnOnBlockers) &&
    (live == null || isRecord(live)) &&
    (disk == null || (isRecord(disk) && Array.isArray(disk.looseFiles)))
  )
}

// Every step kind describeDeliveryStep() knows; a Record so a kind added to
// the contract fails to compile here until it has copy.
const DELIVERY_STEP_KINDS: Readonly<Record<DeliveryStep['kind'], true>> = {
  iniAdd: true,
  iniRemove: true,
  iniSet: true,
  archiveFile: true,
  installFile: true,
  recordMethod: true,
}

export function isDeliveryPlanResponse(value: unknown): value is DeliveryPlanResponse {
  if (!isRecord(value)) return false
  const { blocked, steps, manual } = value
  return (
    typeof value.serverId === 'string' &&
    (DELIVERY_METHODS as readonly unknown[]).includes(value.from) &&
    (DELIVERY_METHODS as readonly unknown[]).includes(value.to) &&
    (value.access === 'automatic' || value.access === 'guided') &&
    (blocked === null || (isRecord(blocked) && typeof blocked.reason === 'string')) &&
    Array.isArray(steps) &&
    steps.every(
      (step) =>
        isRecord(step) &&
        typeof step.kind === 'string' &&
        Object.prototype.hasOwnProperty.call(DELIVERY_STEP_KINDS, step.kind),
    ) &&
    Array.isArray(value.warnings) &&
    Array.isArray(value.sharedWith) &&
    (manual == null || (isRecord(manual) && Array.isArray(manual.removeFiles)))
  )
}

// Thrown (by useBridgeDelivery, the dialogs) for an answer that failed the
// checks above, so the UI can say "unexpected response" rather than show
// this English message. Still an Error: reportClientError logs it as one.
export class DeliveryResponseError extends Error {
  constructor(route: string) {
    super(`Unexpected response from ${route}`)
    this.name = 'DeliveryResponseError'
  }
}
