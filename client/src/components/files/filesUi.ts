// Shared, non-visual helpers for the Server Files page and its components:
// what opening an entry does, what the operator may do with it, dates, the
// remembered last folder, and a media-query hook. Kept out of the .tsx
// component files so those export components only.
import { useEffect, useState } from 'react'
import i18n from '@/i18n'
import { ApiError } from '@/lib/api'
import { getResultErrorMessage, getUserErrorMessage } from '@/lib/errorMessage'
import { FM_LIMITS, type FileEntry, type RootDescriptor, type RootId } from '@/types/files'
import { joinPath } from '@/lib/filesApi'

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

/** Sealed entries, escaping or broken links and unsupported names open nothing. */
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

const dateFormatters = new Map<string, Intl.DateTimeFormat>()

export function formatFileDate(iso: string | null | undefined, language: string): string {
  if (!iso) return ''
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  let formatter = dateFormatters.get(language)
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' })
    } catch {
      formatter = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
    }
    dateFormatters.set(language, formatter)
  }
  return formatter.format(new Date(time))
}

// ---- Errors ----

/**
 * The operator-facing text for a failed file action: the translated error
 * code when the server sent one (errors:FM_*), else its message, else the
 * file manager's generic "unexpected error" line.
 */
export function describeFilesError(error: unknown): string {
  return getUserErrorMessage(error, i18n.t('FM_INTERNAL', { ns: 'errors' }))
}

/** The same, for a `{ code, params }` the server put in a 2xx body (a failed item of a batch, a failed job). */
export function describeResultError(result: { code?: unknown; params?: unknown } | null | undefined): string {
  return getResultErrorMessage(result, i18n.t('FM_INTERNAL', { ns: 'errors' }))
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
