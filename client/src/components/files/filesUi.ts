// Shared, non-visual helpers for the Server Files page and its components:
// what opening an entry does, what the operator may do with it, dates, the
// remembered last folder, and a media-query hook. Kept out of the .tsx
// component files so those export components only.
import { useEffect, useState } from 'react'
import i18n from '@/i18n'
import { ApiError } from '@/lib/api'
import { getResultErrorMessage, getUserErrorMessage } from '@/lib/errorMessage'
import { FM_LIMITS, type FileEntry, type RootDescriptor, type RootId, type RootUnavailableReason } from '@/types/files'
import { joinPath } from '@/lib/filesApi'
import { formatBytes } from '@/lib/formatBytes'
import { formatDateTime } from '@/lib/dateFormat'

// ---- What an entry is and what it allows ----

export type OpenMode = 'enter' | 'edit' | 'tail' | 'details' | 'blocked'

/** A link that stays inside the root is followed; one that escapes never is. */
export function isFolderLike(entry: FileEntry): boolean {
  if (entry.type === 'dir') return true
  return entry.type === 'link' && entry.link?.inside === true && entry.link.targetType === 'dir'
}

export function escapesRoot(entry: FileEntry): boolean {
  return entry.type === 'link' && entry.link?.inside === false
}

export function isBrokenLink(entry: FileEntry): boolean {
  return entry.type === 'link' && entry.link?.targetType === 'missing'
}

/**
 * Sealed entries, escaping or broken links and unsupported names open nothing.
 * A text file the operator can't change (a read-only root, a read-only
 * protected area) still opens in the editor: GET /text says it is read-only,
 * and the editor shows it that way.
 */
export function openModeFor(entry: FileEntry): OpenMode {
  if (entry.flags.unsupportedName) return 'blocked'
  if (entry.protection?.level === 'sealed') return 'blocked'
  if (escapesRoot(entry) || isBrokenLink(entry)) return 'blocked'
  if (isFolderLike(entry)) return 'enter'
  if (entry.protection?.level === 'listOnly') return 'blocked'
  if (entry.type === 'other') return 'details'
  if (entry.flags.editable) return 'edit'
  if (entry.flags.binaryHint) return 'details'
  if ((entry.size ?? 0) > FM_LIMITS.TEXT_EDIT_MAX_BYTES) return 'tail'
  if (entry.type === 'file') return 'edit'
  return 'details'
}

export function rootIsWritable(root: RootDescriptor | null | undefined): boolean {
  return !!root && root.available && root.writable !== false
}

/**
 * Mutation controls are hidden on read-only roots, protected entries and
 * names the panel can't handle (spec §A2); the server still decides.
 */
export function canMutateEntry(entry: FileEntry, root: RootDescriptor | null | undefined): boolean {
  return rootIsWritable(root) && entry.protection === null && !entry.flags.unsupportedName
}

/** Readable means downloadable: not sealed or list-only, and not an escaping link. */
export function canReadEntry(entry: FileEntry): boolean {
  if (entry.flags.unsupportedName) return false
  if (entry.protection && entry.protection.level !== 'readOnly') return false
  if (escapesRoot(entry) || isBrokenLink(entry)) return false
  return entry.type !== 'other'
}

export function canSelectEntry(entry: FileEntry): boolean {
  return entry.protection?.level !== 'sealed' && !entry.flags.unsupportedName
}

// Display only: the files §A8 calls executable, so a confirmation can name
// them. The server decides which uploads need the `executable` token.
const EXECUTABLE_EXT_RE = /\.(jar|class|dll|so|exe|bat|cmd|ps1|sh)$/i
const EXECUTABLE_NAME_RE = /^(ProjectZomboid(64|32)\.json|StartServer.*\.bat|start-server.*\.sh)$/i

export function looksExecutable(name: string): boolean {
  return EXECUTABLE_EXT_RE.test(name) || EXECUTABLE_NAME_RE.test(name)
}

/** "<base> (copy)<ext>"-style parts for the duplicate dialog. */
export function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot) }
}

// ---- Display ----

/** The root's display path plus the entry's path, in the root's own separator style. */
export function fullDisplayPath(root: RootDescriptor | null | undefined, path: string): string {
  const base = root?.displayPath ?? ''
  if (!path) return base
  const windowsStyle = base.includes('\\') && !base.includes('/')
  const rel = windowsStyle ? path.replace(/\//g, '\\') : path
  if (!base) return rel
  const sep = windowsStyle ? '\\' : '/'
  return base.endsWith(sep) ? `${base}${rel}` : `${base}${sep}${rel}`
}

export function formatFileDate(iso: string | null | undefined, language: string): string {
  return formatDateTime(iso, { language, style: 'medium' })
}

// ---- Errors ----

// Codes whose `limit` param is a byte count, and the one whose `limit` is a
// number of entries: shown formatted for the reader, never as raw digits.
const BYTE_LIMIT_CODES = new Set(['FM_UPLOAD_TOO_LARGE', 'FM_DOWNLOAD_TOO_LARGE', 'FM_FILE_TOO_LARGE_FOR_EDITOR'])
const COUNT_LIMIT_CODES = new Set(['FM_TOO_MANY_ENTRIES'])

// The text for a code the file manager words better than errors.json can
// from the code alone, or null. A zip pre-check that ran out of TIME isn't
// "too large": over SFTP a few dozen folders take that long.
function specialFilesMessage(code: string | undefined, params: Record<string, unknown>): string | null {
  if (code === 'FM_ZIP_TOO_LARGE' && params.reason === 'time') return i18n.t('download.zipTooSlow', { ns: 'files' })
  return null
}

function readableParams(code: string | undefined, params: Record<string, unknown>): Record<string, unknown> {
  const limit = params.limit
  if (typeof limit !== 'number' || !code) return params
  if (BYTE_LIMIT_CODES.has(code)) return { ...params, limit: formatBytes(limit, i18n.language) }
  if (COUNT_LIMIT_CODES.has(code)) return { ...params, limit: new Intl.NumberFormat(i18n.language).format(limit) }
  return params
}

/**
 * The operator-facing text for a failed file action: the translated error
 * code when the server sent one (errors:FM_*), else its message, else the
 * file manager's generic "unexpected error" line. Sizes and counts in its
 * params are formatted for the reader's language.
 */
export function describeFilesError(error: unknown): string {
  if (error instanceof ApiError && typeof error.code === 'string') {
    const params = errorParamsOf(error)
    const special = specialFilesMessage(error.code, params)
    if (special) return special
    const readable = readableParams(error.code, params)
    if (readable !== params) {
      return getResultErrorMessage({ code: error.code, error: error.message, params: readable }, i18n.t('FM_INTERNAL', { ns: 'errors' }))
    }
  }
  return getUserErrorMessage(error, i18n.t('FM_INTERNAL', { ns: 'errors' }))
}

/** The same, for a `{ code, params }` the server put in a 2xx body (a failed item of a batch, a failed job). */
export function describeResultError(result: { code?: unknown; params?: unknown } | null | undefined): string {
  const code = typeof result?.code === 'string' ? result.code : undefined
  const params = result?.params && typeof result.params === 'object' ? (result.params as Record<string, unknown>) : {}
  const special = specialFilesMessage(code, params)
  if (special) return special
  return getResultErrorMessage(result ? { ...result, params: readableParams(code, params) } : result, i18n.t('FM_INTERNAL', { ns: 'errors' }))
}

/**
 * Why a folder can't be opened. For an SFTP login that fails, the server
 * names the failure (unavailableDetail: SFTP_AUTH_FAILED, SFTP_UNREACHABLE,
 * SFTP_CHROOTED_ACCOUNT...): its errors:SFTP_* guidance follows, so a wrong
 * password doesn't read the same as a firewalled host.
 */
export function unavailableText(reason: RootUnavailableReason, detail?: string): string {
  const base = i18n.t(`roots.unavailable.${reason}`, { ns: 'files', detail: detail ?? '' })
  if (reason !== 'sftpUnreachable' || !detail) return base
  const code = detail === 'SFTP_TIMEOUT' ? 'SFTP_UNREACHABLE' : detail
  if (!/^SFTP_[A-Z_]+$/.test(code) || !i18n.exists(code, { ns: 'errors' })) return base
  return i18n.t(code, { ns: 'errors', detail: base })
}

/**
 * `items` without repeats and without anything inside another item that
 * `holds` things (a folder, which a delete or move takes along with what is
 * in it). Search results can hold a folder and a file inside it. The server
 * does the same within one request, but a selection sent in parts needs it
 * first: otherwise a later part names something an earlier part already
 * took along, and fails whole.
 */
export function withoutNested<T>(items: T[], pathOf: (item: T) => string, holds: (item: T) => boolean): T[] {
  const holders = new Set(items.filter(holds).map(pathOf))
  const seen = new Set<string>()
  return items.filter((item) => {
    const path = pathOf(item)
    if (seen.has(path)) return false
    seen.add(path)
    for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
      if (holders.has(path.slice(0, cut))) return false
    }
    return true
  })
}

/** The deepest folder every path sits in ("" is the root). */
export function commonFolder(paths: string[]): string {
  if (paths.length === 0) return ''
  const folders = paths.map((path) => {
    const index = path.lastIndexOf('/')
    return index === -1 ? [] : path.slice(0, index).split('/')
  })
  const common: string[] = []
  for (let i = 0; i < folders[0].length; i++) {
    const segment = folders[0][i]
    if (!folders.every((parts) => parts[i] === segment)) break
    common.push(segment)
  }
  return common.join('/')
}

export function errorCodeOf(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined
}

export function errorParamsOf(error: unknown): Record<string, unknown> {
  if (!(error instanceof ApiError) || !error.data || typeof error.data !== 'object') return {}
  const params = (error.data as { params?: unknown }).params
  return params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
}

// ---- The last folder visited, per profile and root ----
//
// Only the folder path is remembered, never file content. Storage can be
// missing or throw (private windows, blocked site data); every access is
// wrapped so the page works the same without it.

export function lastFolderKey(profileId: string, rootId: RootId): string {
  return `zcp-files-last:${profileId}:${rootId}`
}

export function readLastFolder(profileId: string, rootId: RootId): string | null {
  try {
    return window.localStorage.getItem(lastFolderKey(profileId, rootId))
  } catch {
    return null
  }
}

export function writeLastFolder(profileId: string, rootId: RootId, path: string): void {
  try {
    window.localStorage.setItem(lastFolderKey(profileId, rootId), path)
  } catch {
    // Remembering the folder is a convenience; the page works without it.
  }
}

export function childPath(dir: string, entry: Pick<FileEntry, 'name'>): string {
  return joinPath(dir, entry.name)
}

// ---- Layout ----

const DESKTOP_QUERY = '(min-width: 768px)'

/**
 * True at Tailwind's `md` breakpoint and up. jsdom and old browsers have no
 * matchMedia; those count as desktop.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function' ? true : window.matchMedia(DESKTOP_QUERY).matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(DESKTOP_QUERY)
    const update = () => setIsDesktop(mq.matches)
    update()
    mq.addEventListener?.('change', update)
    return () => mq.removeEventListener?.('change', update)
  }, [])
  return isDesktop
}
