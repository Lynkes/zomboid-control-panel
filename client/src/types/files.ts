// Server Files (file manager) contract, v1.4.1.
// Mirrors server/services/fileManagerContract.js: same names, values and order
// for every exported array and for FM_LIMITS
// (server/tests/fileManagerContractParity.test.js fails when they drift).
// The request and response shapes follow the /api/files routes.
// Append-only: a change goes through the integrator, with its server mirror.

// ---- Enumerations ----

export const ROOT_IDS = ['install', 'launch', 'data', 'config'] as const
export type RootId = (typeof ROOT_IDS)[number]

export const BACKENDS = ['local', 'docker', 'sftp'] as const
export type Backend = (typeof BACKENDS)[number]

export const SERVER_STATES = ['running', 'stopped', 'unknown'] as const
export type ServerState = (typeof SERVER_STATES)[number]

export const PROTECTION_LEVELS = ['sealed', 'listOnly', 'readOnly'] as const
export type ProtectionLevel = (typeof PROTECTION_LEVELS)[number]

export const PROTECTED_AREAS = [
  'panelData', 'panelLogs', 'panelProgram', 'panelSecret', 'credentials',
  'panelBackups', 'bridgeIo', 'bridgeManaged', 'launchScripts',
] as const
export type ProtectedArea = (typeof PROTECTED_AREAS)[number]

export const CONFIRM_TOKENS = ['serverRunning', 'overwrite', 'executable', 'permanent'] as const
export type ConfirmToken = (typeof CONFIRM_TOKENS)[number]

export const HINTS = [
  'restartToApply', 'panelRewritesKeys', 'luaChecksum', 'steamUpdateOverwrites', 'bridgeWorkshopEntries', 'secretsMasked',
] as const
export type Hint = (typeof HINTS)[number]

export const ROOT_UNAVAILABLE_REASONS = [
  'missing', 'notConfigured', 'notMounted', 'remoteNotActive', 'remoteNotConfigured', 'remoteInstallNotSet',
  'tooBroad', 'overlapsPanel', 'unreadable', 'sftpUnreachable',
] as const
export type RootUnavailableReason = (typeof ROOT_UNAVAILABLE_REASONS)[number]

export const ROOT_WARNINGS = ['noInstallMarker', 'containerOnly', 'remoteFilesystemRoot'] as const
export type RootWarning = (typeof ROOT_WARNINGS)[number]

export const BOOKMARK_KINDS = [
  'serverSettings', 'worldSave', 'playerDb', 'logs', 'localMods', 'java', 'gameLua', 'workshop',
] as const
export type BookmarkKind = (typeof BOOKMARK_KINDS)[number]

export const TRASH_REASONS = ['deleted', 'edited', 'replaced'] as const
export type TrashReason = (typeof TRASH_REASONS)[number]

/** The `reason` of FM_INVALID_PATH / FM_INVALID_NAME; each is a `files:nameRules.*` key. */
export const NAME_RULE_REASONS = [
  'empty', 'tooLong', 'dotSegment', 'control', 'backslash', 'colon', 'windowsReserved', 'reservedDeviceName',
  'trailingDotOrSpace', 'bidiControl', 'leadingSpace', 'reservedPanelName', 'slash',
] as const
export type NameRuleReason = (typeof NAME_RULE_REASONS)[number]

export const AUDIT_OPS = [
  'files.create', 'files.write', 'files.mkdir', 'files.rename', 'files.move', 'files.copy', 'files.upload',
  'files.delete.trash', 'files.delete.permanent', 'files.trash.restore', 'files.trash.purge', 'files.trash.expire',
  'files.download', 'files.zip', 'files.remoteRoots.set', 'files.denied',
] as const
export type AuditOp = (typeof AUDIT_OPS)[number]

// ---- Limits ----

const KiB = 1024
const MiB = 1024 * KiB
const GiB = 1024 * MiB

export const FM_LIMITS = {
  REL_PATH_MAX_CHARS: 1024,
  SEGMENT_MAX_BYTES: 255,
  PATH_DEPTH_MAX: 64,
  PATHS_PER_REQUEST: 200,
  LIST_FULL_STAT_MAX: 2000,
  LIST_PAGE_DEFAULT: 500,
  LIST_PAGE_MAX: 1000,
  LIST_DIR_MAX_ENTRIES: 200000,
  TEXT_EDIT_MAX_BYTES: 2 * MiB,
  TEXT_TAIL_DEFAULT: 256 * KiB,
  TEXT_TAIL_MAX: 1 * MiB,
  UPLOAD_MAX_BYTES: { local: 2 * GiB, sftp: 1 * GiB },
  UPLOAD_FILES_PER_BATCH: 1000,
  UPLOAD_SLOTS_PER_USER: 2,
  UPLOAD_SLOTS_GLOBAL: 4,
  UPLOAD_IDLE_MS: 30000,
  DISK_FREE_FLOOR_BYTES: 1 * GiB,
  DOWNLOAD_MAX_BYTES: 4 * GiB,
  ZIP_MAX_ENTRIES: { local: 10000, sftp: 2000 },
  ZIP_MAX_BYTES: { local: 4 * GiB, sftp: 1 * GiB },
  ZIP_MAX_DEPTH: 32,
  ZIP_SLOTS_GLOBAL: 2,
  ZIP_SLOTS_PER_USER: 1,
  ZIP_TIME_LIMIT_MS: 900000,
  PREVIEW_WALK_MAX_ENTRIES: 50000,
  PREVIEW_WALK_MAX_MS: 5000,
  PREVIEW_TTL_MS: 300000,
  SEARCH_MAX_RESULTS: 500,
  SEARCH_MAX_VISITED: 50000,
  SEARCH_MAX_DEPTH: 12,
  SEARCH_MAX_MS: 5000,
  TRASH_RETENTION_DAYS: 7,
  TRASH_VERSIONS_PER_FILE: 20,
  PERMANENT_DELETE_MAX_ENTRIES: 500000,
  JOB_TTL_AFTER_DONE_MS: 600000,
  SFTP_READY_TIMEOUT_MS: 10000,
  SFTP_OP_TIMEOUT_MS: 20000,
  SFTP_TRANSFER_IDLE_MS: 30000,
  SFTP_IDLE_CLOSE_MS: 60000,
  SFTP_MAX_CLIENTS: 3,
  AUDIT_RETENTION: 1000,
  DENIED_AUDIT_COALESCE_MS: 60000,
  RUNSTATE_CACHE_MS: 5000,
  ROOT_PROBE_CACHE_MS: 30000,
} as const

// ---- Shared types ----

export type FileEntryType = 'file' | 'dir' | 'link' | 'other'

export interface FileEntry {
  name: string
  /** Root-relative POSIX path, as navigated. */
  path: string
  type: FileEntryType
  /** Never the target path. */
  link?: { inside: boolean; targetType: 'file' | 'dir' | 'missing' | 'unknown' }
  size: number | null
  modifiedAt: string | null
  /** "0644"; null on win32 or when unknown. */
  mode: string | null
  /** Opaque: "s:<size>-<mtimeMs>[-<ino>]" or "h:<sha256>". */
  etag: string | null
  protection: { level: ProtectionLevel; area: ProtectedArea } | null
  flags: {
    editable: boolean
    binaryHint: boolean
    secretBearing: boolean
    executable: boolean
    worldState: boolean
    unsupportedName: boolean
  }
}

export interface RootDescriptor {
  id: RootId
  backend: Backend
  /** Display only, never sent back. */
  displayPath: string | null
  available: boolean
  unavailableReason?: RootUnavailableReason
  unavailableDetail?: string
  writable: boolean | null
  readOnlyReason?: 'mount' | 'permissions'
  freeBytes: number | null
  totalBytes: number | null
  warnings: RootWarning[]
  trashItemCount: number | null
}

export interface Bookmark {
  rootId: RootId
  path: string
  kind: BookmarkKind
}

export interface ProfileFiles {
  id: string
  name: string
  serverName: string
  isActive: boolean
  provider: string
  /** Never the password. */
  remote: { host: string; port: number; username: string } | null
  roots: RootDescriptor[]
  bookmarks: Bookmark[]
  /** SFTP profiles only. */
  remoteRoots?: { installPath: string | null; dataPath: string | null; derivedDataPath: string | null }
  serverState?: ServerState
  serverStateCheckedAt?: string
}

export interface TrashItem {
  trashId: string
  originalPath: string
  type: 'file' | 'dir'
  bytes: number
  files: number
  deletedAt: string
  deletedBy: { username: string | null }
  reason: TrashReason
  expiresAt: string
}

// ---- Requests and responses (base /api/files, JSON unless noted) ----

/** GET /profiles (no serverState on the profiles). */
export interface ProfilesResponse {
  profiles: ProfileFiles[]
}

/** GET /profiles/:id?fresh=1 (with serverState). */
export interface ProfileResponse {
  profile: ProfileFiles
}

export type ListSort = 'name' | 'size' | 'modified'
export type SortOrder = 'asc' | 'desc'

/** GET /profiles/:id/list */
export interface ListQuery {
  root: RootId
  path: string
  offset?: number
  limit?: number
  sort?: ListSort
  order?: SortOrder
}
export interface ListResponse {
  dir: FileEntry
  entries: FileEntry[]
  total: number
  offset: number
  limit: number
  sortLimited: boolean
  truncated: boolean
  dirEtag: string
}

/** GET /profiles/:id/stat */
export interface StatQuery {
  root: RootId
  path: string
}
export interface StatResponse {
  entry: FileEntry
}

/** GET /profiles/:id/search */
export interface SearchQuery {
  root: RootId
  path: string
  q: string
}
export interface SearchResponse {
  results: FileEntry[]
  truncated: boolean
  scanned: number
}

export type TextMode = 'edit' | 'tail'
export type TextEol = 'lf' | 'crlf' | 'mixed' | 'none'
export type TextReadOnlyReason = 'protected' | 'rootReadOnly' | 'tail'

/** GET /profiles/:id/text */
export interface TextQuery {
  root: RootId
  path: string
  mode?: TextMode
  tailBytes?: number
}
export interface TextResponse {
  entry: FileEntry
  content: string
  etag: string
  bom: boolean
  eol: TextEol
  masked: boolean
  truncated: boolean
  readOnly: boolean
  readOnlyReason: TextReadOnlyReason | null
  hints: Hint[]
  serverState: ServerState
}

/** PUT /profiles/:id/text (etag null creates the file). */
export interface TextSaveRequest {
  root: RootId
  path: string
  content: string
  etag: string | null
  eol: 'lf' | 'crlf'
  bom: boolean
  confirm: ConfirmToken[]
}
/** 200 (saved) or 201 (created). */
export interface TextSaveResponse {
  entry: FileEntry
  etag: string
  previousVersion: { trashId: string } | null
  restartRequired: boolean
  hints: Hint[]
  backupWarning?: string
}

/** POST /profiles/:id/mkdir; `path` is the parent folder. */
export interface MkdirRequest {
  root: RootId
  path: string
  name: string
  confirm: ConfirmToken[]
}
/** 201 */
export interface EntryResponse {
  entry: FileEntry
}

/** POST /profiles/:id/rename */
export interface RenameRequest {
  root: RootId
  path: string
  newName: string
  confirm: ConfirmToken[]
}

export interface FailedItem {
  path: string
  code: string
  params?: Record<string, unknown>
}

/** POST /profiles/:id/move */
export interface MoveRequest {
  root: RootId
  paths: string[]
  destDir: string
  confirm: ConfirmToken[]
}
export interface MoveResponse {
  moved: Array<{ from: string; to: string }>
  failed: FailedItem[]
}

/** POST /profiles/:id/copy (201, EntryResponse). */
export interface CopyRequest {
  root: RootId
  path: string
  destDir: string
  newName?: string
  confirm: ConfirmToken[]
}

/** POST /profiles/:id/delete/preview */
export interface DeletePreviewRequest {
  root: RootId
  paths: string[]
}
export interface DeletePreviewItem {
  path: string
  type: FileEntryType
  files: number
  dirs: number
  bytes: number
  truncated: boolean
  worldState: boolean
  containsProtected: boolean
}
export interface DeletePreviewResponse {
  items: DeletePreviewItem[]
  totals: { files: number; dirs: number; bytes: number }
  required: ConfirmToken[]
  trashAvailable: boolean
  trashUnavailableReason?: 'crossDevice' | 'notWritable'
  /** 32 hex characters. */
  previewId: string
  expiresAt: string
}

export type DeleteMode = 'trash' | 'permanent'

/** POST /profiles/:id/delete */
export interface DeleteRequest {
  root: RootId
  previewId: string
  mode: DeleteMode
  confirm: ConfirmToken[]
  typedConfirmation?: string
}
/** mode 'trash' (200). */
export interface DeleteTrashResponse {
  trashed: Array<{ path: string; trashId: string }>
  failed: FailedItem[]
}
/** mode 'permanent' (202), and POST /trash/purge (202). */
export interface JobStartedResponse {
  jobId: string
}

/** POST /profiles/:id/upload/preflight; relPath is a name or sub/dir/name for folder uploads. */
export interface UploadPreflightRequest {
  root: RootId
  dir: string
  files: Array<{ relPath: string; size: number }>
  confirm: ConfirmToken[]
}
export interface UploadPreflightFile {
  relPath: string
  ok: boolean
  willReplace: boolean
  currentEtag?: string
  code?: string
  params?: Record<string, unknown>
}
export interface UploadPreflightResponse {
  files: UploadPreflightFile[]
  required: ConfirmToken[]
  /** Which files need `executable` or `overwrite`, and the server state, when `required` isn't empty. */
  details?: ConfirmationRequiredBody['details']
}

/**
 * POST /profiles/:id/upload: raw body, these headers. X-File-Dir and
 * X-File-Name are encodeURIComponent-encoded; X-File-Confirm is
 * comma-separated.
 */
export const UPLOAD_HEADERS = {
  root: 'X-File-Root',
  dir: 'X-File-Dir',
  name: 'X-File-Name',
  mkdirs: 'X-File-Mkdirs',
  overwriteEtag: 'X-File-Overwrite-Etag',
  confirm: 'X-File-Confirm',
} as const
/** 201 */
export interface UploadResponse {
  entry: FileEntry
  /** null for a secret-bearing file (.ini): no plain hash of its bytes leaves the server. */
  sha256: string | null
  replaced: { trashId: string } | null
}

/** GET /profiles/:id/download: a file stream (headers X-File-Etag, X-File-Masked). */
export interface DownloadQuery {
  root: RootId
  path: string
}

/** POST /profiles/:id/zip: an application/zip stream, or JSON 413 before any byte. */
export interface ZipRequest {
  root: RootId
  paths: string[]
}

/** GET /profiles/:id/trash */
export interface TrashQuery {
  root: RootId
  originalPath?: string
}
export interface TrashListResponse {
  items: TrashItem[]
  totalBytes: number
}

/** POST /profiles/:id/trash/restore (EntryResponse). */
export interface TrashRestoreRequest {
  root: RootId
  trashId: string
  restoreAs?: string
  confirm?: ConfirmToken[]
}

/**
 * POST /profiles/:id/trash/restore with several items at once (Undo of a
 * bulk delete): up to PATHS_PER_REQUEST ids, one confirmation, per-item
 * results.
 */
export interface TrashRestoreManyRequest {
  root: RootId
  trashIds: string[]
  confirm?: ConfirmToken[]
}
export interface TrashRestoreManyResponse {
  restored: Array<{ trashId: string; entry: FileEntry }>
  failed: Array<{ trashId: string; code: string; params?: Record<string, unknown> }>
}

/** POST /profiles/:id/trash/purge (202, JobStartedResponse). */
export interface TrashPurgeRequest {
  root: RootId
  trashIds?: string[]
  all?: true
  typedConfirmation: string
  /** Must include 'permanent', plus anything else the server asks for. */
  confirm: ConfirmToken[]
}

/** PUT /profiles/:id/remote-roots (ProfileResponse). */
export interface RemoteRootsRequest {
  installPath: string | null
  dataPath: string | null
}

export type JobKind = 'permanentDelete' | 'trashPurge'
export type JobState = 'running' | 'done' | 'failed'

/** GET /jobs/:jobId (only the job's owner). */
export interface JobResponse {
  id: string
  kind: JobKind
  state: JobState
  progress: { done: number; total: number | null }
  error?: { code: string; params?: Record<string, unknown> }
}

/** GET /audit?profileId&limit (limit at most 500). */
export interface AuditEntry {
  id: string
  at: string
  actor: { userId: string | null; username: string | null; role: string | null; ip: string | null; userAgent: string | null }
  profileId: string | null
  profileName: string | null
  backend: Backend | null
  rootId: RootId | null
  op: AuditOp
  paths: string[]
  pathsTruncated: boolean
  dest: string | null
  bytes: number | null
  sha256Before: string | null
  sha256After: string | null
  trashIds: string[]
  confirm: ConfirmToken[]
  result: string
  code: string | null
  durationMs: number | null
}
export interface AuditResponse {
  entries: AuditEntry[]
}

// ---- Errors ----

/** Body of an FM_CONFIRMATION_REQUIRED response, with its extra `details`. */
export interface ConfirmationRequiredBody {
  error: string
  code: 'FM_CONFIRMATION_REQUIRED'
  params: { required: ConfirmToken[] }
  details?: {
    serverState?: ServerState
    executable?: { names: string[] }
    overwrite?: { names: string[] }
  }
}

/** GET /profiles/:id/trash/text: an earlier version, decoded like GET /text mode=edit. */
export interface TrashTextQuery {
  root: RootId
  trashId: string
}
export interface TrashTextResponse {
  content: string
  bom: boolean
  eol: TextEol
  masked: boolean
}

export type ZipLimitReason = 'entries' | 'bytes' | 'depth' | 'time'
export type OperationInProgress = 'lifecycle' | 'steam' | 'fileJob'
