import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, FolderTree, Keyboard, Loader2, Lock, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState, type EmptyStateAction } from '@/components/EmptyState'
import { HelpTip } from '@/components/HelpTip'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { useAuth } from '@/contexts/AuthContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useSocket } from '@/contexts/SocketContext'
import { ApiError } from '@/lib/api'
import {
  baseName,
  downloadFile,
  downloadZip,
  filesApi,
  hasServerRunningAck,
  joinPath,
  parentPath,
  rememberServerRunningAck,
  waitForJob,
  withConfirmations,
} from '@/lib/filesApi'
import { formatBytes } from '@/lib/formatBytes'
import { isolateLtrForRtl } from '@/lib/paramTranslation'
import { copyText } from '@/lib/utils'
import {
  FM_LIMITS,
  type ConfirmToken,
  type ConfirmationRequiredBody,
  type DeletePreviewResponse,
  type FileEntry,
  type ListResponse,
  type ListSort,
  type ProfileFiles,
  type RootDescriptor,
  type RootId,
  type RootUnavailableReason,
  type SortOrder,
} from '@/types/files'
import { BulkBar } from '@/components/files/BulkBar'
import { DropOverlay } from '@/components/files/DropOverlay'
import { FileBreadcrumb } from '@/components/files/FileBreadcrumb'
import { FileDetailsPopover } from '@/components/files/FileDetailsPopover'
import { FileEditorDialog, type RunConfirmed } from '@/components/files/FileEditorDialog'
import { FileList } from '@/components/files/FileList'
import type { RowAction } from '@/components/files/FileRowMenu'
import { FileToolbar } from '@/components/files/FileToolbar'
import { MoveDialog } from '@/components/files/MoveDialog'
import { NameDialog } from '@/components/files/NameDialog'
import { RecentChanges } from '@/components/files/RecentChanges'
import { RemoteRootsDialog } from '@/components/files/RemoteRootsDialog'
import { RootList, RootSelect, ServerPicker } from '@/components/files/RootList'
import { ServerStateAlert } from '@/components/files/ServerStateAlert'
import { TailViewer } from '@/components/files/TailViewer'
import { TrashView } from '@/components/files/TrashView'
import { UploadQueue, UploadReplaceDialog, type ReplaceChoice } from '@/components/files/UploadQueue'
import { validateSegments } from '@/components/files/nameRules'
import {
  canMutateEntry,
  canReadEntry,
  canSelectEntry,
  commonFolder,
  describeFilesError,
  describeResultError,
  errorCodeOf,
  errorParamsOf,
  fullDisplayPath,
  isFolderLike,
  looksExecutable,
  openModeFor,
  readLastFolder,
  rootIsWritable,
  splitExtension,
  unavailableText,
  useIsDesktop,
  withoutNested,
  writeLastFolder,
} from '@/components/files/filesUi'
import {
  pickedFromDrop,
  pickedFromInput,
  useUploadQueue,
  type PickedFile,
  type UploadItem,
  type UploadJob,
} from '@/components/files/useUploadQueue'

// Server Files (spec §A14): browse and change the files in each server's
// game install, launch, Zomboid and server-settings folders, locally, through
// Docker mounts, or over SFTP for the active remote server.
//
// Where you are lives in the URL (/files?server=&root=&path=&open=), so a
// link opens the same folder or file. `open` names a file relative to
// `path`; opening one pushes a history entry, so the Back button closes the
// editor (through its unsaved-changes guard) instead of leaving the page.
// The last folder per server and root is remembered in localStorage; file
// content never is.

const ROOT_PREFERENCE: RootId[] = ['data', 'config', 'install', 'launch']
const LARGE_DOWNLOAD_BYTES = 200 * 1024 * 1024
const SFTP_ERROR_CODES = new Set(['FM_SFTP_ERROR', 'FM_SFTP_TIMEOUT'])
const ACCESS_ERROR_CODES = new Set(['PERMISSION_DENIED', 'AUTH_REQUIRED', 'HTTP_403'])

type FileView = { kind: 'edit' | 'tail' | 'details'; entry: FileEntry }
// A new file or folder goes into the folder shown when the dialog OPENED:
// Back while it is open changes the folder behind it (on a phone the dialog
// covers the page), not where the name lands.
type NameDialogState =
  | { kind: 'newFile'; dir: string }
  | { kind: 'newFolder'; dir: string }
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'duplicate'; entry: FileEntry }
type JobLine = { done: number; total: number | null } | null
type ReplacePrompt = { folder: string; names: string[]; resolve: (choice: ReplaceChoice) => void }

// The server takes at most this many paths per delete, move or zip request.
const PATHS_PER_REQUEST = FM_LIMITS.PATHS_PER_REQUEST

function inChunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// An upload pre-check stats every file it names. Over SFTP that is a round
// trip or more per file, so a big batch gets longer than the 30 s default
// before the page gives up on it.
function preflightTimeout(root: RootDescriptor, files: number): number | undefined {
  if (root.backend !== 'sftp') return undefined
  return Math.min(300_000, 30_000 + 150 * files)
}

interface Location {
  server: string | null
  root: string | null
  path: string | null
  open: string | null
}

function buildSearch(location: Location): string {
  const params = new URLSearchParams()
  if (location.server) params.set('server', location.server)
  if (location.root) params.set('root', location.root)
  // Kept even when empty: "path=" is the root itself, while no `path` at
  // all means "the last folder visited here".
  if (location.path !== null) params.set('path', location.path)
  if (location.open) params.set('open', location.open)
  const search = params.toString()
  return search ? `?${search}` : ''
}

function defaultRoot(profile: ProfileFiles): RootId | null {
  for (const id of ROOT_PREFERENCE) {
    if (profile.roots.some((root) => root.id === id && root.available)) return id
  }
  return profile.roots[0]?.id ?? null
}

function validPath(value: string | null): string | null {
  if (value === null) return null
  const result = validateSegments(value)
  return result.ok ? value : null
}

function relativeTo(dir: string, path: string): string {
  if (!dir) return path
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path
}

function isAccessError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  return error.status === 403 && (error.code === undefined || ACCESS_ERROR_CODES.has(error.code))
}

export default function Files() {
  const { t, i18n } = useTranslation('files')
  const { can } = useAuth()
  const confirm = useConfirm()
  const { toast } = useToast()
  const socket = useSocket()
  const navigate = useNavigate()
  const location = useLocation()
  const isDesktop = useIsDesktop()
  const canManage = can('files.manage')
  const canSetRemote = can('bridge.setup')

  const params = useMemo(() => new URLSearchParams(location.search), [location.search])
  const paramServer = params.get('server')
  const paramRoot = params.get('root')
  const paramPath = params.get('path')
  const paramOpen = params.get('open')

  // ---- Profiles ----
  const [profiles, setProfiles] = useState<ProfileFiles[] | null>(null)
  const [pageError, setPageError] = useState<unknown>(null)
  const [profile, setProfile] = useState<ProfileFiles | null>(null)
  const [profileError, setProfileError] = useState<unknown>(null)
  const [checkingState, setCheckingState] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const profileRequestRef = useRef(0)

  const selectedProfileId = useMemo(() => {
    if (!profiles || profiles.length === 0) return null
    if (paramServer && profiles.some((p) => p.id === paramServer)) return paramServer
    return (profiles.find((p) => p.isActive) ?? profiles[0]).id
  }, [paramServer, profiles])

  const rootId: RootId | null = useMemo(() => {
    if (!profile) return null
    if (paramRoot && profile.roots.some((root) => root.id === paramRoot)) return paramRoot as RootId
    return defaultRoot(profile)
  }, [paramRoot, profile])

  const root: RootDescriptor | null = profile?.roots.find((r) => r.id === rootId) ?? null
  const currentPath = useMemo(() => {
    const fromUrl = validPath(paramPath)
    if (fromUrl !== null) return fromUrl
    if (!profile || !rootId) return ''
    return validPath(readLastFolder(profile.id, rootId)) ?? ''
  }, [paramPath, profile, rootId])

  const profileIdRef = useRef<string | null>(null)
  profileIdRef.current = profile?.id ?? null
  const selectedProfileIdRef = useRef<string | null>(null)
  selectedProfileIdRef.current = selectedProfileId
  const hasProfilesRef = useRef(false)
  hasProfilesRef.current = profiles !== null
  // Where the page is now. A result that arrives for somewhere else (a job
  // or an Undo that finishes after the operator moved on, a slow search, a
  // "Load more") is dropped instead of replacing what is shown.
  const locationKey = `${profile?.id ?? ''}|${rootId ?? ''}|${currentPath}`
  const locationKeyRef = useRef(locationKey)
  locationKeyRef.current = locationKey

  // A refresh of what is already shown (another admin switched the active
  // server, "Check again", a change just made) that fails keeps it on screen
  // and says so in a toast: replacing the page with an error would unmount an
  // open editor and lose its unsaved text. Only a first load, or a switch to
  // another server, turns into the error page.
  const loadProfiles = useCallback(async () => {
    setPageError(null)
    try {
      const result = await filesApi.listProfiles()
      setProfiles(result.profiles)
    } catch (error) {
      if (hasProfilesRef.current) {
        toast({ variant: 'destructive', title: describeFilesError(error) })
        return
      }
      setProfiles(null)
      setPageError(error)
    }
  }, [toast])

  const loadProfile = useCallback(async (id: string, fresh = false) => {
    // A late refresh of a server the operator has switched away from must
    // not bring it back.
    if (selectedProfileIdRef.current && id !== selectedProfileIdRef.current) return
    const requestId = ++profileRequestRef.current
    setProfileError(null)
    try {
      const result = await filesApi.getProfile(id, { fresh })
      // A later request (another server picked meanwhile) wins.
      if (requestId === profileRequestRef.current && id === selectedProfileIdRef.current) setProfile(result.profile)
    } catch (error) {
      if (requestId !== profileRequestRef.current) return
      if (profileIdRef.current === id) {
        toast({ variant: 'destructive', title: describeFilesError(error) })
        return
      }
      setProfileError(error)
    }
  }, [toast])

  useEffect(() => {
    if (canManage) void loadProfiles()
  }, [canManage, loadProfiles])

  useEffect(() => {
    if (!selectedProfileId) return
    setProfile((current) => (current && current.id === selectedProfileId ? current : null))
    void loadProfile(selectedProfileId)
  }, [loadProfile, selectedProfileId])

  // The active server changed elsewhere: which remote profile is browsable,
  // and the Active badges, follow it. The folder shown stays put.
  useEffect(() => {
    if (!socket) return
    const handler = () => {
      void loadProfiles()
      if (profileIdRef.current) void loadProfile(profileIdRef.current)
    }
    socket.on('activeServerChanged', handler)
    return () => {
      socket.off('activeServerChanged', handler)
    }
  }, [loadProfile, loadProfiles, socket])

  // ---- Location (URL) ----
  const goTo = useCallback((next: Partial<Location>, options?: { replace?: boolean }) => {
    const target: Location = {
      server: next.server !== undefined ? next.server : selectedProfileId ?? profile?.id ?? paramServer,
      root: next.root !== undefined ? next.root : rootId,
      path: next.path !== undefined ? next.path : currentPath,
      open: next.open !== undefined ? next.open : null,
    }
    navigate({ search: buildSearch(target) }, { replace: options?.replace })
  }, [currentPath, navigate, paramServer, profile?.id, rootId, selectedProfileId])

  // Make the URL say where we are once it's known (replace, not push). Not
  // while another server is being loaded: the profile shown is still the
  // previous one, and writing its id back would undo the switch.
  useEffect(() => {
    if (!profile || !rootId || profile.id !== selectedProfileId) return
    if (paramServer === profile.id && paramRoot === rootId && (paramPath ?? '') === currentPath) return
    navigate({ search: buildSearch({ server: profile.id, root: rootId, path: currentPath, open: paramOpen }) }, { replace: true })
  }, [currentPath, navigate, paramOpen, paramPath, paramRoot, paramServer, profile, rootId, selectedProfileId])

  // ---- Listing ----
  const [view, setView] = useState<'files' | 'trash'>('files')
  const [trashRefreshKey, setTrashRefreshKey] = useState(0)
  const [listing, setListing] = useState<ListResponse | null>(null)
  const [listError, setListError] = useState<unknown>(null)
  const [listLoading, setListLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [sort, setSort] = useState<ListSort>('name')
  const [order, setOrder] = useState<SortOrder>('asc')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<{ q: string; results: FileEntry[]; truncated: boolean } | null>(null)
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [auditKey, setAuditKey] = useState(0)
  const listRequestRef = useRef(0)

  // Keyed on ids, not the profile object: a profile refresh (after every
  // change, "Check again", another server going active) must not list the
  // folder a second time.
  const listProfileId = profile?.id ?? null
  const listRootAvailable = !!root?.available
  const loadListing = useCallback(async (options?: { keepSelection?: boolean }) => {
    if (!listProfileId || !rootId || !listRootAvailable) return
    // Called from a closure made for another folder (a refresh after a job
    // that outlived the folder it was started in): nothing to do here.
    if (`${listProfileId}|${rootId}|${currentPath}` !== locationKeyRef.current) return
    const requestId = ++listRequestRef.current
    setListLoading(true)
    setListError(null)
    try {
      const result = await filesApi.list(listProfileId, {
        root: rootId,
        path: currentPath,
        offset: 0,
        limit: FM_LIMITS.LIST_PAGE_DEFAULT,
        sort,
        order,
      })
      if (requestId !== listRequestRef.current) return
      setListing(result)
      if (!options?.keepSelection) setSelected(new Set())
      writeLastFolder(listProfileId, rootId, currentPath)
      if (result.sortLimited && sort !== 'name') setSort('name')
    } catch (error) {
      if (requestId !== listRequestRef.current) return
      setListing(null)
      setListError(error)
    } finally {
      if (requestId === listRequestRef.current) setListLoading(false)
    }
  }, [currentPath, listProfileId, listRootAvailable, order, rootId, sort])

  useEffect(() => {
    setSearch(null)
    setQuery('')
    setSelected(new Set())
    setListing(null)
    setSearching(false)
  }, [profile?.id, rootId, currentPath])

  useEffect(() => {
    if (view !== 'files') return
    void loadListing()
  }, [loadListing, view])

  const loadMore = async () => {
    if (!profile || !root || !listing || loadingMore) return
    const key = locationKeyRef.current
    const requestId = listRequestRef.current
    setLoadingMore(true)
    try {
      const result = await filesApi.list(profile.id, {
        root: root.id,
        path: currentPath,
        offset: listing.entries.length,
        limit: FM_LIMITS.LIST_PAGE_DEFAULT,
        sort,
        order,
      })
      // Another folder (or a fresh listing of this one) since: not ours.
      if (key !== locationKeyRef.current || requestId !== listRequestRef.current) return
      if (result.dirEtag !== listing.dirEtag) {
        // The folder changed underneath the pages already shown: start over.
        await loadListing({ keepSelection: true })
        return
      }
      setListing({ ...result, entries: [...listing.entries, ...result.entries], offset: 0 })
    } catch (error) {
      if (key === locationKeyRef.current) toast({ variant: 'destructive', title: describeFilesError(error) })
    } finally {
      setLoadingMore(false)
    }
  }

  const searchRef = useRef<{ q: string } | null>(null)
  searchRef.current = search

  const searchRequestRef = useRef(0)

  // Also runs long after the change that asked for it (a permanent delete's
  // job, an Undo): loadListing and loadProfile ignore a place the page has
  // left, and so does the search refresh.
  const refreshAfterChange = useCallback(async () => {
    setAuditKey((key) => key + 1)
    if (profile) void loadProfile(profile.id)
    if (view !== 'files') return
    const key = `${profile?.id ?? ''}|${rootId ?? ''}|${currentPath}`
    await loadListing({ keepSelection: false })
    // Search results would still show what was just moved or deleted.
    const active = searchRef.current
    if (active && profile && root && key === locationKeyRef.current) {
      const requestId = ++searchRequestRef.current
      try {
        const result = await filesApi.search(profile.id, { root: root.id, path: currentPath, q: active.q })
        if (key !== locationKeyRef.current || requestId !== searchRequestRef.current) return
        setSearch((current) => (current && current.q === active.q ? { q: active.q, results: result.results, truncated: result.truncated } : current))
      } catch {
        if (key === locationKeyRef.current && requestId === searchRequestRef.current) setSearch(null)
      }
    }
  }, [currentPath, loadListing, loadProfile, profile, root, rootId, view])

  const runSearch = async () => {
    const q = query.trim()
    if (!profile || !root || q.length < 2) return
    const key = locationKeyRef.current
    const requestId = ++searchRequestRef.current
    setSearching(true)
    try {
      const result = await filesApi.search(profile.id, { root: root.id, path: currentPath, q: q.slice(0, 100) })
      // The operator moved to another folder (or searched again) meanwhile.
      if (key !== locationKeyRef.current || requestId !== searchRequestRef.current) return
      setSearch({ q, results: result.results, truncated: result.truncated })
      setSelected(new Set())
    } catch (error) {
      if (key !== locationKeyRef.current || requestId !== searchRequestRef.current) return
      toast({ variant: 'destructive', title: describeFilesError(error) })
    } finally {
      if (requestId === searchRequestRef.current) setSearching(false)
    }
  }

  const clearQuery = () => {
    setQuery('')
    setSearch(null)
  }

  const visibleEntries = useMemo(() => {
    if (search) return search.results
    const entries = listing?.entries ?? []
    const needle = query.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter((entry) => entry.name.toLowerCase().includes(needle))
  }, [listing, query, search])

  const selectedEntries = useMemo(
    () => visibleEntries.filter((entry) => selected.has(entry.path)),
    [selected, visibleEntries],
  )

  // ---- Confirmations (spec §A8) ----
  const formatNames = useCallback((names: string[] | undefined, fallback: string[] | undefined) => {
    const list = names && names.length > 0 ? names : fallback ?? []
    if (list.length === 0) return '…'
    const shown = list.slice(0, 5).map(isolateLtrForRtl).join(', ')
    return list.length > 5 ? `${shown}, …` : shown
  }, [])

  const askConfirmation = useCallback(async (body: ConfirmationRequiredBody, fallbackNames?: string[]) => {
    const required = body.params.required
    const lines = required.map((token) => {
      switch (token) {
        case 'serverRunning':
          return body.details?.serverState === 'unknown' ? t('confirm.tokens.serverStateUnknown') : t('confirm.tokens.serverRunning')
        case 'overwrite':
          return t('confirm.tokens.overwrite', { names: formatNames(body.details?.overwrite?.names, fallbackNames) })
        case 'executable':
          return t('confirm.tokens.executable', { names: formatNames(body.details?.executable?.names, fallbackNames) })
        case 'permanent':
          return t('confirm.tokens.permanent')
        default:
          return ''
      }
    }).filter(Boolean)
    const warning = required.includes('executable') || required.includes('serverRunning')
    return confirm({
      title: t('confirm.changeTitle'),
      description: lines.join('\n\n'),
      confirmLabel: t('confirm.continue'),
      cancelLabel: t('actions.cancel'),
      ...(warning ? { variant: 'warning' as const } : { destructive: false }),
    })
  }, [confirm, formatNames, t])

  const runConfirmed: RunConfirmed = useCallback((run, options) => {
    const profileId = profileIdRef.current
    const initial: ConfirmToken[] = [...(options?.initial ?? [])]
    if (profileId && hasServerRunningAck(profileId) && !initial.includes('serverRunning')) initial.push('serverRunning')
    return withConfirmations(run, async (body) => {
      const ok = await askConfirmation(body, options?.names)
      if (ok && profileId && body.params.required.includes('serverRunning')) rememberServerRunningAck(profileId)
      return ok
    }, initial)
  }, [askConfirmation])

  // ---- Opening files (and the Back button) ----
  const [fileView, setFileView] = useState<FileView | null>(null)
  const [closeSignal, setCloseSignal] = useState(0)
  const pushedOpenRef = useRef(false)
  const fileViewRef = useRef<FileView | null>(null)
  fileViewRef.current = fileView
  // Read when the editor answers a question it asked a while ago: its
  // callbacks can come from a render before `open` went back in the URL.
  const paramOpenRef = useRef(paramOpen)
  paramOpenRef.current = paramOpen

  const showFile = useCallback((entry: FileEntry, kind: FileView['kind']) => {
    setFileView({ kind, entry })
    pushedOpenRef.current = true
    goTo({ open: relativeTo(currentPath, entry.path) })
  }, [currentPath, goTo])

  const closeFileView = useCallback(() => {
    setFileView(null)
    if (!paramOpenRef.current) return
    if (pushedOpenRef.current) {
      pushedOpenRef.current = false
      navigate(-1)
    } else {
      goTo({ open: null }, { replace: true })
    }
  }, [goTo, navigate])

  // Back pressed while a file is open: the URL lost `open`. The editor asks
  // before discarding; the others just close.
  const lastParamOpen = useRef(paramOpen)
  useEffect(() => {
    const previous = lastParamOpen.current
    lastParamOpen.current = paramOpen
    if (previous && !paramOpen && fileViewRef.current) {
      pushedOpenRef.current = false
      if (fileViewRef.current.kind === 'edit') setCloseSignal((n) => n + 1)
      else setFileView(null)
    }
  }, [paramOpen])

  // The editor is asking before it closes (or a save is): `open` goes back
  // in the URL now, so a second Back while it asks (a double click on the
  // mouse's back button, Android's back gesture on the prompt) only takes
  // that entry off again, instead of leaving the page and the text with it.
  // Cancel then keeps it; Discard goes back to the folder.
  const putOpenBack = useCallback(() => {
    const current = fileViewRef.current
    if (!current || paramOpenRef.current) return
    pushedOpenRef.current = true
    goTo({ open: relativeTo(currentPath, current.entry.path) })
  }, [currentPath, goTo])

  const handleEditorCloseCancelled = putOpenBack

  const handleEditorClosed = useCallback(() => {
    closeFileView()
  }, [closeFileView])

  const openEntry = useCallback((entry: FileEntry) => {
    const mode = openModeFor(entry)
    if (mode === 'blocked') return
    if (mode === 'enter') {
      setView('files')
      goTo({ path: entry.path })
      return
    }
    showFile(entry, mode === 'edit' ? 'edit' : mode === 'tail' ? 'tail' : 'details')
  }, [goTo, showFile])

  // A deep link with `open=`: find the file, then make sure Back returns to
  // the folder rather than off the page.
  const deepLinkHandledRef = useRef<string | null>(null)
  useEffect(() => {
    if (!profile || !root || !root.available || !paramOpen || fileViewRef.current) return
    const key = `${profile.id}|${root.id}|${currentPath}|${paramOpen}`
    if (deepLinkHandledRef.current === key) return
    deepLinkHandledRef.current = key
    const target = validPath(joinPath(currentPath, paramOpen))
    if (target === null) {
      goTo({ open: null }, { replace: true })
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const { entry } = await filesApi.stat(profile.id, { root: root.id, path: target })
        if (cancelled) return
        const mode = openModeFor(entry)
        if (mode === 'blocked' || mode === 'enter') {
          goTo({ open: null }, { replace: true })
          return
        }
        goTo({ open: null }, { replace: true })
        showFile(entry, mode === 'edit' ? 'edit' : mode === 'tail' ? 'tail' : 'details')
      } catch (error) {
        if (cancelled) return
        goTo({ open: null }, { replace: true })
        toast({ variant: 'destructive', title: describeFilesError(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currentPath, goTo, paramOpen, profile, root, showFile, toast])

  // ---- Downloads ----
  const downloadEntries = useCallback(async (entries: FileEntry[], options?: { zip?: boolean }) => {
    if (!profile || !root || entries.length === 0) return
    const single = !options?.zip && entries.length === 1 && !isFolderLike(entries[0]) ? entries[0] : null
    try {
      if (single) {
        if ((single.size ?? 0) > LARGE_DOWNLOAD_BYTES) toast({ title: t('download.large') })
        const result = await downloadFile(profile.id, { root: root.id, path: single.path })
        if (result.masked) toast({ title: t('download.masked') })
      } else {
        // One archive per request, and a request names at most this many.
        if (entries.length > PATHS_PER_REQUEST) {
          toast({ variant: 'destructive', title: t('download.zipTooMany', { limit: PATHS_PER_REQUEST }) })
          return
        }
        toast({ title: t('download.preparingZip') })
        await downloadZip(profile.id, { root: root.id, paths: entries.map((entry) => entry.path) })
        if (entries.some((entry) => entry.flags.secretBearing)) toast({ title: t('download.masked') })
      }
      setAuditKey((key) => key + 1)
    } catch (error) {
      const interrupted = error instanceof TypeError || (error instanceof DOMException && error.name === 'AbortError')
      toast({ variant: 'destructive', title: interrupted ? t('download.interrupted') : describeFilesError(error) })
    }
  }, [profile, root, t, toast])

  // ---- Delete (spec §A14.3) ----
  const [jobLine, setJobLine] = useState<JobLine>(null)

  const folderLabel = useMemo(() => {
    const rootLabel = rootId ? t(`roots.labels.${rootId}`) : ''
    return currentPath ? `${rootLabel} / ${isolateLtrForRtl(currentPath)}` : rootLabel
  }, [currentPath, rootId, t])

  // Undo puts everything back in one request per PATHS_PER_REQUEST items:
  // one confirmation, and a bulk delete's worth of restores doesn't run into
  // the per-minute limit on file changes halfway.
  const undoTrash = useCallback(async (trashed: Array<{ path: string; trashId: string }>) => {
    if (!profile || !root) return
    let restored = 0
    let firstFailure: { code: string; params?: Record<string, unknown> } | null = null
    let failedCount = 0
    let accepted: ConfirmToken[] = []
    for (const part of inChunks(trashed, PATHS_PER_REQUEST)) {
      try {
        const result = await runConfirmed((tokens) => {
          accepted = tokens
          return filesApi.trashRestoreMany(profile.id, { root: root.id, trashIds: part.map((item) => item.trashId), confirm: tokens })
        }, { initial: accepted })
        if (!result.ok) break
        restored += result.value.restored.length
        failedCount += result.value.failed.length
        firstFailure ??= result.value.failed[0] ?? null
      } catch (error) {
        toast({ variant: 'destructive', title: describeFilesError(error) })
        break
      }
    }
    if (restored > 0) {
      const first = isolateLtrForRtl(trashed[0].path)
      toast({ title: t('trash.restored', { path: restored > 1 ? `${first} (+${restored - 1})` : first }) })
    }
    if (firstFailure) {
      toast({ variant: 'destructive', title: describeResultError(firstFailure), description: failedCount > 1 ? `+${failedCount - 1}` : undefined })
    }
    await refreshAfterChange()
  }, [profile, refreshAfterChange, root, runConfirmed, t, toast])

  const deleteEntries = useCallback(async (selection: FileEntry[], permanentRequested: boolean) => {
    if (!profile || !root || selection.length === 0) return
    // The server previews (and deletes) at most PATHS_PER_REQUEST paths at a
    // time: a bigger selection is previewed in parts and confirmed once.
    // Whatever a selected folder takes along goes first (search results can
    // hold both), or a part could name what an earlier one already deleted,
    // and its totals would count it twice.
    const entries = withoutNested(selection, (entry) => entry.path, (entry) => entry.type === 'dir')
    const parts: DeletePreviewResponse[] = []
    try {
      for (const part of inChunks(entries, PATHS_PER_REQUEST)) {
        parts.push(await filesApi.deletePreview(profile.id, { root: root.id, paths: part.map((entry) => entry.path) }))
      }
    } catch (error) {
      toast({ variant: 'destructive', title: describeFilesError(error) })
      return
    }
    const items = parts.flatMap((part) => part.items)
    // A folder holding something the panel protects can't be deleted as a
    // whole, whatever is confirmed: say so instead of asking.
    const holding = items.filter((item) => item.containsProtected)
    if (holding.length > 0) {
      toast({
        variant: 'destructive',
        title: t('protected.containsProtected'),
        description: holding.slice(0, 3).map((item) => isolateLtrForRtl(item.path)).join(', ') + (holding.length > 3 ? ` (+${holding.length - 3})` : ''),
      })
      return
    }
    const trashAvailable = parts.every((part) => part.trashAvailable)
    const required = [...new Set(parts.flatMap((part) => part.required))]
    const totals = parts.reduce(
      (sum, part) => ({ files: sum.files + part.totals.files, bytes: sum.bytes + part.totals.bytes }),
      { files: 0, bytes: 0 },
    )
    const permanent = permanentRequested || !trashAvailable
    const count = items.length
    const name = count === 1 ? baseName(items[0].path) : ''
    const size = formatBytes(totals.bytes, i18n.language)
    // Search results can sit in folders below the one shown: name the
    // folder they all share.
    const fromFolder = commonFolder(items.map((item) => item.path))
    const rootLabelText = rootId ? t(`roots.labels.${rootId}`) : ''
    const folder = fromFolder ? `${rootLabelText} / ${isolateLtrForRtl(fromFolder)}` : rootLabelText
    // One item has its own sentence: in some languages "one" also covers
    // 21, 31... (Ukrainian), where the single-item wording would be wrong.
    const sentence = count === 1
      ? t(permanent ? 'confirm.deletePermanentOne' : 'confirm.deleteOne', { name: isolateLtrForRtl(name), size, folder })
      : permanent
        ? t('confirm.deletePermanent', { count, size, files: totals.files })
        : t('confirm.delete', { count, size, files: totals.files, folder })
    const extra: string[] = []
    if (!trashAvailable) extra.push(t('confirm.trashUnavailable'))
    for (const token of required) {
      if (token === 'serverRunning') extra.push(profile.serverState === 'unknown' || profile.remote ? t('confirm.tokens.serverStateUnknown') : t('confirm.tokens.serverRunning'))
    }
    const typedValue = count === 1 ? name : String(count)
    const ok = await confirm({
      title: t('confirm.title'),
      description: [sentence, ...extra].join('\n\n'),
      items: items.slice(0, 10).map((item) => item.path),
      confirmLabel: permanent ? t('actions.deletePermanently') : t('actions.delete'),
      cancelLabel: t('actions.cancel'),
      destructive: true,
      requireTypedConfirmation: permanent ? { value: typedValue, label: t('confirm.typeName', { value: typedValue }) } : undefined,
    })
    if (!ok) return
    if (required.includes('serverRunning')) rememberServerRunningAck(profile.id)
    let accepted: ConfirmToken[] = required.filter((token) => token !== 'permanent')
    try {
      if (permanent) {
        setSelected(new Set())
        // One job per part, run one after the other. The count shown adds up
        // across parts; a total only makes sense for a single part.
        let done = 0
        for (const part of parts) {
          // The server checks each part against its own count (or its one name).
          const partTyped = part.items.length === 1 ? baseName(part.items[0].path) : String(part.items.length)
          const result = await runConfirmed((tokens) => {
            accepted = tokens.filter((token) => token !== 'permanent')
            return filesApi.deletePermanently(profile.id, {
              root: root.id,
              previewId: part.previewId,
              mode: 'permanent',
              confirm: tokens,
              typedConfirmation: partTyped,
            })
          }, { initial: [...accepted, 'permanent'] })
          if (!result.ok) return
          const before = done
          setJobLine({ done: before, total: null })
          const job = await waitForJob(result.value.jobId, (progress) => {
            if (progress.state === 'running') {
              setJobLine({ done: before + progress.progress.done, total: parts.length === 1 ? progress.progress.total : null })
            }
          })
          if (job.state !== 'done') {
            setJobLine(null)
            toast({ variant: 'destructive', title: t('jobs.failed', { error: describeResultError(job.error) }) })
            return
          }
          done += job.progress.done
        }
        setJobLine(null)
        toast({ title: t('jobs.done') })
      } else {
        const trashed: Array<{ path: string; trashId: string }> = []
        const failed: Array<{ path: string; code: string; params?: Record<string, unknown> }> = []
        // A part that fails as a whole (the per-minute delete limit, a
        // change since the check) stops the rest, but what earlier parts
        // already moved to Trash still gets its Undo.
        let partError: unknown = null
        for (const part of parts) {
          try {
            const result = await runConfirmed((tokens) => {
              accepted = tokens
              return filesApi.deleteToTrash(profile.id, {
                root: root.id,
                previewId: part.previewId,
                mode: 'trash',
                confirm: tokens,
              })
            }, { initial: accepted })
            if (!result.ok) break
            trashed.push(...result.value.trashed)
            failed.push(...result.value.failed)
          } catch (error) {
            partError = error
            break
          }
        }
        setSelected(new Set())
        if (trashed.length > 0) {
          toast({
            title: t('trash.undoToast', { count: trashed.length }),
            action: (
              <ToastAction altText={t('trash.undo')} onClick={() => void undoTrash(trashed)}>
                {t('trash.undo')}
              </ToastAction>
            ),
          })
        }
        if (partError) toast({ variant: 'destructive', title: describeFilesError(partError) })
        if (failed.length > 0) {
          toast({ variant: 'destructive', title: describeResultError(failed[0]), description: failed.length > 1 ? `+${failed.length - 1}` : undefined })
        }
      }
    } catch (error) {
      setJobLine(null)
      toast({ variant: 'destructive', title: describeFilesError(error) })
    } finally {
      await refreshAfterChange()
    }
  }, [confirm, i18n.language, profile, refreshAfterChange, root, rootId, runConfirmed, t, toast, undoTrash])

  // ---- Names: new file, new folder, rename, duplicate ----
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null)

  const submitName = useCallback(async (name: string) => {
    if (!profile || !root || !nameDialog) return
    const names = [name]
    if (nameDialog.kind === 'newFolder') {
      const dir = nameDialog.dir
      const result = await runConfirmed((tokens) => filesApi.mkdir(profile.id, { root: root.id, path: dir, name, confirm: tokens }), { names })
      if (!result.ok) return
      setNameDialog(null)
      await refreshAfterChange()
    } else if (nameDialog.kind === 'newFile') {
      const dir = nameDialog.dir
      const result = await runConfirmed((tokens) => filesApi.saveText(profile.id, {
        root: root.id,
        path: joinPath(dir, name),
        content: '',
        etag: null,
        eol: 'lf',
        bom: false,
        confirm: tokens,
      }), { names })
      if (!result.ok) return
      setNameDialog(null)
      await refreshAfterChange()
      if (openModeFor(result.value.entry) === 'edit') showFile(result.value.entry, 'edit')
    } else if (nameDialog.kind === 'rename') {
      const entry = nameDialog.entry
      const result = await runConfirmed((tokens) => filesApi.rename(profile.id, { root: root.id, path: entry.path, newName: name, confirm: tokens }), { names })
      if (!result.ok) return
      setNameDialog(null)
      await refreshAfterChange()
    } else {
      const entry = nameDialog.entry
      const result = await runConfirmed((tokens) => filesApi.copy(profile.id, {
        root: root.id,
        path: entry.path,
        destDir: parentPath(entry.path),
        newName: name,
        confirm: tokens,
      }), { names })
      if (!result.ok) return
      setNameDialog(null)
      await refreshAfterChange()
    }
  }, [nameDialog, profile, refreshAfterChange, root, runConfirmed, showFile])

  // ---- Move ----
  const [movePaths, setMovePaths] = useState<string[] | null>(null)

  const submitMove = useCallback(async (destDir: string) => {
    if (!profile || !root || !movePaths) return
    // At most PATHS_PER_REQUEST paths per request; one confirmation covers
    // the parts after the first. Split in parts, a path inside a selected
    // folder would be moved along with it by one part and reported gone by
    // a later one, so it isn't sent (only a folder can hold another path).
    const selection = movePaths.length > PATHS_PER_REQUEST ? withoutNested(movePaths, (path) => path, () => true) : movePaths
    const failed: Array<{ path: string; code: string; params?: Record<string, unknown> }> = []
    let accepted: ConfirmToken[] = []
    let movedSome = false
    for (const paths of inChunks(selection, PATHS_PER_REQUEST)) {
      const result = await runConfirmed((tokens) => {
        accepted = tokens
        return filesApi.move(profile.id, { root: root.id, paths, destDir, confirm: tokens })
      }, { initial: accepted, names: paths.map(baseName) })
      if (!result.ok) {
        // Declined after an earlier part moved: show where things are now.
        if (movedSome) await refreshAfterChange()
        return
      }
      movedSome = true
      failed.push(...result.value.failed)
    }
    setMovePaths(null)
    setSelected(new Set())
    if (failed.length > 0) {
      toast({ variant: 'destructive', title: describeResultError(failed[0]), description: failed.length > 1 ? `+${failed.length - 1}` : undefined })
    }
    await refreshAfterChange()
  }, [movePaths, profile, refreshAfterChange, root, runConfirmed, toast])

  // ---- Uploads ----
  const prepareRetryRef = useRef<(item: UploadItem) => Promise<Pick<UploadJob, 'overwriteEtag' | 'confirm'> | null>>(async () => null)
  const uploadQueue = useUploadQueue({
    describeError: describeFilesError,
    onDrained: () => {
      void refreshAfterChange()
    },
    prepareRetry: (item) => prepareRetryRef.current(item),
  })
  // "Replace these?" prompts, one at a time: a second batch picked while a
  // first one's prompt is up waits its turn instead of taking its place.
  const [replacePrompts, setReplacePrompts] = useState<ReplacePrompt[]>([])
  const replacePrompt = replacePrompts[0] ?? null
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const replaceTargetRef = useRef<FileEntry | null>(null)

  useEffect(() => {
    // Not a React prop; set on the element so "Upload folder" picks folders.
    folderInputRef.current?.setAttribute('webkitdirectory', '')
  })

  const askReplace = useCallback((folder: string, names: string[]) => new Promise<ReplaceChoice>((resolve) => {
    setReplacePrompts((current) => [...current, { folder, names, resolve }])
  }), [])

  const chooseReplace = useCallback((choice: ReplaceChoice) => {
    setReplacePrompts((current) => {
      current[0]?.resolve(choice)
      return current.slice(1)
    })
  }, [])

  // `dir` defaults to the folder shown (toolbar and drop uploads); Replace
  // by upload names the folder of the file it replaces, which a search
  // result or a deep link can put somewhere else.
  const startUpload = useCallback(async (picked: PickedFile[], options?: { replaceWithoutAsking?: boolean; dir?: string }) => {
    if (!profile || !root || !rootIsWritable(root) || picked.length === 0) return
    if (picked.length > FM_LIMITS.UPLOAD_FILES_PER_BATCH) {
      toast({ variant: 'destructive', title: t('upload.tooMany', { limit: FM_LIMITS.UPLOAD_FILES_PER_BATCH }) })
      return
    }
    const dir = options?.dir ?? currentPath
    let accepted: ConfirmToken[] = []
    let preflight
    try {
      const result = await runConfirmed((tokens) => {
        accepted = tokens
        return filesApi.uploadPreflight(profile.id, {
          root: root.id,
          dir,
          files: picked.map((item) => ({ relPath: item.relPath, size: item.file.size })),
          confirm: tokens,
        }, { timeout: preflightTimeout(root, picked.length) })
      }, { names: picked.map((item) => baseName(item.relPath)) })
      if (!result.ok) return
      preflight = result.value
    } catch (error) {
      toast({ variant: 'destructive', title: describeFilesError(error) })
      return
    }

    const byPath = new Map(preflight.files.map((file) => [file.relPath, file]))
    const ready: Array<{ picked: PickedFile; etag: string | null }> = []
    const replacing: Array<{ picked: PickedFile; etag: string | null }> = []
    const failed: Array<{ picked: PickedFile; error: string }> = []
    for (const item of picked) {
      const check = byPath.get(item.relPath)
      if (!check || !check.ok) failed.push({ picked: item, error: describeResultError(check ?? { code: 'FM_INTERNAL' }) })
      else if (check.willReplace) replacing.push({ picked: item, etag: check.currentEtag ?? null })
      else ready.push({ picked: item, etag: null })
    }

    // One "replace these?" prompt for the whole batch. Answering "Replace all"
    // is the overwrite confirmation; "Skip existing" leaves nothing to
    // overwrite. Replace by upload (one file, chosen on purpose) skips the
    // batch prompt and confirms the overwrite with the token sentence.
    let choice: ReplaceChoice = 'replace'
    if (replacing.length > 0 && !options?.replaceWithoutAsking) {
      choice = await askReplace(folderLabel, replacing.map((item) => item.picked.relPath))
      if (choice === 'cancel') return
      if (choice === 'replace') accepted = [...accepted, 'overwrite']
    }
    const uploads = choice === 'skip' ? ready : [...ready, ...replacing]
    const required = preflight.required.filter((token) => !(choice === 'skip' && token === 'overwrite'))
    const missing = required.filter((token) => !accepted.includes(token))
    if (uploads.length > 0 && missing.length > 0) {
      const ok = await askConfirmation({
        error: '',
        code: 'FM_CONFIRMATION_REQUIRED',
        params: { required: missing },
        details: {
          serverState: preflight.details?.serverState ?? (profile.remote ? 'unknown' : profile.serverState),
          overwrite: { names: replacing.map((item) => baseName(item.picked.relPath)) },
          // The server's list when it sent one; otherwise the §A8 names, for display.
          executable: {
            names:
              preflight.details?.executable?.names ??
              uploads.map((item) => baseName(item.picked.relPath)).filter(looksExecutable),
          },
        },
      }, uploads.map((item) => baseName(item.picked.relPath)))
      if (!ok) return
      if (missing.includes('serverRunning')) rememberServerRunningAck(profile.id)
    }
    const tokens = [...new Set<ConfirmToken>([...accepted, ...required])]
    if (hasServerRunningAck(profile.id) && !tokens.includes('serverRunning')) tokens.push('serverRunning')

    const toJob = (item: PickedFile, etag: string | null): UploadJob => {
      const sub = parentPath(item.relPath)
      return {
        profileId: profile.id,
        root: root.id,
        dir: sub ? joinPath(dir, sub) : dir,
        name: baseName(item.relPath),
        relPath: item.relPath,
        file: item.file,
        mkdirs: sub !== '',
        overwriteEtag: etag,
        confirm: tokens,
      }
    }
    uploadQueue.enqueue(
      uploads.map((item) => toJob(item.picked, item.etag)),
      choice === 'skip' ? replacing.map((item) => item.picked) : [],
      failed.map((item) => ({ job: toJob(item.picked, null), error: item.error })),
    )
  }, [askConfirmation, askReplace, currentPath, folderLabel, profile, root, runConfirmed, t, toast, uploadQueue])

  // "Try again" on a failed upload checks the file afresh first: the batch's
  // preflight may be out of date (the file changed or appeared, the server
  // started), and resending what it said would fail the same way again.
  prepareRetryRef.current = async (item) => {
    // Checked as the batch was: from the folder it was dropped into, with
    // its sub-folders in relPath (they may not exist yet).
    const sub = parentPath(item.relPath)
    const base = !sub ? item.dir : item.dir === sub ? '' : item.dir.slice(0, item.dir.length - sub.length - 1)
    const preflight = await filesApi.uploadPreflight(item.profileId, {
      root: item.root,
      dir: base,
      files: [{ relPath: item.relPath, size: item.file.size }],
      confirm: item.confirm,
    }, { timeout: root ? preflightTimeout(root, 1) : undefined })
    const check = preflight.files[0]
    if (!check) return null
    if (!check.ok) throw new ApiError(describeResultError(check), { code: check.code, data: { params: check.params } })
    const missing = preflight.required.filter((token) => !item.confirm.includes(token))
    if (missing.length > 0) {
      const ok = await askConfirmation({
        error: '',
        code: 'FM_CONFIRMATION_REQUIRED',
        params: { required: missing },
        details: {
          ...preflight.details,
          serverState: preflight.details?.serverState ?? (profile?.remote ? 'unknown' : profile?.serverState),
          overwrite: { names: [item.name] },
          executable: { names: preflight.details?.executable?.names ?? (looksExecutable(item.name) ? [item.name] : []) },
        },
      }, [item.name])
      if (!ok) return null
      if (missing.includes('serverRunning')) rememberServerRunningAck(item.profileId)
    }
    return {
      overwriteEtag: check.willReplace ? check.currentEtag ?? null : null,
      confirm: [...new Set<ConfirmToken>([...item.confirm, ...preflight.required])],
    }
  }

  // Leaving mid-upload would cut the uploads off.
  useEffect(() => {
    if (!uploadQueue.active) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [uploadQueue.active])

  // ---- Drag and drop (desktop only) ----
  const [dragActive, setDragActive] = useState(false)
  // A protected folder (World Backups, the bridge's folder) takes no new
  // files, whatever the root allows.
  const folderProtection = listing?.dir.protection ?? null
  const folderWritable = rootIsWritable(root) && folderProtection === null
  const dropEnabled = isDesktop && view === 'files' && folderWritable
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')

  // A file dropped anywhere else on the page (or on the list where it can't
  // go) would make the browser open or download it in place of the panel.
  useEffect(() => {
    const guard = (event: globalThis.DragEvent) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes('Files') || event.defaultPrevented) return
      event.preventDefault()
      if (event.type === 'dragover' && event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', guard)
    window.addEventListener('drop', guard)
    return () => {
      window.removeEventListener('dragover', guard)
      window.removeEventListener('drop', guard)
    }
  }, [])

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!dropEnabled || !hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (!dragActive) setDragActive(true)
  }
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!dragActive) return
    const next = event.relatedTarget as Node | null
    if (next && event.currentTarget.contains(next)) return
    setDragActive(false)
  }
  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    if (!dropEnabled || !hasFiles(event)) return
    event.preventDefault()
    setDragActive(false)
    const picked = await pickedFromDrop(event.dataTransfer, FM_LIMITS.UPLOAD_FILES_PER_BATCH)
    await startUpload(picked)
  }

  // ---- Row actions ----
  const handleRowAction = useCallback((action: RowAction, entry: FileEntry) => {
    switch (action) {
      case 'open':
        openEntry(entry)
        break
      case 'download':
        if (canReadEntry(entry)) void downloadEntries([entry])
        break
      case 'rename':
        if (canMutateEntry(entry, root)) setNameDialog({ kind: 'rename', entry })
        break
      case 'move':
        if (canMutateEntry(entry, root)) setMovePaths([entry.path])
        break
      case 'duplicate':
        if (canMutateEntry(entry, root)) setNameDialog({ kind: 'duplicate', entry })
        break
      case 'copyPath':
        void copyText(fullDisplayPath(root, entry.path)).then((ok) => {
          if (ok) toast({ title: t('page.pathCopied') })
        })
        break
      case 'delete':
        if (canMutateEntry(entry, root)) void deleteEntries([entry], false)
        break
      case 'deletePermanently':
        if (canMutateEntry(entry, root)) void deleteEntries([entry], true)
        break
    }
  }, [deleteEntries, downloadEntries, openEntry, root, t, toast])

  const toggleSelect = useCallback((entry: FileEntry) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
  }, [])

  const selectAll = useCallback((select: boolean) => {
    if (!select) {
      setSelected(new Set())
      return
    }
    setSelected(new Set(visibleEntries.filter(canSelectEntry).map((entry) => entry.path)))
  }, [visibleEntries])

  const goToParent = useCallback(() => {
    if (!currentPath) return
    goTo({ path: parentPath(currentPath) })
  }, [currentPath, goTo])

  const handleDeleteKey = useCallback((permanent: boolean, active: FileEntry | null) => {
    const targets = selectedEntries.length > 0 ? selectedEntries : active ? [active] : []
    if (targets.length === 0 || !targets.every((entry) => canMutateEntry(entry, root))) return
    void deleteEntries(targets, permanent)
  }, [deleteEntries, root, selectedEntries])

  const selectionCanMutate = selectedEntries.length > 0 && selectedEntries.every((entry) => canMutateEntry(entry, root))
  const selectionCanDownload = selectedEntries.length > 0 && selectedEntries.every(canReadEntry)

  // ---- Rendering ----
  const header = (
    <PageHeader
      title={t('page.title')}
      description={t('page.description')}
      eyebrow={t('page.eyebrow')}
      tone="config"
      icon={<FolderTree className="h-5 w-5" aria-hidden="true" />}
      actions={
        profile ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void loadProfile(profile.id)
              if (view === 'files') void loadListing({ keepSelection: true })
              else setTrashRefreshKey((key) => key + 1)
            }}
            disabled={listLoading}
          >
            {listLoading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            {t('page.refresh')}
          </Button>
        ) : undefined
      }
    />
  )

  const accessDenied = (
    <Card>
      <CardContent className="pt-6">
        <EmptyState type="accessDenied" title={t('access.denied')} />
      </CardContent>
    </Card>
  )

  // Logins can only be off when db.json says authEnabled: false (no page
  // turns them on or off), so this says how to undo that instead of linking
  // to Panel Settings, which has no such switch.
  const authDisabled = (
    <Card>
      <CardContent className="pt-6">
        <EmptyState type="accessDenied" title={t('access.authDisabled')} description={t('access.authDisabledHow')} />
      </CardContent>
    </Card>
  )

  const pageLevelError = (error: unknown, retry: () => void) => {
    if (errorCodeOf(error) === 'FM_AUTH_DISABLED') return authDisabled
    if (isAccessError(error)) return accessDenied
    return (
      <Card>
        <CardContent className="pt-6">
          <EmptyState type="noData" title={describeFilesError(error)} action={{ label: t('actions.retry'), onClick: retry }} />
        </CardContent>
      </Card>
    )
  }

  if (!canManage) {
    return (
      <div className="space-y-5">
        {header}
        {accessDenied}
      </div>
    )
  }

  if (pageError) {
    return (
      <div className="space-y-5">
        {header}
        {pageLevelError(pageError, () => void loadProfiles())}
      </div>
    )
  }

  if (profiles === null || (selectedProfileId && !profile && !profileError)) {
    return (
      <div className="space-y-5">
        {header}
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-label={t('page.title')} />
        </div>
      </div>
    )
  }

  if (profiles.length === 0) {
    return (
      <div className="space-y-5">
        {header}
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              type="serverOffline"
              title={t('nav.noServerBanner.title', { ns: 'shell' })}
              description={t('nav.noServerBanner.description', { ns: 'shell' })}
              action={{ label: t('nav.noServerBanner.cta', { ns: 'shell' }), to: '/servers' }}
            />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (profileError || !profile) {
    return (
      <div className="space-y-5">
        {header}
        {pageLevelError(profileError, () => selectedProfileId && void loadProfile(selectedProfileId))}
      </div>
    )
  }

  const rootLabel = rootId ? t(`roots.labels.${rootId}`) : ''
  const writable = folderWritable

  const unavailableAction = (reason: RootUnavailableReason | undefined): EmptyStateAction | undefined => {
    switch (reason) {
      case 'remoteNotConfigured':
      case 'sftpUnreachable':
        return { label: t('protected.openBridgeSettings'), to: '/settings?tab=bridge' }
      case 'remoteInstallNotSet':
        // Opens for everyone: without bridge.setup the dialog says who can change them.
        return { label: t('roots.setRemoteFolders'), onClick: () => setRemoteOpen(true) }
      case 'missing':
      case 'notConfigured':
      case 'notMounted':
      case 'remoteNotActive':
      case 'tooBroad':
      case 'overlapsPanel':
      case 'unreadable':
        return { label: t('nav.items.myServers', { ns: 'shell' }), to: '/servers' }
      default:
        return undefined
    }
  }

  // A remote server that can't be reached says why (a wrong password, a
  // firewalled host, a chrooted login) and offers to try again.
  const renderUnavailable = (reason: RootUnavailableReason | undefined, detail?: string) =>
    reason === 'sftpUnreachable' ? (
      <EmptyState
        type="disconnected"
        compact
        title={rootLabel}
        description={unavailableText(reason, detail)}
        action={{ label: t('actions.retry'), onClick: () => void loadProfile(profile.id, true) }}
        secondaryAction={unavailableAction(reason)}
      />
    ) : (
      <EmptyState
        type="noFile"
        compact
        title={rootLabel}
        description={reason ? unavailableText(reason, detail) : undefined}
        action={unavailableAction(reason)}
      />
    )

  const renderListBody = () => {
    if (!root) return null
    if (!root.available) return renderUnavailable(root.unavailableReason, root.unavailableDetail)
    if (listError) {
      const code = errorCodeOf(listError)
      if (code === 'FM_AUTH_DISABLED') {
        return <EmptyState type="accessDenied" compact title={t('access.authDisabled')} description={t('access.authDisabledHow')} />
      }
      if (isAccessError(listError)) return <EmptyState type="accessDenied" compact title={t('access.denied')} />
      if (code === 'FM_ROOT_UNAVAILABLE') {
        const listParams = errorParamsOf(listError)
        const reason = typeof listParams.reason === 'string' ? (listParams.reason as RootUnavailableReason) : undefined
        return renderUnavailable(reason, typeof listParams.detail === 'string' ? listParams.detail : undefined)
      }
      if (code && SFTP_ERROR_CODES.has(code)) {
        const listParams = errorParamsOf(listError)
        const sftpCode = typeof listParams.sftpCode === 'string' ? listParams.sftpCode : null
        const guidance = sftpCode && i18n.exists(sftpCode, { ns: 'errors' })
          ? t(sftpCode, { ns: 'errors', detail: describeFilesError(listError) })
          : describeFilesError(listError)
        return (
          <EmptyState
            type="disconnected"
            compact
            title={t('roots.unavailable.sftpUnreachable')}
            description={guidance}
            action={{ label: t('actions.retry'), onClick: () => void loadListing() }}
          />
        )
      }
      if (code === 'FM_NOT_FOUND' && currentPath) {
        return (
          <EmptyState
            type="noFile"
            compact
            title={describeFilesError(listError)}
            action={{ label: t('list.parent'), onClick: goToParent }}
          />
        )
      }
      return (
        <EmptyState type="noData" compact title={describeFilesError(listError)} action={{ label: t('actions.retry'), onClick: () => void loadListing() }} />
      )
    }
    if (!listing) {
      return (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      )
    }
    if (search && search.results.length === 0) {
      // "Nothing matches" isn't the whole truth when the search stopped early.
      return (
        <EmptyState
          type="noResults"
          compact
          title={t('search.none')}
          description={search.truncated ? t('search.truncated') : undefined}
          action={{ label: t('list.clearFilter'), onClick: clearQuery }}
        />
      )
    }
    if (!search && listing.entries.length === 0) {
      return (
        <EmptyState
          type="empty"
          compact
          title={t('list.empty.title')}
          description={writable ? t('list.empty.description') : undefined}
          action={writable ? { label: t('actions.upload'), onClick: () => fileInputRef.current?.click() } : undefined}
          secondaryAction={writable ? { label: t('actions.newFile'), onClick: () => setNameDialog({ kind: 'newFile', dir: currentPath }) } : undefined}
        />
      )
    }
    if (!search && visibleEntries.length === 0) {
      return (
        <EmptyState
          type="noResults"
          compact
          title={t('list.noMatches.title', { query: query.trim() })}
          action={{ label: t('list.clearFilter'), onClick: clearQuery }}
        />
      )
    }
    return (
      <FileList
        entries={visibleEntries}
        root={root}
        selected={selected}
        isDesktop={isDesktop}
        showFolder={!!search}
        ariaLabel={folderLabel}
        onToggleSelect={toggleSelect}
        onSelectAll={selectAll}
        onOpen={openEntry}
        onAction={handleRowAction}
        onParent={goToParent}
        onDeleteKey={handleDeleteKey}
      />
    )
  }

  const shortcutsHelp = (
    <HelpTip label={t('shortcuts.title')} side="bottom" className="h-9 w-9 sm:h-7 sm:w-7">
      <span className="mb-1 flex items-center gap-1.5 font-semibold">
        <Keyboard className="h-3.5 w-3.5" aria-hidden="true" />
        {t('shortcuts.title')}
      </span>
      <span className="block">{t('shortcuts.open')}</span>
      <span className="block">{t('shortcuts.parent')}</span>
      <span className="block">{t('shortcuts.delete')}</span>
      <span className="block">{t('shortcuts.rename')}</span>
      <span className="block">{t('shortcuts.selectAll')}</span>
      <span className="block">{t('shortcuts.save')}</span>
    </HelpTip>
  )

  const rootNotices = root?.available && (root.writable === false || root.warnings.length > 0 || (view === 'files' && folderProtection)) ? (
    <div className="space-y-2">
      {view === 'files' && folderProtection && root.writable !== false && (
        <p className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 p-3 text-xs text-muted-foreground">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-medium text-foreground">{t('protected.badge')}</span>
            <span aria-hidden="true">{' · '}</span>
            <span>{t(`protected.areas.${folderProtection.area}`)}</span>
          </span>
        </p>
      )}
      {root.writable === false && (
        <p className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 p-3 text-xs text-muted-foreground">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-medium text-foreground">{t('roots.readOnly')}</span>
            {root.readOnlyReason && <> · {t(`roots.readOnlyReasons.${root.readOnlyReason}`)}</>}
          </span>
        </p>
      )}
      {root.warnings.map((warning) => (
        <p key={warning} className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t(`roots.warnings.${warning}`)}
        </p>
      ))}
    </div>
  ) : null

  const rootListProps = {
    profile,
    selectedRoot: rootId,
    trashOpen: view === 'trash',
    onSelectRoot: (id: RootId) => {
      setView('files')
      const remembered = validPath(readLastFolder(profile.id, id)) ?? ''
      goTo({ root: id, path: remembered })
    },
    onOpenBookmark: (bookmark: { rootId: RootId; path: string }) => {
      setView('files')
      goTo({ root: bookmark.rootId, path: validPath(bookmark.path) ?? '' })
    },
    onOpenTrash: () => setView((current) => (current === 'trash' ? 'files' : 'trash')),
    onSetRemoteFolders: () => setRemoteOpen(true),
  }

  const nameDialogProps = (() => {
    if (!nameDialog) return null
    switch (nameDialog.kind) {
      case 'newFile':
        return { title: t('dialogs.newFile.title'), label: t('dialogs.newFile.nameLabel'), initialValue: '', submitLabel: t('actions.create'), requireChange: false }
      case 'newFolder':
        return { title: t('dialogs.newFolder.title'), label: t('dialogs.newFolder.nameLabel'), initialValue: '', submitLabel: t('actions.create'), requireChange: false }
      case 'rename':
        return { title: t('dialogs.rename.title', { name: nameDialog.entry.name }), label: t('dialogs.rename.nameLabel'), initialValue: nameDialog.entry.name, submitLabel: t('actions.rename'), requireChange: true }
      case 'duplicate': {
        const { base, ext } = splitExtension(nameDialog.entry.name)
        return {
          title: t('dialogs.duplicate.title', { name: nameDialog.entry.name }),
          label: t('dialogs.duplicate.nameLabel'),
          initialValue: t('dialogs.duplicate.defaultName', { base, ext }),
          submitLabel: t('actions.duplicate'),
          requireChange: true,
        }
      }
    }
  })()

  const fileEntryForView = fileView?.entry ?? null

  return (
    <div className={selected.size > 0 && !isDesktop ? 'space-y-5 pb-24' : 'space-y-5'}>
      {header}

      <div className="grid gap-5 md:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)]">
        {isDesktop && (
          <Card className="h-fit">
            <CardContent className="space-y-4 pt-6">
              <ServerPicker profiles={profiles} value={profile.id} onChange={(id) => { setView('files'); goTo({ server: id, root: null, path: null }) }} />
              <RootList {...rootListProps} />
            </CardContent>
          </Card>
        )}

        <div className="min-w-0 space-y-5">
          <Card className="relative" onDragOver={onDragOver} onDragEnter={onDragOver} onDragLeave={onDragLeave} onDrop={(event) => void onDrop(event)}>
            <CardContent className="space-y-4 pt-6">
              {!isDesktop && (
                <div className="space-y-3">
                  <ServerPicker profiles={profiles} value={profile.id} onChange={(id) => { setView('files'); goTo({ server: id, root: null, path: null }) }} />
                  <RootSelect profile={profile} value={rootId} onChange={rootListProps.onSelectRoot} />
                </div>
              )}
              <ServerStateAlert
                profile={profile}
                checking={checkingState}
                onCheckAgain={async () => {
                  setCheckingState(true)
                  await loadProfile(profile.id, true)
                  setCheckingState(false)
                }}
              />
              {rootNotices}

              {view === 'trash' && root?.available ? (
                <TrashView
                  profileId={profile.id}
                  root={root}
                  isDesktop={isDesktop}
                  runConfirmed={runConfirmed}
                  refreshKey={trashRefreshKey}
                  onBack={() => setView('files')}
                  onChanged={() => {
                    setAuditKey((key) => key + 1)
                    void loadProfile(profile.id)
                  }}
                />
              ) : (
                <>
                  {root?.available && (
                    <FileToolbar
                      breadcrumb={<FileBreadcrumb rootLabel={rootLabel} path={currentPath} onNavigate={(path) => goTo({ path })} compact={!isDesktop} />}
                      shortcutsHelp={isDesktop ? shortcutsHelp : null}
                      query={query}
                      onQueryChange={(value) => {
                        setQuery(value)
                        if (search && value.trim() !== search.q) setSearch(null)
                      }}
                      onSearch={() => void runSearch()}
                      searching={searching}
                      searchActive={!!search}
                      onClearQuery={clearQuery}
                      sort={sort}
                      order={order}
                      sortLimited={!!listing?.sortLimited}
                      onSortChange={(nextSort, nextOrder) => {
                        setSort(listing?.sortLimited ? 'name' : nextSort)
                        setOrder(nextOrder)
                      }}
                      canWrite={writable}
                      onNewFile={() => setNameDialog({ kind: 'newFile', dir: currentPath })}
                      onNewFolder={() => setNameDialog({ kind: 'newFolder', dir: currentPath })}
                      onUploadFiles={() => fileInputRef.current?.click()}
                      onUploadFolder={() => folderInputRef.current?.click()}
                      selectionCount={selectedEntries.length}
                      canDownloadSelection={selectionCanDownload}
                      canDeleteSelection={selectionCanMutate}
                      onDownload={() => void downloadEntries(selectedEntries)}
                      onDownloadZip={() => void downloadEntries(selectedEntries, { zip: true })}
                      onDelete={() => void deleteEntries(selectedEntries, false)}
                      onRefresh={() => void loadListing({ keepSelection: true })}
                      refreshing={listLoading}
                    />
                  )}

                  {search && search.results.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                      <span>{t('search.results', { count: search.results.length })}</span>
                      {search.truncated && <span>· {t('search.truncated')}</span>}
                      <Button variant="link" size="sm" className="h-auto px-0" onClick={clearQuery}>{t('list.clearFilter')}</Button>
                    </div>
                  )}

                  {jobLine && (
                    <p aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      {jobLine.total !== null
                        ? t('jobs.deleting', { done: jobLine.done, total: jobLine.total })
                        : t('jobs.deletingUnknown', { done: jobLine.done })}
                    </p>
                  )}

                  {renderListBody()}

                  {!search && listing && root?.available && listing.entries.length > 0 && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {listing.entries.length < listing.total && (
                        <>
                          <span>{t('list.showing', { shown: listing.entries.length, total: listing.total })}</span>
                          <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                            {loadingMore && <Loader2 className="animate-spin" aria-hidden="true" />}
                            {t('list.loadMore')}
                          </Button>
                        </>
                      )}
                      {listing.sortLimited && <span>{t('list.sortLimited', { count: listing.total })}</span>}
                      {listing.truncated && <span>{t('list.truncated')}</span>}
                    </div>
                  )}

                  {root && (
                    <BulkBar
                      count={selectedEntries.length}
                      canDownload={selectionCanDownload}
                      canMutate={selectionCanMutate}
                      onDownloadZip={() => void downloadEntries(selectedEntries, { zip: true })}
                      onMove={() => setMovePaths(selectedEntries.map((entry) => entry.path))}
                      onDelete={() => void deleteEntries(selectedEntries, false)}
                      onClear={() => setSelected(new Set())}
                    />
                  )}
                </>
              )}
              <DropOverlay visible={dragActive} folder={folderLabel} />
            </CardContent>
          </Card>

          {!isDesktop && (
            <Card>
              <CardContent className="pt-6">
                <RootList {...rootListProps} compact />
              </CardContent>
            </Card>
          )}

          <UploadQueue
            items={uploadQueue.items}
            pausedUntil={uploadQueue.pausedUntil}
            allDone={uploadQueue.allDone}
            onCancel={uploadQueue.cancel}
            onRetry={uploadQueue.retry}
            onCancelAll={uploadQueue.cancelAll}
            onClear={uploadQueue.clearFinished}
          />

          <RecentChanges profileId={profile.id} refreshKey={auditKey} />
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        data-testid="files-upload-input"
        onChange={(event) => {
          const picked = pickedFromInput(event.target.files)
          event.target.value = ''
          void startUpload(picked)
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        data-testid="files-upload-folder-input"
        onChange={(event) => {
          const picked = pickedFromInput(event.target.files)
          event.target.value = ''
          void startUpload(picked)
        }}
      />
      <input
        ref={replaceInputRef}
        type="file"
        className="hidden"
        data-testid="files-replace-input"
        onChange={(event) => {
          const file = event.target.files?.[0]
          const target = replaceTargetRef.current
          event.target.value = ''
          replaceTargetRef.current = null
          if (!file || !target) return
          // The replacement keeps the name and the folder of the file it replaces.
          const renamed = new File([file], target.name, { type: file.type, lastModified: file.lastModified })
          void startUpload([{ file: renamed, relPath: target.name }], { replaceWithoutAsking: true, dir: parentPath(target.path) })
        }}
      />

      {replacePrompt && (
        <UploadReplaceDialog open folder={replacePrompt.folder} names={replacePrompt.names} onChoose={chooseReplace} />
      )}

      {root && fileEntryForView && fileView?.kind === 'edit' && (
        <FileEditorDialog
          open
          profileId={profile.id}
          root={root}
          entry={fileEntryForView}
          closeSignal={closeSignal}
          runConfirmed={runConfirmed}
          onClose={handleEditorClosed}
          onCloseCancelled={handleEditorCloseCancelled}
          onCloseAsking={putOpenBack}
          onSaved={() => {
            setAuditKey((key) => key + 1)
            void loadListing({ keepSelection: true })
          }}
          onTooLarge={() => setFileView({ kind: 'tail', entry: fileEntryForView })}
        />
      )}
      {root && fileEntryForView && fileView?.kind === 'tail' && (
        <TailViewer
          open
          profileId={profile.id}
          root={root}
          entry={fileEntryForView}
          canDownload={canReadEntry(fileEntryForView)}
          onDownload={() => void downloadEntries([fileEntryForView])}
          onClose={closeFileView}
        />
      )}
      {root && fileEntryForView && fileView?.kind === 'details' && (
        <FileDetailsPopover
          open
          entry={fileEntryForView}
          canDownload={canReadEntry(fileEntryForView)}
          canReplace={canMutateEntry(fileEntryForView, root) && fileEntryForView.type === 'file'}
          onDownload={() => void downloadEntries([fileEntryForView])}
          onReplace={() => {
            replaceTargetRef.current = fileEntryForView
            closeFileView()
            replaceInputRef.current?.click()
          }}
          onClose={closeFileView}
        />
      )}

      {nameDialog && nameDialogProps && (
        <NameDialog
          open
          title={nameDialogProps.title}
          label={nameDialogProps.label}
          initialValue={nameDialogProps.initialValue}
          submitLabel={nameDialogProps.submitLabel}
          requireChange={nameDialogProps.requireChange}
          onCancel={() => setNameDialog(null)}
          onSubmit={submitName}
        />
      )}

      {movePaths && root && (
        <MoveDialog
          open
          profileId={profile.id}
          root={root}
          rootLabel={rootLabel}
          paths={movePaths}
          startDir={currentPath}
          onCancel={() => setMovePaths(null)}
          onMove={submitMove}
        />
      )}

      {profile.remote && (
        <RemoteRootsDialog
          open={remoteOpen}
          profile={profile}
          canEdit={canSetRemote}
          onClose={() => setRemoteOpen(false)}
          onSaved={(next) => {
            setProfile(next)
            setRemoteOpen(false)
            setAuditKey((key) => key + 1)
            void loadProfiles()
          }}
        />
      )}
    </div>
  )
}
