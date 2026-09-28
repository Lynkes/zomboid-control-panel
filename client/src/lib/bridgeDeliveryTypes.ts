// Contract between server/routes/bridgeDelivery.js (WS3) and the client (WS4).
// Mirrored by server/services/bridgeDeliveryContract.js. Change only by coordinated amend.
export const DELIVERY_METHODS = ['local', 'workshop'] as const
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number]

export const DELIVERY_STATES = [
  'local-ok', 'local-update-pending', 'local-not-installed', 'local-unverified', 'local-workshop-loaded',
  'workshop-restart-needed', 'workshop-waiting', 'workshop-confirmed', 'workshop-not-loaded',
  'workshop-stopped', 'workshop-start-failed', 'workshop-id-unknown',
] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

export const DELIVERY_BLOCK_REASONS = [
  'sameMethod', 'notPublished', 'idInvalid', 'noSteam', 'gameVersionUnsupported', 'iniNotFound', 'iniDuplicateKeys',
] as const
export type DeliveryBlockReason = (typeof DELIVERY_BLOCK_REASONS)[number]

export const DELIVERY_WARNINGS = [
  'serverRunning', 'customLauncher', 'sharedInstall', 'gameVersionUnknown', 'previewItem', 'envOverride',
  'siblingIniMissing', 'unrecognizedLooseFile', 'checksumWillBeTurnedOff', 'steamFlagMissing',
] as const
export type DeliveryWarning = (typeof DELIVERY_WARNINGS)[number]

export const CHECKSUM_BLOCKERS = ['notWorkshop', 'notConfirmed', 'looseFilesPresent', 'alreadyOn'] as const
export type ChecksumBlocker = (typeof CHECKSUM_BLOCKERS)[number]

export const LOOSE_FILE_KINDS = ['server', 'client', 'rootModInfo'] as const
export type LooseFileKind = (typeof LOOSE_FILE_KINDS)[number]

export const BRIDGE_MOD_ID = 'ZCPB'

export interface DeliveryAvailability { available: boolean; reason: DeliveryBlockReason | null; warnings: DeliveryWarning[] }
export interface DeliverySwitchRecord { to: DeliveryMethod; at: string; by: string | null; bridgeStartedAt: number | null; workshopId: string | null }
export interface DeliveryRelease {
  status: 'published' | 'not-published' | 'invalid'
  source: 'env' | 'embedded' | 'file' | 'none'
  modId: string; workshopId: string | null; visibility: 'public' | 'unlisted' | null
  publishedVersion: string | null; publishedAt: string | null
  preview: boolean; linuxChecksumVerified: boolean
}
export interface DeliveryLive {
  alive: boolean; version: string | null; delivery: 'workshop' | 'mod' | 'loose'
  workshopId: string | null; startedAt: number | null; gameVersion: string | null
}
export interface DeliveryLooseFile { path: string; kind: LooseFileKind; recognized: boolean }
export interface DeliveryDisk {
  installDir: string
  looseFiles: DeliveryLooseFile[]
  iniPath: string | null
  iniEntries: { mods: boolean; workshopItems: boolean } | null
  workshopItem: { folder: string; version: string | null; source: 'log' | 'candidate' } | null
}
export interface DeliveryStatus {
  serverId: string
  serverName: string
  method: DeliveryMethod
  ownMethod: DeliveryMethod
  state: DeliveryState
  access: 'automatic' | 'guided'
  hostOs: 'windows' | 'linux' | 'unknown'
  sharedWith: Array<{ id: string; name: string }>
  switch: DeliverySwitchRecord | null
  release: DeliveryRelease
  effectiveWorkshopId: string | null
  switchAvailability: { toWorkshop: DeliveryAvailability; toLocal: DeliveryAvailability }
  serverRunning: boolean | null
  restartedSinceSwitch: boolean | null
  live: DeliveryLive | null
  disk: DeliveryDisk | null
  lastStartFailure: { kind: 'itemDownload' | 'steamUnreachable'; line: string; result: number | null; logMtime: string } | null
  // Workshop method, not confirmed: Steam's public details API doesn't list
  // the item right now (see getSteamListingNotice).
  steamReportsUnavailable: boolean
  // Workshop method, not confirmed: the server runs the game without Steam
  // (its launch leaves -Dzomboid.steam=1 out, or its console says so).
  steamModeOff: boolean
  modAutoRestart: boolean
  bundledVersion: string | null
  checksum: { current: boolean | null; canTurnOn: boolean; turnOnBlockers: ChecksumBlocker[]; playersBlocked: boolean; requiresLinuxAck: boolean }
}
export type DeliveryStep =
  | { kind: 'iniAdd' | 'iniRemove'; key: 'Mods' | 'WorkshopItems'; value: string; file: string; serverName: string }
  | { kind: 'iniSet'; key: 'DoLuaChecksum'; value: 'false'; before: string | null; file: string; serverName: string }
  | { kind: 'archiveFile'; file: string; fileKind: LooseFileKind; recognized: boolean }
  | { kind: 'installFile'; file: string; version: string | null }
  | { kind: 'recordMethod'; method: DeliveryMethod; servers: string[] }
export interface DeliveryPlanRequest { serverId: string; method: DeliveryMethod; dryRun: boolean; expectedFrom?: DeliveryMethod }
export interface DeliveryPlanResponse {
  serverId: string; from: DeliveryMethod; to: DeliveryMethod; access: 'automatic' | 'guided'
  blocked: { reason: DeliveryBlockReason } | null
  steps: DeliveryStep[]
  warnings: DeliveryWarning[]
  sharedWith: Array<{ id: string; name: string }>
  manual: { modsEntry: string; workshopItemsEntry: string | null; removeFiles: string[]; setChecksumFalse: boolean } | null
  applied: boolean
  restartRequired: boolean
  backups: Array<{ file: string; backupName: string | null }>
  status: DeliveryStatus
}
export interface BridgeManaged { modId: string; workshopId: string }
