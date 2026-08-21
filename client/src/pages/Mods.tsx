import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useSocket } from '@/contexts/SocketContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { usePageShortcut } from '../hooks/useKeyboardShortcuts'
import { copyText } from '@/lib/utils'
import {
  Package,
  RefreshCw,
  Plus,
  Trash2,
  ExternalLink,
  AlertTriangle,
  AlertCircle,
  CheckCircle,
  Clock,
  Download,
  FileText,
  Map as MapIcon,
  Library,
  Search,
  Filter,
  Settings2,
  ChevronRight,
  Check,
  Info,
  Layers,
  Save,
  FolderOpen,
  Loader2,
  GripVertical,
  MoreVertical,
  Wrench,
  PlusCircle,
  X,
  EyeOff,
  Eye,
  ArrowRight,
  Wand2,
} from 'lucide-react'
import { ConflictScanResult, ScanStreamModScanned, ScanStreamConflictFound } from '@/types'
import { WorkshopCollectionPanel } from '@/components/WorkshopCollectionPanel'
import { ConflictsPanel } from '@/components/mods/ConflictsPanel'
import { ModRow, WorkshopIdChip, WorkshopLinkAction, WorkshopThumb } from '@/components/mods/ModRow'
import {
  useLocalStorageState,
  type TrackedMod,
  type ModStatus,
  type ModEntry,
  type WsGroup,
  type DepSearchHit,
  type DepSearchState,
} from '@/lib/modsShared'
import { getAccessToken } from '@/lib/authToken'
import { isDemoMode } from '@/lib/demo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { reportClientError, reportClientWarning } from '@/lib/client-errors'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { modsApi, serversApi } from '@/lib/api'
import { FolderBrowser } from '@/components/FolderBrowser'
import { buildRequiresMap, computeAutoSortedOrder, createRequirementResolver, type AutoSortResult } from '@/lib/modLoadOrder'
import { EmptyState } from '@/components/EmptyState'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

interface CollectionMod {
  workshopId: string
  name: string
  description?: string
  tags?: string[]
  isMap: boolean
  modId?: string
  mapFolder?: string
  selected?: boolean
}

interface IniConfig {
  configured: boolean
  modIds: string[]
  workshopIds: string[]
  maps: string[]
  totalMods: number
  iniPath?: string
  error?: string
  workshopModMap?: Record<string, Array<{ id: string; name: string; enabled: boolean; require?: string[] }>>
}

// ── Pure helper — parse workshop ID from URL or numeric input ──
function parseWorkshopId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const urlMatch = trimmed.match(/[?&]id=(\d+)/)
  if (urlMatch) return urlMatch[1]
  const numericMatch = trimmed.match(/^(\d{6,15})$/)
  if (numericMatch) return numericMatch[1]
  return null
}

/**
 * One flat set of destinations. The page previously nested five "Advanced"
 * sub-tabs inside a top-level tab, which hid half the features a level deep
 * and gave two different mod lists names that did not distinguish them.
 */
type ModsView =
  | 'installed'
  | 'active'
  | 'order'
  | 'add'
  | 'collection'
  | 'conflicts'
  | 'presets'
  | 'tools'
  | 'deactivated'

const CONFIG_VIEWS: ModsView[] = ['active', 'order', 'add', 'presets', 'tools']

const MODS_NAV: Array<{
  group: string
  items: Array<{ id: ModsView; label: string; hint: string }>
}> = [
  {
    group: 'Mods',
    items: [
      { id: 'installed', label: 'Installed', hint: 'Workshop items this panel tracks for updates' },
      { id: 'active', label: 'Active on server', hint: 'What the server config actually loads' },
      { id: 'deactivated', label: 'Deactivated', hint: 'Tracked items currently switched off' },
    ],
  },
  {
    group: 'Add',
    items: [
      { id: 'add', label: 'Add mods', hint: 'Add by Workshop ID or URL' },
      { id: 'collection', label: 'Import collection', hint: 'Pull every item from a Steam collection' },
      { id: 'order', label: 'Load order', hint: 'Order mods are loaded in' },
    ],
  },
  {
    group: 'Maintenance',
    items: [
      { id: 'conflicts', label: 'Conflicts', hint: 'Clashes and missing dependencies' },
      { id: 'presets', label: 'Presets', hint: 'Save and restore mod sets' },
      { id: 'tools', label: 'Tools', hint: 'Repair, deduplicate, and cleanup' },
    ],
  },
]

export default function Mods() {
  const [searchParams] = useSearchParams()
  const reviewUnresolved = searchParams.get('review') === 'unresolved'
  const reviewDeepLinkStarted = useRef(false)
  const demoMode = isDemoMode()
  const [mods, setMods] = useState<TrackedMod[]>([])
  const [status, setStatus] = useState<ModStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [workshopBrowserOpen, setWorkshopBrowserOpen] = useState(false)
  const [workshopBrowserInitialPath, setWorkshopBrowserInitialPath] = useState<string | undefined>()
  const [savingWorkshopPath, setSavingWorkshopPath] = useState(false)
  const { toast } = useToast()
  const confirm = useConfirm()

  // Search and filters
  const [searchQuery, setSearchQuery] = useState('')
  const [deferredSearchQuery, setDeferredSearchQuery] = useState('')
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trackedModsRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [showUpdatesOnly, setShowUpdatesOnly] = useState(false)
  const [selectedMods, setSelectedMods] = useState<Set<string>>(new Set())

  // Disabled-mods reveal (mods downloaded into the Steam workshop folder but
  // not present in the server INI's WorkshopItems= list). Off by default to
  // keep the page focused on what's actually loaded by the server.
  const [showDisabled, setShowDisabled] = useState(false)
  const [disabledMods, setDisabledMods] = useState<Array<{ workshop_id: string; name: string }>>([])
  const [disabledLoading, setDisabledLoading] = useState(false)
  const [enablingId, setEnablingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Ctrl+K = focus search
  usePageShortcut('k', () => { searchInputRef.current?.focus() }, { ctrl: true })

  // Advanced Add Mod dialog (with multi-ID selection)
  const [advancedAddOpen, setAdvancedAddOpen] = useState(false)
  const [advancedModInput, setAdvancedModInput] = useState('')
  const [discoveringMod, setDiscoveringMod] = useState(false)
  const [showAdvancedIdSelection, setShowAdvancedIdSelection] = useState(false)
  const [discoveredMod, setDiscoveredMod] = useState<{
    workshopId: string
    name: string
    description: string | null
    modIds: string[]
    hasMultipleModIds: boolean
    isMap: boolean
    mapFolders: string[]
    isDownloaded: boolean
    tags: string[]
    alreadyConfigured?: string[]
    isAlreadyAdded?: boolean
  } | null>(null)
  const [selectedModIds, setSelectedModIds] = useState<Set<string>>(new Set())

  // Collection import
  const [collectionUrl, setCollectionUrl] = useState('')
  const [collectionDialogOpen, setCollectionDialogOpen] = useState(false)
  const [collectionMods, setCollectionMods] = useState<CollectionMod[]>([])
  const [importingCollection, setImportingCollection] = useState(false)
  const [collectionImported, setCollectionImported] = useState(false)
  const [showCollectionAdvanced, setShowCollectionAdvanced] = useState(false)

  // INI configuration
  const [iniConfig, setIniConfig] = useState<IniConfig | null>(null)
  const [modsToInstall, setModsToInstall] = useState<CollectionMod[]>([])
  const [orderedModIds, setOrderedModIds] = useState<string[]>([])
  const [selectedActiveWsId, setSelectedActiveWsId] = useState<string | null>(null)
  const [savingModOrder, setSavingModOrder] = useState(false)
  const [autoSortPreview, setAutoSortPreview] = useState<AutoSortResult | null>(null)
  const [draggedModIndex, setDraggedModIndex] = useState<number | null>(null)
  // Expand/collapse states
  const [repairingMaps, setRepairingMaps] = useState(false)
  const [mapRepairResult, setMapRepairResult] = useState<{ removed: string[]; added?: string[]; remaining: string[]; message: string } | null>(null)
  const [confirmRemoveMod, setConfirmRemoveMod] = useState<string | null>(null) // workshopId to confirm single remove
  const [confirmBulkRemove, setConfirmBulkRemove] = useState(false)
  const [ignoredMods, setIgnoredMods] = useState<Array<{ workshop_id: string; name: string | null; ignored_at: string }>>([])
  const [ignoredModsOpen, setIgnoredModsOpen] = useState(false)
  // Conflict pairs the user has explicitly dismissed as false positives.
  const [ignoredPairs, setIgnoredPairs] = useState<Array<{ mod_a: string; mod_b: string; reason?: string | null }>>([])
  const [confirmRemoveWorkshop, setConfirmRemoveWorkshop] = useState<{ wsId: string; knownModIds: string[] } | null>(null) // wsId for config tab remove
  const [deduplicating, setDeduplicating] = useState(false)
  const [deduplicateResult, setDeduplicateResult] = useState<string | null>(null)
  const [filterMultiId, setFilterMultiId] = useState(true)
  // "Active on server" list shape. Compact hides the per-ID chip grid (still
  // reachable in the inspector); warnings render in both densities.
  const [filterAttention, setFilterAttention] = useLocalStorageState<boolean>('zcp:mods:active:attentionOnly', false)
  const [activeDensity, setActiveDensity] = useLocalStorageState<'compact' | 'detailed'>('zcp:mods:active:density', 'compact')
  const [modManagerSearch, setModManagerSearch] = useState('')
  const [deferredModManagerSearch, setDeferredModManagerSearch] = useState('')
  const modSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [configSubTab, setConfigSubTab] = useState<'active' | 'order' | 'add' | 'presets' | 'tools'>('active')
  const [lastSavedMod, setLastSavedMod] = useState<string | null>(null)
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const busyRef = useRef(false) // Synchronous guard against double-submission
  const discoverAbortRef = useRef<AbortController | null>(null)

  // Restart settings dialog
  const [restartSettingsOpen, setRestartSettingsOpen] = useState(false)
  const [restartWarningMinutes, setRestartWarningMinutes] = useState(5)
  const [delayIfPlayersOnline, setDelayIfPlayersOnline] = useState(false)
  const [maxDelayMinutes, setMaxDelayMinutes] = useState(30)

  // Conflict scanner
  const [conflicts, setConflicts] = useState<ConflictScanResult | null>(null)
  const [conflictsLoading, setConflictsLoading] = useState(false)
  const [conflictsError, setConflictsError] = useState<string | null>(null)
  const [lastScanTime, setLastScanTime] = useState<Date | null>(null)
  const [scanIniSnapshot, setScanIniSnapshot] = useState<string | null>(null)
  // SSE streaming scan state
  const [scanProgress, setScanProgress] = useState(0)
  const [scanCurrentMod, setScanCurrentMod] = useState<string | null>(null)
  const [scanModsScanned, setScanModsScanned] = useState(0)
  const [scanTotalMods, setScanTotalMods] = useState(0)
  const [streamConflicts, setStreamConflicts] = useState<ScanStreamConflictFound[]>([])
  const eventSourceRef = useRef<EventSource | null>(null)
  const closingIntentionallyRef = useRef(false)
  const sseIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Batched scan-progress ref — flush via rAF to coalesce rapid SSE updates into 1 render
  const scanBatchRef = useRef<{ progress: number; modName: string | null; modsScanned: number; dirty: boolean; raf: number }>({ progress: 0, modName: null, modsScanned: 0, dirty: false, raf: 0 })

  // Inner sub-tab within Conflicts: 'network' or 'dependencies'
  const [activeTab, setActiveTab] = useState<ModsView>(reviewUnresolved ? 'conflicts' : 'installed')  // Severity filter for pairs list: 'all' | 'high' | 'medium' | 'low'
  // Graph filter state (used for pair filtering in the conflict list)

  // Track which conflict pairs have "show all files" expanded
  // Mod-details drawer — when set, opens a Dialog showing every conflict that mod is in.
  // Missing deps state
  const [depAdding, setDepAdding] = useState<string[]>([])
  const [depAddResults, setDepAddResults] = useState<Record<string, 'added' | 'error'>>({})
  // Inline Workshop search per unresolved dep row (key → state)
  const [depSearchOpen, setDepSearchOpen] = useState<Set<string>>(new Set())
  const [depSearchData, setDepSearchData] = useState<Record<string, DepSearchState>>({})

  // Workshop collection sync status — lightweight read of the diff endpoint.
  // Only fetched when a collection ID is configured server-side.
  const [collectionStatus, setCollectionStatus] = useState<{
    configured: boolean
    autoSync: boolean
    inSync: boolean
    drift: number
    title: string | null
    error: string | null
    loading: boolean
  }>({ configured: false, autoSync: false, inSync: false, drift: 0, title: null, error: null, loading: false })
  const [collectionSyncing, setCollectionSyncing] = useState(false)
  // Clean up SSE connection on unmount or page navigation
  useEffect(() => {
    return () => {
      closingIntentionallyRef.current = true
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      if (sseIdleTimerRef.current) clearTimeout(sseIdleTimerRef.current)
      sseIdleTimerRef.current = null
      cancelAnimationFrame(scanBatchRef.current.raf)
    }
  }, [])

  // Detect stale conflict results when INI config changes
  const conflictsStale = useMemo(() => {
    if (!conflicts || !scanIniSnapshot) return false
    const currentSnapshot = JSON.stringify({
      ws: iniConfig?.workshopIds?.slice().sort() || [],
      mods: iniConfig?.modIds?.slice().sort() || []
    })
    return currentSnapshot !== scanIniSnapshot
  }, [conflicts, scanIniSnapshot, iniConfig?.workshopIds, iniConfig?.modIds])

  // Track if auto-discover is pending (moved here for cleanup)
  const autoDiscoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAutoDiscoverIdRef = useRef<string | null>(null)

  // Mod Presets
  interface ModPreset {
    id: number
    name: string
    description: string
    workshop_ids: string[]
    mods: string[]
    created_at: string
    updated_at: string
  }
  const [presets, setPresets] = useState<ModPreset[]>([])
  const [presetsLoading, setPresetsLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [savePresetOpen, setSavePresetOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [presetDescription, setPresetDescription] = useState('')
  const [savingPreset, setSavingPreset] = useState(false)
  const [applyingPreset, setApplyingPreset] = useState<number | null>(null)
  const [confirmApplyPreset, setConfirmApplyPreset] = useState<{ id: number; name: string; modCount: number } | null>(null)
  const [confirmDeletePreset, setConfirmDeletePreset] = useState<{ id: number; name: string } | null>(null)

  // Mod conflict detection
  interface ModConflict {
    type: 'duplicate' | 'missing_modid' | 'outdated_dependency'
    severity: 'warning' | 'info'
    message: string
    modIds?: string[]
  }

  // Detect conflicts in current configuration
  const detectedConflicts = useMemo((): ModConflict[] => {
    if (!iniConfig?.configured) return []
    const conflicts: ModConflict[] = []

    // Check for duplicate mod IDs
    const modIdCounts: Record<string, number> = {}
    for (const modId of iniConfig.modIds) {
      modIdCounts[modId] = (modIdCounts[modId] || 0) + 1
    }
    const duplicates = Object.entries(modIdCounts).filter(([, count]) => count > 1)
    if (duplicates.length > 0) {
      conflicts.push({
        type: 'duplicate',
        severity: 'warning',
        message: `Duplicate mod IDs found: ${duplicates.map(([id]) => id).join(', ')}`,
        modIds: duplicates.map(([id]) => id)
      })
    }

    // Check for workshop items without corresponding mod IDs
    // This is normal for mods not yet downloaded, so just info level
    const workshopCount = iniConfig.workshopIds?.length || 0
    const modIdCount = iniConfig.modIds?.length || 0
    if (workshopCount > 0 && modIdCount === 0) {
      conflicts.push({
        type: 'missing_modid',
        severity: 'warning',
        message: `${workshopCount} workshop items configured but no mod IDs. Run "Sync Mod IDs" after downloading mods.`,
      })
    }

    return conflicts
  }, [iniConfig])

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (autoDiscoverTimeoutRef.current) {
        clearTimeout(autoDiscoverTimeoutRef.current)
      }
      if (savedTimeoutRef.current) {
        clearTimeout(savedTimeoutRef.current)
      }
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
      }
      if (trackedModsRetryRef.current) {
        clearTimeout(trackedModsRetryRef.current)
      }
      if (modSearchTimerRef.current) {
        clearTimeout(modSearchTimerRef.current)
      }
      discoverAbortRef.current?.abort()
      discoverAbortRef.current = null
      // Cancel any in-flight conflict scan
      eventSourceRef.current?.close()
    }
  }, [])

  // Debounced search handlers (300ms)
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => setDeferredSearchQuery(value), 300)
  }, [])

  const handleModManagerSearchChange = useCallback((value: string) => {
    setModManagerSearch(value)
    if (modSearchTimerRef.current) clearTimeout(modSearchTimerRef.current)
    modSearchTimerRef.current = setTimeout(() => setDeferredModManagerSearch(value), 300)
  }, [])

  const fetchData = useCallback(async () => {
    setFetchError(null)
    try {
      // Use allSettled so one failure doesn't break everything
      const results = await Promise.allSettled([
        modsApi.getTrackedMods(),
        modsApi.getStatus(),
        modsApi.getCurrentConfig(),
        modsApi.getIgnoredMods(),
        modsApi.getIgnoredModPairs()
      ])

      // Extract successful results
      if (results[0].status === 'fulfilled') {
        setMods(results[0].value.mods || [])
      } else {
        reportClientError('Failed to fetch tracked mods.', results[0].reason)
        setFetchError('Mod list is temporarily unavailable. Retrying...')
        if (trackedModsRetryRef.current) clearTimeout(trackedModsRetryRef.current)
        trackedModsRetryRef.current = setTimeout(async () => {
          try {
            const retry = await modsApi.getTrackedMods()
            setMods(retry.mods || [])
            setFetchError(null)
          } catch (error) {
            reportClientError('Failed to retry tracked mods fetch.', error)
            setFetchError('Unable to load the mod list. Use Sync or reload the page to retry.')
          }
        }, 1500)
      }
      if (results[1].status === 'fulfilled') {
        const statusData = results[1].value
        setStatus(statusData)
        // Update restart settings from status
        if (statusData) {
          setRestartWarningMinutes(statusData.restartWarningMinutes || 5)
          setDelayIfPlayersOnline(statusData.delayIfPlayersOnline || false)
          setMaxDelayMinutes(statusData.maxDelayMinutes || 30)
        }
      }
      if (results[2].status === 'fulfilled') {
        setIniConfig(results[2].value)
        // Initialize ordered mod IDs when iniConfig is loaded
        if (results[2].value?.modIds) {
          setOrderedModIds(results[2].value.modIds)
        }
      }
      if (results[3].status === 'fulfilled') {
        setIgnoredMods(Array.isArray(results[3].value) ? results[3].value : [])
      }
      if (results[4].status === 'fulfilled') {
        setIgnoredPairs(Array.isArray(results[4].value) ? results[4].value : [])
      }

      // Check for failures and show persistent error
      const failures = results.filter(r => r.status === 'rejected')
      if (failures.length > 0) {
        failures.forEach((result, index) => {
          reportClientError(`Failed to fetch mods data (index ${index}).`, (result as PromiseRejectedResult).reason)
        })
        if (failures.length === results.length) {
          setFetchError('Failed to load mod data. The backend may be unreachable.')
        }
      }
    } catch (error) {
      reportClientError('Failed to fetch mods data.', error)
      setFetchError('Failed to load mod data. The backend may be unreachable.')
    }
    // After any tracked-mod refresh, re-check the collection chip in the
    // background. The status hook short-circuits if no collection is wired,
    // so this is a no-op for users who don't use the feature.
    fetchCollectionStatusRef.current?.().catch(() => {})
  }, [])

  const handleOpenWorkshopBrowser = useCallback(async () => {
    try {
      const { server } = await serversApi.getActive()
      if (!server) {
        toast({
          title: 'No active server',
          description: 'Select a local server before choosing a workshop folder.',
          variant: 'destructive',
        })
        return
      }
      if (server.isRemote) {
        toast({
          title: 'Remote server',
          description: 'Workshop update detection requires the server files to be local to the panel.',
          variant: 'destructive',
        })
        return
      }
      const installPath = server?.installPath?.trim() || ''
      const lastSlash = Math.max(installPath.lastIndexOf('\\'), installPath.lastIndexOf('/'))
      const isStartupScript = /\.(bat|cmd|exe|sh)$/i.test(installPath)
      setWorkshopBrowserInitialPath(
        isStartupScript && lastSlash >= 0 ? installPath.slice(0, lastSlash) : installPath || undefined,
      )
    } catch (error) {
      reportClientWarning('Could not load the active server path before opening the folder browser.', error)
      toast({
        title: 'Could not open folder browser',
        description: error instanceof Error ? error.message : 'The active server could not be loaded.',
        variant: 'destructive',
      })
      return
    }
    setWorkshopBrowserOpen(true)
  }, [toast])

  const handleWorkshopFolderSelected = useCallback(async (selectedPath: string) => {
    if (savingWorkshopPath || !selectedPath.trim()) return
    setSavingWorkshopPath(true)
    try {
      const { server } = await serversApi.getActive()
      await serversApi.update(server.id, { installPath: selectedPath.trim() })
      await fetchData()
      toast({ title: 'Workshop path connected', description: 'Update detection is ready.' })
    } catch (error) {
      toast({
        title: 'Could not save workshop path',
        description: error instanceof Error ? error.message : 'Choose the folder containing the PZ server files.',
        variant: 'destructive',
      })
    } finally {
      setSavingWorkshopPath(false)
    }
  }, [fetchData, savingWorkshopPath, toast])

  // Fetch mods that exist on disk but are NOT in the server INI.
  // Lazy: only called when the user opens the "Show disabled" panel.
  const fetchDisabled = useCallback(async () => {
    setDisabledLoading(true)
    try {
      const result = await modsApi.listDiskOnly()
      setDisabledMods(result.mods || [])
    } catch (error) {
      reportClientError('Failed to fetch disabled mods.', error)
    } finally {
      setDisabledLoading(false)
    }
  }, [])

  const handleEnableDiskMod = useCallback(async (workshopId: string) => {
    if (enablingId) return
    setEnablingId(workshopId)
    try {
      const r = await modsApi.enableDiskMod(workshopId)
      toast({
        title: 'Mod enabled',
        description: `Added to server INI (${r.modIdsAdded} mod ID${r.modIdsAdded === 1 ? '' : 's'}). Restart the server to load it.`,
      })
      // Refresh both lists so the row moves from disabled → tracked.
      await Promise.allSettled([fetchData(), fetchDisabled()])
    } catch (error) {
      toast({
        title: 'Enable failed',
        description: error instanceof Error ? error.message : 'Failed to enable mod',
        variant: 'destructive',
      })
    } finally {
      setEnablingId(null)
    }
  }, [enablingId, toast, fetchData, fetchDisabled])

  // Delete a single mod's files from disk (and strip it from the INI).
  // Used by the "Disabled mods on disk" and "Ignored mods" panels.
  const handleDeleteDiskMod = useCallback(async (workshopId: string, modName?: string) => {
    if (deletingId) return
    const label = modName ? `"${modName}" (${workshopId})` : workshopId
    const ok = await confirm({
      title: 'Delete mod from disk?',
      description: `Delete ${label} from disk? This removes the workshop folder and strips it from the server INI. This cannot be undone (Steam will re-download on next start if the mod is still in WorkshopItems= elsewhere).`,
      confirmLabel: 'Delete',
    })
    if (!ok) {
      return
    }
    setDeletingId(workshopId)
    try {
      const r = await modsApi.deleteDiskMod(workshopId)
      toast({
        title: 'Mod deleted',
        description: r.deletedFromDisk
          ? `Removed from disk (${r.modIdsStripped} mod ID${r.modIdsStripped === 1 ? '' : 's'} stripped from INI).`
          : 'Folder was already missing; INI cleaned up.',
      })
      await Promise.allSettled([fetchData(), fetchDisabled()])
    } catch (error) {
      toast({
        title: 'Delete failed',
        description: error instanceof Error ? error.message : 'Failed to delete mod',
        variant: 'destructive',
      })
    } finally {
      setDeletingId(null)
    }
  }, [deletingId, toast, fetchData, fetchDisabled])

  // Bulk delete all currently shown disabled-on-disk mods.
  const handleDeleteAllDisabled = useCallback(async () => {
    if (deletingId || disabledMods.length === 0) return
    const ok = await confirm({
      title: 'Delete disabled mods from disk?',
      description: `Delete all ${disabledMods.length} disabled mod${disabledMods.length === 1 ? '' : 's'} from disk? This removes every workshop folder listed below.`,
      items: disabledMods.map(m => m.name || m.workshop_id),
      confirmLabel: 'Delete all',
    })
    if (!ok) {
      return
    }
    setDeletingId('__batch_disabled__')
    try {
      const ids = disabledMods.map(m => m.workshop_id)
      const r = await modsApi.batchDeleteDiskMods(ids)
      toast({
        title: 'Bulk delete complete',
        description: `Deleted ${r.deletedFromDisk}/${r.total} mod folder${r.total === 1 ? '' : 's'} (${r.modIdsStripped} mod ID${r.modIdsStripped === 1 ? '' : 's'} stripped from INI).`,
      })
      await Promise.allSettled([fetchData(), fetchDisabled()])
    } catch (error) {
      toast({
        title: 'Bulk delete failed',
        description: error instanceof Error ? error.message : 'Failed to delete mods',
        variant: 'destructive',
      })
    } finally {
      setDeletingId(null)
    }
  }, [deletingId, disabledMods, toast, fetchData, fetchDisabled])

  // Bulk delete all ignored mods from disk.
  const handleDeleteAllIgnoredFromDisk = useCallback(async () => {
    if (deletingId || ignoredMods.length === 0) return
    const ok = await confirm({
      title: 'Delete ignored mods from disk?',
      description: `Delete all ${ignoredMods.length} ignored mod${ignoredMods.length === 1 ? '' : 's'} from disk? This removes every workshop folder listed below AND clears the ignore list.`,
      items: ignoredMods.map(m => m.name || m.workshop_id),
      confirmLabel: 'Delete all',
    })
    if (!ok) {
      return
    }
    setDeletingId('__batch_ignored__')
    try {
      const ids = ignoredMods.map(m => m.workshop_id)
      const r = await modsApi.batchDeleteDiskMods(ids)
      toast({
        title: 'Bulk delete complete',
        description: `Deleted ${r.deletedFromDisk}/${r.total} mod folder${r.total === 1 ? '' : 's'} (${r.modIdsStripped} mod ID${r.modIdsStripped === 1 ? '' : 's'} stripped from INI).`,
      })
      await Promise.allSettled([fetchData(), fetchDisabled()])
    } catch (error) {
      toast({
        title: 'Bulk delete failed',
        description: error instanceof Error ? error.message : 'Failed to delete mods',
        variant: 'destructive',
      })
    } finally {
      setDeletingId(null)
    }
  }, [deletingId, ignoredMods, toast, fetchData, fetchDisabled])

  // Fetch the workshop-collection diff. Cheap one-shot read; only updates the
  // header indicator. Errors are stored on state so the user can see why
  // sync isn't reflecting their changes.
  //
  // We use a ref to break the dependency cycle between fetchData and
  // fetchCollectionStatus: every fetchData() call schedules a status refresh
  // (so adding/removing a tracked mod auto-refreshes the chip) without
  // re-creating fetchData on every render.
  const fetchCollectionStatusRef = useRef<() => Promise<void>>(async () => {})
  // Guard so we stop re-fetching if the user has no collection wired up
  // (avoids hammering the diff endpoint on every fetchData()).
  const collectionEverConfiguredRef = useRef(true)
  const fetchCollectionStatus = useCallback(async () => {
    if (!collectionEverConfiguredRef.current) return
    setCollectionStatus((s) => ({ ...s, loading: true }))
    try {
      const r = await modsApi.collectionDiff()
      collectionEverConfiguredRef.current = !!r.collectionId
      setCollectionStatus({
        configured: !!r.collectionId,
        autoSync: !!r.autoSync,
        inSync: r.ok && r.toAdd.length === 0 && r.toRemove.length === 0,
        drift: r.ok ? r.toAdd.length + r.toRemove.length : 0,
        title: r.title || null,
        error: r.ok ? null : (r.error || null),
        loading: false,
      })
    } catch (err: any) {
      setCollectionStatus((s) => ({ ...s, loading: false, error: err?.message || 'Network error' }))
    }
  }, [])

  // Keep the ref pointing at the latest implementation so fetchData can
  // call it without taking it as a dependency.
  useEffect(() => {
    fetchCollectionStatusRef.current = fetchCollectionStatus
  }, [fetchCollectionStatus])

  // If the user wires up a collection in Settings *after* opening the Mods
  // page, the gate above (collectionEverConfiguredRef = false) would keep
  // the chip hidden until full reload. Re-arm the gate when the tab gains
  // focus so a freshly-saved config gets discovered.
  useEffect(() => {
    const onFocus = () => {
      if (!collectionEverConfiguredRef.current) {
        collectionEverConfiguredRef.current = true
        fetchCollectionStatusRef.current?.().catch(() => {})
      }
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [])

  const handleCollectionSyncNow = useCallback(async () => {
    if (collectionSyncing) return
    setCollectionSyncing(true)
    try {
      const r = await modsApi.collectionSync()
      toast({
        title: r.success ? 'Collection synced' : 'Partial sync',
        description: r.message,
        variant: r.success ? 'default' : 'destructive',
      })
      fetchCollectionStatus()
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'Sync failed', description: err?.message || 'Unknown error' })
    } finally {
      setCollectionSyncing(false)
    }
  }, [collectionSyncing, fetchCollectionStatus, toast])

  // Fetch mod presets
  const fetchPresets = useCallback(async () => {
    setPresetsLoading(true)
    try {
      const data = await modsApi.getPresets()
      setPresets(data.presets || [])
    } catch (error) {
      reportClientError('Failed to fetch presets.', error)
      setFetchError('Failed to load presets')
    } finally {
      setPresetsLoading(false)
    }
  }, [])

  // Initial data fetch + auto sync from server
  // Subscribe to Socket.IO mod events for real-time status updates
  const socket = useSocket()
  useEffect(() => {
    if (!socket) return
    const refresh = () => { fetchData() }
    socket.on('mods:update_detected', refresh)
    socket.on('mods:restart_pending', refresh)
    socket.on('mods:restart_starting', refresh)
    socket.on('mods:restart_cancelled', refresh)
    socket.on('mods:restart_failed', refresh)
    socket.on('mods:restart_complete', refresh)
    socket.on('mods:updates_available', refresh)
    return () => {
      socket.off('mods:update_detected', refresh)
      socket.off('mods:restart_pending', refresh)
      socket.off('mods:restart_starting', refresh)
      socket.off('mods:restart_cancelled', refresh)
      socket.off('mods:restart_failed', refresh)
      socket.off('mods:restart_complete', refresh)
      socket.off('mods:updates_available', refresh)
    }
  }, [socket, fetchData])

  useEffect(() => {
    let mounted = true
    const initializeData = async () => {
      await Promise.allSettled([fetchData(), fetchPresets(), fetchCollectionStatus()])
      if (!mounted) return
      // Load cached conflict scan results (if any) so the Conflicts tab isn't blank
      try {
        const cached = await modsApi.getCachedConflicts()
        if (!mounted) return
        if (cached) {
          setConflicts(cached)
          setConflictsError(null) // clear any stale error from a previous session
          setLastScanTime(new Date()) // approximate — exact time isn't stored
          // Set a snapshot so stale detection works when modIds change after cached load
          setScanIniSnapshot(JSON.stringify({
            ws: cached._workshopIdsSnapshot || [],
            mods: cached._modIdsSnapshot || []
          }))
          if (cached.stale) {
            // Config changed since last scan — the stale banner will show
          }
        }
      } catch { /* non-fatal — user can still trigger a fresh scan */ }
    }
    initializeData()
    return () => { mounted = false }
  }, [fetchData, fetchPresets, fetchCollectionStatus])

  const handleSavePreset = async () => {
    if (!presetName.trim()) return
    setSavingPreset(true)
    try {
      await modsApi.createPreset(presetName.trim(), presetDescription.trim())
      toast({
        title: 'Preset Saved',
        description: `Mod preset "${presetName}" has been saved`,
        variant: 'success' as const,
      })
      setSavePresetOpen(false)
      setPresetName('')
      setPresetDescription('')
      fetchPresets()
    } catch (error) {
      toast({
        title: 'Preset Save Failed',
        description: error instanceof Error ? error.message : 'Failed to save preset',
        variant: 'destructive',
      })
    } finally {
      setSavingPreset(false)
    }
  }

  const handleApplyPreset = async (id: number, _name: string) => {
    setApplyingPreset(id)
    try {
      const result = await modsApi.applyPreset(id)
      toast({
        title: 'Preset Applied',
        description: result.message,
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Preset Apply Failed',
        description: error instanceof Error ? error.message : 'Failed to apply preset',
        variant: 'destructive',
      })
    } finally {
      setApplyingPreset(null)
      fetchData() // Always resync state — preset may have partially applied
    }
  }

  const handleDeletePreset = async (id: number, name: string) => {
    try {
      await modsApi.deletePreset(id)
      toast({
        title: 'Preset Deleted',
        description: `Preset "${name}" has been deleted`,
        variant: 'success' as const,
      })
      fetchPresets()
    } catch (error) {
      toast({
        title: 'Preset Delete Failed',
        description: error instanceof Error ? error.message : 'Failed to delete preset',
        variant: 'destructive',
      })
    }
  }

  // Filtered mods based on search and filters
  const filteredMods = useMemo(() => {
    let result = [...mods]

    if (deferredSearchQuery) {
      const query = deferredSearchQuery.toLowerCase()
      result = result.filter(m =>
        m.name?.toLowerCase().includes(query) ||
        m.workshop_id.includes(query)
      )
    }

    if (showUpdatesOnly) {
      result = result.filter(m => m.update_available)
    }

    return result.sort((a, b) => {
      if (a.update_available !== b.update_available) {
        return b.update_available - a.update_available
      }
      return (a.name || '').localeCompare(b.name || '')
    })
  }, [mods, deferredSearchQuery, showUpdatesOnly])

  // Group mods by status for scannable display.
  // Mods that are tracked but no longer present in the server INI's
  // WorkshopItems= list are routed to a separate "Deactivated" bucket so
  // they don't pollute the active server view.
  const configuredWorkshopIds = useMemo(() => new Set(iniConfig?.workshopIds || []), [iniConfig?.workshopIds])
  const groupedMods = useMemo(() => {
    const updateAvailable: TrackedMod[] = []
    const neverChecked: TrackedMod[] = []
    const upToDate: TrackedMod[] = []
    const deactivated: TrackedMod[] = []
    const configLoaded = iniConfig !== null
    for (const mod of filteredMods) {
      if (configLoaded && !configuredWorkshopIds.has(mod.workshop_id)) {
        deactivated.push(mod)
        continue
      }
      if (mod.update_available) updateAvailable.push(mod)
      else if (!mod.last_checked) neverChecked.push(mod)
      else upToDate.push(mod)
    }
    return { updateAvailable, neverChecked, upToDate, deactivated }
  }, [filteredMods, iniConfig, configuredWorkshopIds])

  const visibleServerMods = useMemo(
    () => [...groupedMods.updateAvailable, ...groupedMods.neverChecked, ...groupedMods.upToDate],
    [groupedMods]
  )

  // Collapse "up-to-date" by default, expand when searching
  const [upToDateExpanded, setUpToDateExpanded] = useState(false)
  // Collapse "never checked" by default — it's an alphabetical dump until a check has run
  const [neverCheckedExpanded, setNeverCheckedExpanded] = useState(false)
  // Reset collapse when search changes
  useEffect(() => {
    if (deferredSearchQuery) {
      setUpToDateExpanded(true)
      setNeverCheckedExpanded(true)
    } else {
      setUpToDateExpanded(false)
      setNeverCheckedExpanded(false)
    }
  }, [deferredSearchQuery])

  // If "Never Checked" is the only non-empty bucket (e.g. fresh server, first
  // load before any update check has run), auto-expand it. Otherwise the user
  // sees an empty-looking list with just a collapsed header — the mods ARE
  // tracked, they just aren't visible.
  useEffect(() => {
    if (deferredSearchQuery) return
    if (
      groupedMods.neverChecked.length > 0 &&
      groupedMods.updateAvailable.length === 0 &&
      groupedMods.upToDate.length === 0
    ) {
      setNeverCheckedExpanded(true)
    }
  }, [groupedMods, deferredSearchQuery])

  const handleCheckUpdates = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setChecking(true)
    try {
      const result = await modsApi.checkUpdates()
      // Backend returns `{ updated, mods, error?, skipped? }`. Older code read
      // `result.updatesFound` which never existed → always reported 0.
      const count =
        (Array.isArray(result?.mods) ? result.mods.length : 0) ||
        (typeof result?.updatesFound === 'number' ? result.updatesFound : 0)
      if (result?.error) {
        toast({
          title: 'Update Check Failed',
          description: String(result.error),
          variant: 'destructive',
        })
      } else if (result?.skipped) {
        toast({
          title: 'Update Check Skipped',
          description: 'A check is already in progress.',
        })
      } else {
        toast({
          title: 'Updates Checked',
          description:
            count === 0
              ? 'All mods up to date'
              : `${count} mod${count === 1 ? '' : 's'} ${count === 1 ? 'has' : 'have'} updates available`,
        })
      }
      fetchData()
    } catch (error) {
      toast({
        title: 'Update Check Failed',
        description: error instanceof Error ? error.message : 'Failed to check updates',
        variant: 'destructive',
      })
    } finally {
      setChecking(false)
      busyRef.current = false
    }
  }

  const discoverWorkshopMod = useCallback(async (workshopId: string) => {
    // Prevent double-triggering
    if (discoveringMod) return

    // Abort any previous discovery request
    discoverAbortRef.current?.abort()
    const controller = new AbortController()
    discoverAbortRef.current = controller

    // Check if already configured
    if (iniConfig?.workshopIds?.includes(workshopId)) {
      toast({
        title: 'Already Added',
        description: 'This mod is already in your server configuration',
        variant: 'default',
      })
      return
    }

    setDiscoveringMod(true)
    setDiscoveredMod(null)
    setSelectedModIds(new Set())

    try {
      const result = await modsApi.discoverModIds(workshopId, undefined, { signal: controller.signal })

      // Filter out duplicate mod IDs (case-insensitive)
      const seenIds = new Set<string>()
      const uniqueModIds = result.modIds.filter(id => {
        const lower = id.toLowerCase()
        if (seenIds.has(lower)) return false
        seenIds.add(lower)
        return true
      })

      // Check which mod IDs are already in config
      const alreadyConfigured = uniqueModIds.filter(id =>
        iniConfig?.modIds?.includes(id)
      )

      const newResult = {
        ...result,
        modIds: uniqueModIds,
        hasMultipleModIds: uniqueModIds.length > 1,
        alreadyConfigured,
        isAlreadyAdded: iniConfig?.workshopIds?.includes(workshopId) || false,
      }

      setDiscoveredMod(newResult)

      // Pre-select only NEW mod IDs (not already configured)
      const newModIds = uniqueModIds.filter(id => !alreadyConfigured.includes(id))
      setSelectedModIds(new Set(newModIds))

      if (uniqueModIds.length === 0) {
        toast({
          title: 'No Mod IDs Found',
          description: result.isDownloaded
            ? 'Mod is downloaded but no mod.info files found'
            : 'Mod not yet downloaded. Add it anyway and sync after the server downloads it.',
          variant: 'default',
        })
      } else if (alreadyConfigured.length > 0 && alreadyConfigured.length === uniqueModIds.length) {
        toast({
          title: 'Already Configured',
          description: 'All mod IDs from this workshop item are already in your server config',
          variant: 'default',
        })
      } else if (newResult.hasMultipleModIds) {
        toast({
          title: 'Multiple Mod IDs Found',
          description: `Found ${uniqueModIds.length} mod IDs. ${newModIds.length} new, ${alreadyConfigured.length} already configured.`,
        })
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return // Superseded by newer request
      toast({
        title: 'Discovery Failed',
        description: error instanceof Error ? error.message : 'Failed to discover mod IDs. Check the Workshop ID and try again.',
        variant: 'destructive',
      })
    } finally {
      setDiscoveringMod(false)
    }
  }, [discoveringMod, iniConfig?.modIds, iniConfig?.workshopIds, toast])

  // Auto-discover on paste (debounced)
  const handleModInputChange = useCallback((value: string) => {
    setAdvancedModInput(value)

    if (autoDiscoverTimeoutRef.current) {
      clearTimeout(autoDiscoverTimeoutRef.current)
      autoDiscoverTimeoutRef.current = null
    }

    if (value.includes('steamcommunity.com') && value.includes('id=')) {
      const workshopId = parseWorkshopId(value)

      if (workshopId && workshopId !== lastAutoDiscoverIdRef.current) {
        lastAutoDiscoverIdRef.current = workshopId
        autoDiscoverTimeoutRef.current = setTimeout(() => {
          void discoverWorkshopMod(workshopId)
        }, 200)
      }
    }
  }, [discoverWorkshopMod])

  // Discover mod IDs from workshop URL/ID
  const handleDiscoverMod = async () => {
    const workshopId = parseWorkshopId(advancedModInput)

    if (!workshopId) {
      toast({
        title: 'Invalid Workshop URL',
        description: 'Enter a Workshop URL or numeric ID. Example: 3616536783',
        variant: 'destructive',
      })
      return
    }

    await discoverWorkshopMod(workshopId)
  }

  // Add mod with selected mod IDs
  const handleAddModAdvanced = async () => {
    if (!discoveredMod || busyRef.current) return
    busyRef.current = true

    setLoading(true)
    try {
      const modIdsArray = Array.from(selectedModIds)

      // Track the mod first
      await modsApi.trackMod(discoveredMod.workshopId)

      // Add with selected mod IDs
      const result = await modsApi.addModAdvanced(
        discoveredMod.workshopId,
        modIdsArray.length > 0 ? modIdsArray : undefined,
        modIdsArray.length === 0 // If no mod IDs selected, try to include all
      )

      if (result.addedModIds.length > 0) {
        toast({
          title: 'Mod Added to Server Config',
          description: `${result.addedModIds.join(', ')} written to INI.${result.mapFoldersAdded.length > 0
            ? ` Map${result.mapFoldersAdded.length !== 1 ? 's' : ''}: ${result.mapFoldersAdded.join(', ')}.`
            : ''} Restart the server to load it.`,
          variant: 'success' as const,
        })
      } else if (result.workshopAlreadyExisted) {
        toast({
          title: 'Already Configured',
          description: 'This mod is already in your server INI.',
        })
      } else {
        toast({
          title: 'Workshop ID Added',
          description: 'Added to INI. Mod IDs will be discovered after the server downloads the files.',
        })
      }

      // Reset and close
      setAdvancedModInput('')
      setDiscoveredMod(null)
      setSelectedModIds(new Set())
      setAdvancedAddOpen(false)
      fetchData()
    } catch (error) {
      toast({
        title: 'Add Mod Failed',
        description: error instanceof Error ? error.message : 'Failed to add mod',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  // Toggle mod ID selection
  const toggleModIdSelection = (modId: string) => {
    setSelectedModIds(prev => {
      const next = new Set(prev)
      if (next.has(modId)) {
        next.delete(modId)
      } else {
        next.add(modId)
      }
      return next
    })
  }
  const handleRemoveMod = async (workshopId: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.batchRemove([workshopId])
      toast({
        title: 'Mod Removed',
        description: 'Removed from server INI config.',
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Remove Failed',
        description: error instanceof Error ? error.message : 'Failed to remove mod',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  // Re-enable a deactivated tracked mod by appending its workshop ID to the
  // server INI's WorkshopItems= list. SteamCMD will (re)download it on next
  // server start if the workshop folder isn't already on disk.
  const handleEnableMod = async (workshopId: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.addToIni(workshopId)
      toast({
        title: 'Mod Re-enabled',
        description: 'Added back to server INI. Restart the server for it to load.',
        variant: 'success' as const,
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Enable Failed',
        description: error instanceof Error ? error.message : 'Failed to enable mod',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  // Bulk: re-enable every selected deactivated mod. Falls back to sequential
  // addToIni calls because there's no dedicated batch endpoint and the volume
  // is expected to be small (handful of leftovers).
  const handleBulkEnable = async (workshopIds: string[]) => {
    if (workshopIds.length === 0 || busyRef.current) return
    busyRef.current = true
    setLoading(true)
    let ok = 0
    let failed = 0
    try {
      for (const id of workshopIds) {
        try {
          await modsApi.addToIni(id)
          ok++
        } catch {
          failed++
        }
      }
      toast({
        title: failed === 0 ? 'Mods Re-enabled' : 'Partial Re-enable',
        description: `Added ${ok} mod${ok === 1 ? '' : 's'} back to the INI${failed > 0 ? ` · ${failed} failed` : ''}.`,
        variant: failed === 0 ? ('success' as const) : ('destructive' as const),
      })
      setSelectedMods(new Set())
      fetchData()
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleRefreshNames = async (workshopIds?: string[]) => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await modsApi.refreshNames(workshopIds)
      const total = result.totalResolved ?? 0
      const left = result.unresolved ?? 0
      toast({
        title: total > 0 ? `Resolved ${total} name${total === 1 ? '' : 's'}` : 'No new names found',
        description: total > 0
          ? `${result.diskResolved} from disk · ${result.steamResolved} from Steam${left > 0 ? ` · ${left} still unknown (deleted/private mod)` : ''}.`
          : `Checked ${result.checked} placeholder name${result.checked === 1 ? '' : 's'} — none could be resolved. The mods may be deleted or private on Steam.`,
        variant: total > 0 ? ('success' as const) : ('default' as const),
      })
      if (total > 0) fetchData()
    } catch (error: any) {
      toast({
        title: 'Refresh failed',
        description: error?.message || 'Could not refresh names',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleBulkRemove = async (workshopIdsOverride?: string[]) => {
    const workshopIds = workshopIdsOverride ?? Array.from(selectedMods)
    if (workshopIds.length === 0 || busyRef.current) return
    busyRef.current = true

    setLoading(true)

    try {
      const result = await modsApi.batchRemove(workshopIds) as { success?: boolean; total?: number; dbRemoved?: number; dbFailed?: number; iniRemoved?: number; error?: string }

      if (result.error) {
        throw new Error(result.error)
      }

      if ((result.dbFailed ?? 0) > 0) {
        toast({
          title: 'Partial Success',
          description: `Removed ${result.dbRemoved ?? 0} mods, ${result.dbFailed ?? 0} failed to untrack`,
          variant: 'destructive',
        })
      } else {
        toast({
          title: 'Success',
          description: `Removed ${result.total ?? workshopIds.length} mod${(result.total ?? workshopIds.length) !== 1 ? 's' : ''} from tracking and server config`,
        })
      }
      if (workshopIdsOverride) {
        setSelectedMods(prev => {
          const next = new Set(prev)
          for (const workshopId of workshopIds) next.delete(workshopId)
          return next
        })
      } else {
        setSelectedMods(new Set())
      }
      fetchData()
    } catch (error) {
      toast({
        title: 'Remove Failed',
        description: error instanceof Error ? error.message : 'Failed to remove mods',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleUnignoreMod = async (workshopId: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.unignoreMod(workshopId)
      toast({ title: 'Mod Un-Ignored', description: 'This mod can now be tracked again by auto-sync.' })
      fetchData()
    } catch (error) {
      toast({
        title: 'Failed to Un-Ignore Mod',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleClearAllIgnored = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await modsApi.clearAllIgnoredMods()
      toast({ title: 'Ignore List Cleared', description: result.message || 'All ignored mods removed.' })
      fetchData()
    } catch (error) {
      toast({
        title: 'Failed to Clear Ignored Mods',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleToggleAutoRestart = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.setAutoRestart(!status?.autoRestartEnabled)
      toast({
        title: `Auto-restart ${status?.autoRestartEnabled ? 'disabled' : 'enabled'}`,
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Setting Update Failed',
        description: error instanceof Error ? error.message : 'Failed to update setting',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleSyncFromServer = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await modsApi.syncFromServer()
      const parts: string[] = [`Synced ${result.synced || 0} mods from server config`]
      if (result.skippedNonMod > 0) parts.push(`${result.skippedNonMod} non-mod items filtered`)
      if (result.skippedIgnored > 0) parts.push(`${result.skippedIgnored} ignored`)
      toast({
        title: 'Mods Synced',
        description: parts.join('. ') + '.',
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Sync Failed',
        description: error instanceof Error ? error.message : 'Failed to sync mods',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleImportCollection = async () => {
    if (!collectionUrl) {
      toast({
        title: 'No URL Entered',
        description: 'Paste a Steam Workshop collection URL or numeric ID to import.',
        variant: 'destructive',
      })
      return
    }
    // Validate format before sending to API
    const trimmed = collectionUrl.trim()
    if (!/^\d{1,15}$/.test(trimmed) && !trimmed.includes('steamcommunity.com')) {
      toast({
        title: 'Invalid Format',
        description: 'Enter a Steam Workshop collection URL or a numeric collection ID.',
        variant: 'destructive',
      })
      return
    }
    if (busyRef.current) return
    busyRef.current = true

    setImportingCollection(true)
    try {
      const result = await modsApi.importCollection(collectionUrl)
      const mods = result.mods || []
      const existingWorkshopIds = new Set(iniConfig?.workshopIds || [])
      setCollectionMods(mods.map((m: CollectionMod) => ({
        ...m,
        selected: !existingWorkshopIds.has(m.workshopId),
        modId: '',
        // Do not guess the folder from the Steam title: the real folder lives
        // in the mod's media/maps directory and rarely matches. A wrong value
        // written to Map= stops the world from loading.
        mapFolder: undefined
      })))
      setCollectionImported(true)

      if (mods.length === 0) {
        toast({
          title: 'No Mods Found',
          description: 'This collection appears empty. Check the URL and try again.',
          variant: 'destructive',
        })
      } else {
        toast({
          title: `${mods.length} mods found`,
          description: 'Select which mods to add, then confirm.',
        })
      }
    } catch (error) {
      toast({
        title: 'Collection Import Failed',
        description: error instanceof Error ? error.message : 'Could not fetch collection from Steam. Check the URL and try again.',
        variant: 'destructive',
      })
    } finally {
      setImportingCollection(false)
      busyRef.current = false
    }
  }

  const toggleModSelection = (workshopId: string) => {
    setCollectionMods(prev => prev.map(m =>
      m.workshopId === workshopId ? { ...m, selected: !m.selected } : m
    ))
  }

  const updateModId = (workshopId: string, modId: string) => {
    setCollectionMods(prev => prev.map(m =>
      m.workshopId === workshopId ? { ...m, modId } : m
    ))
  }

  const updateMapFolder = (workshopId: string, mapFolder: string) => {
    setCollectionMods(prev => prev.map(m =>
      m.workshopId === workshopId ? { ...m, mapFolder } : m
    ))
  }

  const handleAddCollectionMods = async () => {
    const selectedModsList = collectionMods.filter(m => m.selected)

    if (selectedModsList.length === 0) {
      toast({
        title: 'No Mods Selected',
        description: 'Check the mods you want to add from the list above.',
        variant: 'destructive',
      })
      return
    }

    setLoading(true)
    try {
      const results = await Promise.allSettled(
        selectedModsList.map(async (mod) => {
          // Write each mod directly to the server .ini (workshopId + mod IDs + map folders)
          const selectedModIds = mod.modId ? [mod.modId] : undefined
          await modsApi.addModAdvanced(
            mod.workshopId,
            selectedModIds,
            !selectedModIds, // includeAllModIds when no explicit modId was set
            mod.name,
            mod.isMap ? mod.mapFolder : undefined,
          )
          return mod.workshopId
        })
      )

      const added = results.filter(r => r.status === 'fulfilled').length
      const failed = results.filter(r => r.status === 'rejected').length
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          reportClientWarning(`Failed to add mod ${selectedModsList[index].workshopId}.`, result.reason)
        }
      })

      toast({
        title: `${added} mod${added !== 1 ? 's' : ''} added to server config`,
        description: failed > 0
          ? `${failed} failed — check the console for details`
          : 'Restart the server to load the new mods.',
        variant: failed > 0 ? 'destructive' : 'success' as const,
      })

      setCollectionDialogOpen(false)
      setCollectionMods([])
      setCollectionUrl('')
      fetchData()
    } catch (error) {
      toast({
        title: 'Import Failed',
        description: error instanceof Error ? error.message : 'Could not add mods to server config. Try again.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleWriteToIni = async () => {
    if (modsToInstall.length === 0) {
      toast({
        title: 'Nothing to Write',
        description: 'Add mods to the pending list first, then write to INI.',
        variant: 'destructive',
      })
      return
    }

    setLoading(true)
    try {
      const modsData = modsToInstall.map(m => ({
        workshopId: m.workshopId,
        modId: m.modId || m.workshopId
      }))

      const mapFolders = modsToInstall
        .filter(m => m.isMap && m.mapFolder)
        .map(m => m.mapFolder!)

      const result = await modsApi.writeToIni(modsData, mapFolders)

      toast({
        title: 'Configuration Saved',
        description: `${result.modsConfigured} mods configured. Restart server to apply.`,
      })

      setModsToInstall([])
      fetchData()
    } catch (error) {
      toast({
        title: 'Write to INI Failed',
        description: error instanceof Error ? error.message : 'Failed to write configuration',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  // Sync mod IDs from downloaded workshop mods to the Mods= line in server.ini
  const handleSyncModIds = async () => {
    setSyncing(true)
    try {
      const result = await modsApi.syncModIds()

      const synced = result.syncedMods?.filter((m: { status?: string }) => m.status?.startsWith('added')).length || 0
      const missing = result.missingMods?.length || 0

      if (synced > 0 || missing > 0) {
        toast({
          title: 'Mod IDs Synced',
          description: `${synced} mod ID(s) added to config.${missing > 0 ? ` ${missing} mod(s) not yet downloaded.` : ''}`,
        })
      } else {
        toast({
          title: 'Already Synced',
          description: 'All downloaded mods are already in the Mods= configuration.',
        })
      }

      // Refresh ini config display
      fetchData()
    } catch (error) {
      toast({
        title: 'Mod ID Sync Failed',
        description: error instanceof Error ? error.message : 'Failed to sync mod IDs',
        variant: 'destructive',
      })
    } finally {
      setSyncing(false)
    }
  }

  // Drag & drop handlers for mod load order
  const handleDragStart = (index: number) => {
    setDraggedModIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (draggedModIndex === null || draggedModIndex === index) return
    if (draggedModIndex < 0 || draggedModIndex >= orderedModIds.length) return

    // Reorder the mods
    const newOrder = [...orderedModIds]
    const [draggedItem] = newOrder.splice(draggedModIndex, 1)
    newOrder.splice(index, 0, draggedItem)
    setOrderedModIds(newOrder)
    setDraggedModIndex(index)
  }

  const handleDragEnd = () => {
    setDraggedModIndex(null)
  }

  const moveModUp = (index: number) => {
    if (index === 0) return
    const newOrder = [...orderedModIds]
    ;[newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]]
    setOrderedModIds(newOrder)
  }

  const moveModDown = (index: number) => {
    if (index === orderedModIds.length - 1) return
    const newOrder = [...orderedModIds]
    ;[newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]]
    setOrderedModIds(newOrder)
  }

  // Dependency-aware auto-sort. Computes a proposal only; nothing is written
  // until the user applies it and then saves the order.
  const handleAutoSort = () => {
    const requiresByModId = buildRequiresMap(iniConfig?.workshopModMap)
    const result = computeAutoSortedOrder(orderedModIds, requiresByModId)

    if (result.appliedEdges === 0) {
      toast({
        title: result.missing.length > 0 ? 'Nothing to sort by' : 'No dependency data',
        description:
          result.missing.length > 0
            ? `${result.missing.length} declared requirement${result.missing.length === 1 ? ' is' : 's are'} not enabled, so none of the enabled mods depend on each other.`
            : 'None of the enabled mods declare a "require" in their mod.info, so there is nothing to sort by.',
      })
      return
    }

    if (result.moved.length === 0) {
      toast({
        title: 'Load order already correct',
        description:
          result.cycles.length > 0
            ? `Every satisfiable dependency already loads first. ${result.cycles.length} circular dependenc${result.cycles.length === 1 ? 'y' : 'ies'} cannot be ordered.`
            : `All ${result.appliedEdges} declared dependencies already load before the mods that need them.`,
      })
      return
    }

    setAutoSortPreview(result)
  }

  const applyAutoSort = () => {
    if (!autoSortPreview) return
    setOrderedModIds(autoSortPreview.order)
    const movedCount = autoSortPreview.moved.length
    setAutoSortPreview(null)
    toast({
      title: 'Auto-sort applied',
      description: `${movedCount} mod${movedCount === 1 ? '' : 's'} repositioned. Click Save Order to write it to the server INI.`,
    })
  }

  const handleSaveModOrder = async () => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      setSavingModOrder(true)
      await modsApi.saveModOrder(orderedModIds)
      toast({
        title: 'Mod Order Saved',
        description: 'The mod load order has been updated in the server INI.',
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Save Order Failed',
        description: error instanceof Error ? error.message : 'Failed to save mod order',
        variant: 'destructive',
      })
    } finally {
      setSavingModOrder(false)
      busyRef.current = false
    }
  }

  // Move winnerModId in the load order so it loads AFTER loserModId.
  // Used by the inline "Make X win" buttons inside each conflict pair card.
  // Saves immediately and optimistically updates the conflict scan's load-order map
  // so the winner indicators flip without a full rescan.
  const promoteModOverOpponent = async (winnerModId: string, winnerName: string, loserModId: string, loserName: string) => {
    if (busyRef.current) return
    const source = (iniConfig?.modIds && iniConfig.modIds.length > 0) ? iniConfig.modIds : orderedModIds
    const next = [...source]
    const wi = next.indexOf(winnerModId)
    if (wi === -1 || next.indexOf(loserModId) === -1) {
      toast({
        title: 'Cannot reorder',
        description: 'One of these mods is not in the active load order.',
        variant: 'destructive',
      })
      return
    }
    next.splice(wi, 1)
    const newLi = next.indexOf(loserModId)
    next.splice(newLi + 1, 0, winnerModId)

    busyRef.current = true
    try {
      setSavingModOrder(true)
      await modsApi.saveModOrder(next)
      setOrderedModIds(next)
      setConflicts(prev => prev ? { ...prev, modLoadOrder: next } : prev)
      toast({
        title: 'Load order updated',
        description: `${winnerName} now loads after ${loserName}.`,
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Could not update load order',
        description: error instanceof Error ? error.message : 'Failed to save mod order',
        variant: 'destructive',
      })
    } finally {
      setSavingModOrder(false)
      busyRef.current = false
    }
  }

  const hasModOrderChanged = useMemo(() => {
    if (!iniConfig?.modIds) return false
    if (orderedModIds.length !== iniConfig.modIds.length) return true // Different count = changed
    return orderedModIds.some((id, i) => id !== iniConfig.modIds[i])
  }, [orderedModIds, iniConfig?.modIds])

  const removeFromInstallList = (workshopId: string) => {
    setModsToInstall(prev => prev.filter(m => m.workshopId !== workshopId))
  }

  const openWorkshopPage = (workshopId: string) => {
    window.open(`https://steamcommunity.com/sharedfiles/filedetails/?id=${workshopId}`, '_blank', 'noopener,noreferrer')
  }

  const toggleModSelect = useCallback((workshopId: string) => {
    setSelectedMods(prev => {
      const newSet = new Set(prev)
      if (newSet.has(workshopId)) {
        newSet.delete(workshopId)
      } else {
        newSet.add(workshopId)
      }
      return newSet
    })
  }, [])

  const selectAllVisible = () => {
    setSelectedMods(new Set(visibleServerMods.map(mod => mod.workshop_id)))
  }

  const deselectAll = () => {
    setSelectedMods(new Set())
  }

  const handleSaveRestartSettings = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.setRestartOptions({
        warningMinutes: restartWarningMinutes,
        delayIfPlayersOnline: delayIfPlayersOnline,
        maxDelayMinutes: maxDelayMinutes
      })
      toast({
        title: 'Settings Saved',
        description: 'Restart options have been updated',
      })
      setRestartSettingsOpen(false)
      fetchData()
    } catch (error) {
      toast({
        title: 'Settings Save Failed',
        description: error instanceof Error ? error.message : 'Failed to save settings',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleCancelPendingRestart = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.cancelPendingRestart()
      toast({
        title: 'Restart Cancelled',
        description: 'Pending restart has been cancelled',
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Cancel Failed',
        description: error instanceof Error ? error.message : 'Failed to cancel restart',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  // Memoized list of mods with updates available
  const modsWithUpdates = useMemo(() => mods.filter(m => m.update_available), [mods])
  const selectedCollectionCount = useMemo(() => collectionMods.filter(m => m.selected).length, [collectionMods])

  // Render a single mod row — extracted to avoid duplication across groups.
  // Hover-reveal pattern: action cluster + checkbox stay hidden until the row
  // gets hover/focus or when any selection is active. Keeps the resting state
  // calm while still being one keystroke/cursor away from the controls.
  const renderModRow = useCallback((mod: TrackedMod) => {
    const isSelected = selectedMods.has(mod.workshop_id)
    const inConfig = configuredWorkshopIds.has(mod.workshop_id)
    const anySelected = selectedMods.size > 0
    const label = mod.name || `Mod ${mod.workshop_id}`
    const revealClass = isSelected || anySelected
      ? 'opacity-100'
      : 'opacity-0 group-hover/modrow:opacity-100 focus-within:opacity-100'
    return (
      <ModRow
        key={mod.id}
        selected={isSelected}
        leading={
          <div className="flex items-center gap-3">
            <div className={`transition-opacity ${revealClass}`}>
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => toggleModSelect(mod.workshop_id)}
                aria-label={`Select ${label}`}
              />
            </div>
            {/* Leading tile carries the per-mod state colour (update / unchecked / up-to-date). */}
            <WorkshopThumb
              wsId={mod.workshop_id}
              label={label}
              demo={demoMode}
              tone={
                mod.update_available
                  ? 'border-warning/40 bg-warning/10 text-warning'
                  : !mod.last_checked
                    ? 'border-border/50 bg-muted/30 text-muted-foreground'
                    : 'border-primary/25 bg-primary/[0.06] text-primary/85'
              }
              fallbackIcon={<Package className="h-8 w-8" aria-hidden="true" />}
            />
          </div>
        }
        title={
          <span className={`truncate text-sm ${mod.update_available ? 'font-semibold text-foreground' : 'font-medium text-foreground/95'}`}>
            {label}
          </span>
        }
        titleBadges={
          <>
            {/* "Not in Config" first — a mod that can't load is a bigger problem than a stale one. */}
            {!inConfig && (
              <Badge variant="outline" className="h-5 shrink-0 border-destructive/40 bg-destructive/5 text-[10px] text-destructive">
                Not in Config
              </Badge>
            )}
            {mod.update_available ? (
              <Badge variant="warning" className="update-badge-pulse h-5 shrink-0 gap-1 text-[10px]">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" aria-hidden="true" />
                Update
              </Badge>
            ) : null}
          </>
        }
        meta={
          <>
            <WorkshopIdChip
              wsId={mod.workshop_id}
              onCopied={(id) => toast({ title: 'Copied', description: `Workshop ID ${id}` })}
            />
            {mod.last_checked ? (
              <span>Checked {new Date(mod.last_checked).toLocaleDateString()}</span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded border border-dashed border-muted-foreground/30 bg-muted/20 px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground/80">
                <span className="inline-block h-1 w-1 rounded-full bg-muted-foreground/60" aria-hidden="true" />
                Unchecked
              </span>
            )}
          </>
        }
        actions={
          <div className={`flex items-center gap-0.5 transition-opacity ${revealClass}`}>
            <WorkshopLinkAction wsId={mod.workshop_id} label={label} hint="Open Workshop Page" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="iconDense"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => setConfirmRemoveMod(mod.workshop_id)}
                  disabled={loading}
                  aria-label={`Remove mod ${label}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Remove from server</TooltipContent>
            </Tooltip>
          </div>
        }
      />
    )
  }, [demoMode, selectedMods, configuredWorkshopIds, loading, toggleModSelect, toast])

  // ── Virtualized tracked mods list ──
  type ModGroup = 'update' | 'neverChecked' | 'upToDate' | 'deactivated'
  type FlatModItem =
    | { type: 'header'; group: ModGroup; count: number }
    | { type: 'hint' }
    | { type: 'mod'; mod: TrackedMod; group: ModGroup }

  const modListRef = useRef<HTMLDivElement>(null)

  const flatModItems = useMemo<FlatModItem[]>(() => {
    const items: FlatModItem[] = []
    if (groupedMods.updateAvailable.length > 0) {
      items.push({ type: 'header', group: 'update', count: groupedMods.updateAvailable.length })
      for (const mod of groupedMods.updateAvailable) items.push({ type: 'mod', mod, group: 'update' })
    }
    if (groupedMods.neverChecked.length > 0) {
      items.push({ type: 'header', group: 'neverChecked', count: groupedMods.neverChecked.length })
      if (groupedMods.updateAvailable.length === 0 && groupedMods.upToDate.length === 0 && !searchQuery) {
        items.push({ type: 'hint' })
      }
      if (neverCheckedExpanded) {
        for (const mod of groupedMods.neverChecked) items.push({ type: 'mod', mod, group: 'neverChecked' })
      }
    }
    if (groupedMods.upToDate.length > 0) {
      items.push({ type: 'header', group: 'upToDate', count: groupedMods.upToDate.length })
      if (upToDateExpanded) {
        for (const mod of groupedMods.upToDate) items.push({ type: 'mod', mod, group: 'upToDate' })
      }
    }
    return items
  }, [groupedMods, searchQuery, upToDateExpanded, neverCheckedExpanded])

  const modListVirtualizer = useVirtualizer({
    count: flatModItems.length,
    getScrollElement: () => modListRef.current,
    estimateSize: (i) => flatModItems[i].type === 'mod' ? 96 : flatModItems[i].type === 'hint' ? 48 : 40,
    overscan: 10,
  })

  // ── Active Mods sub-tab: memoized derived data ──
  const activeModsData = useMemo(() => {
    const wsMap = iniConfig?.workshopModMap || {}
    const groups: WsGroup[] = []
    for (const wsId of (iniConfig?.workshopIds || [])) {
      const details = wsMap[wsId] || []
      if (details.length === 0) continue
      groups.push({
        wsId,
        mods: details,
        allEnabled: details.every(m => m.enabled),
        someEnabled: details.some(m => m.enabled),
      })
    }
    const allModsList = groups.flatMap(g => g.mods)
    const mappedIds = new Set(allModsList.map(m => m.id))
    const enabledIds = new Set(allModsList.filter(m => m.enabled).map(m => m.id))
    const orphaned = (iniConfig?.modIds || []).filter(id => !mappedIds.has(id))
    // Add orphaned enabled IDs so dependency checks can find them
    for (const id of orphaned) enabledIds.add(id)
    const enabledCount = enabledIds.size
    const multiIdCount = groups.filter(g => g.mods.length > 1).length

    // Build missing-deps map: modId → list of required mod IDs not currently enabled.
    // Resolution (exact id, or a "<required>_<suffix>" / "<required>-<suffix>" fork)
    // is shared with the load-order auto-sort so the two can't disagree.
    const resolveRequirement = createRequirementResolver(enabledIds)
    const isRequireSatisfied = (req: string) => resolveRequirement(req) !== null
    const missingDepsMap = new Map<string, string[]>()
    for (const g of groups) {
      for (const mod of g.mods) {
        if (!mod.require?.length || !mod.enabled) continue
        const missing = mod.require.filter(r => !isRequireSatisfied(r))
        if (missing.length > 0) missingDepsMap.set(mod.id, missing)
      }
    }

    // Build duplicate mod ID map: modId → list of wsIds that provide it
    const modIdProviders = new Map<string, string[]>()
    for (const g of groups) {
      for (const mod of g.mods) {
        const list = modIdProviders.get(mod.id) || []
        list.push(g.wsId)
        modIdProviders.set(mod.id, list)
      }
    }
    const duplicateModIds = new Map<string, string[]>()
    for (const [modId, wsIds] of modIdProviders) {
      if (wsIds.length > 1) duplicateModIds.set(modId, wsIds)
    }

    return { groups, orphaned, enabledCount, multiIdCount, missingDepsMap, duplicateModIds }
  }, [iniConfig?.workshopModMap, iniConfig?.workshopIds, iniConfig?.modIds])

  // ── Sibling conflicts: within a single workshop item, which mod IDs overlap
  //    with each other? These are typically alternatives (e.g. NUDE vs DOLL
  //    texture variants) — usually only one should be enabled at a time.
  //    Pairs the user has dismissed as false positives are excluded so the
  //    Advanced tab doesn't keep nagging about library + dependant combos. ──
  const ignoredPairKeys = useMemo(() => {
    const s = new Set<string>()
    for (const p of ignoredPairs) {
      const a = p.mod_a, b = p.mod_b
      s.add(a < b ? `${a}--${b}` : `${b}--${a}`)
    }
    return s
  }, [ignoredPairs])
  const isPairIgnored = useCallback((a: string, b: string) => {
    return ignoredPairKeys.has(a < b ? `${a}--${b}` : `${b}--${a}`)
  }, [ignoredPairKeys])
  const siblingConflictsMap = useMemo(() => {
    const result = new Map<string, Map<string, Set<string>>>()
    if (!conflicts?.pairs?.length) return result
    // Build modId → wsId lookup from active groups
    const modToWs = new Map<string, string>()
    for (const g of activeModsData.groups) {
      for (const m of g.mods) modToWs.set(m.id, g.wsId)
    }
    for (const pair of conflicts.pairs) {
      const wsA = modToWs.get(pair.modA.modId)
      const wsB = modToWs.get(pair.modB.modId)
      if (!wsA || wsA !== wsB) continue
      // User dismissed this pair as a false positive — skip.
      if (isPairIgnored(pair.modA.modId, pair.modB.modId)) continue
      // Same-workshop conflict — record both directions
      let groupMap = result.get(wsA)
      if (!groupMap) { groupMap = new Map(); result.set(wsA, groupMap) }
      const setA = groupMap.get(pair.modA.modId) || new Set<string>()
      setA.add(pair.modB.modId)
      groupMap.set(pair.modA.modId, setA)
      const setB = groupMap.get(pair.modB.modId) || new Set<string>()
      setB.add(pair.modA.modId)
      groupMap.set(pair.modB.modId, setB)
    }
    return result
  }, [conflicts?.pairs, activeModsData, isPairIgnored])

  const activeModsFiltered = useMemo(() => {
    const { groups } = activeModsData
    const q = deferredModManagerSearch.toLowerCase().trim()
    const filteredGroups = groups
      .map(g => {
        if (!q) return g
        const matchesWs = g.wsId.includes(q)
        if (matchesWs) return g
        const matched = g.mods.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
        if (matched.length === 0) return null
        return { ...g, mods: matched }
      })
      .filter((g): g is WsGroup => g !== null)
    return { filteredGroups }
  }, [activeModsData, deferredModManagerSearch])


  const scanConflicts = useCallback(async () => {
    // Close any previous SSE connection
    if (eventSourceRef.current) {
      closingIntentionallyRef.current = true
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    closingIntentionallyRef.current = false

    setConflictsLoading(true)
    setScanProgress(0)
    setScanCurrentMod(null)
    setScanModsScanned(0)
    setScanTotalMods(0)
    setStreamConflicts([])
    // Cancel any pending rAF from previous scan
    cancelAnimationFrame(scanBatchRef.current.raf)
    scanBatchRef.current = { progress: 0, modName: null, modsScanned: 0, dirty: false, raf: 0 }

    const token = getAccessToken()
    // SSE doesn't support custom headers, so pass token as query param
    const url = `/api/mods/conflicts/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const es = new EventSource(url)
    eventSourceRef.current = es

    // Idle timeout: if no SSE events arrive for 90s, assume connection is dead
    const resetIdleTimer = () => {
      if (sseIdleTimerRef.current) clearTimeout(sseIdleTimerRef.current)
      sseIdleTimerRef.current = setTimeout(() => {
        es.close()
        if (eventSourceRef.current === es) eventSourceRef.current = null
        setConflictsError('Scan timed out — no response from server')
        setConflictsLoading(false)
      }, 90_000)
    }
    resetIdleTimer()

    es.addEventListener('init', (e) => {
      resetIdleTimer()
      try {
        const data = JSON.parse(e.data)
        setConflictsError(null)
        setScanTotalMods(data.totalWorkshopIds || 0)
      } catch (err) { reportClientWarning('SSE init parse error.', err) }
    })

    es.addEventListener('mod-scanned', (e) => {
      resetIdleTimer()
      try {
        const data: ScanStreamModScanned = JSON.parse(e.data)
        // Batch into ref — flush once per frame to avoid 3 setState per SSE event
        const batch = scanBatchRef.current
        batch.progress = data.progress
        batch.modName = data.modName
        batch.modsScanned = data.modsScanned
        if (!batch.dirty) {
          batch.dirty = true
          batch.raf = requestAnimationFrame(() => {
            setScanProgress(batch.progress)
            setScanCurrentMod(batch.modName)
            setScanModsScanned(batch.modsScanned)
            batch.dirty = false
          })
        }
      } catch (err) { reportClientWarning('SSE mod-scanned parse error.', err) }
    })

    es.addEventListener('conflict-found', (e) => {
      resetIdleTimer()
      try {
        const data: ScanStreamConflictFound = JSON.parse(e.data)
        // Keep only the last 50 entries (only 8 are displayed at a time)
        setStreamConflicts(prev => {
          const next = [...prev, data]
          return next.length > 50 ? next.slice(-50) : next
        })
      } catch (err) { reportClientWarning('SSE conflict-found parse error.', err) }
    })

    es.addEventListener('phase', (e) => {
      resetIdleTimer()
      try {
        const data = JSON.parse(e.data)
        setScanProgress(data.progress)
        if (data.phase === 'hashing') setScanCurrentMod('Comparing file contents...')
        if (data.phase === 'grouping') setScanCurrentMod('Grouping results...')
      } catch (err) { reportClientWarning('SSE phase parse error.', err) }
    })

    es.addEventListener('complete', (e) => {
      if (sseIdleTimerRef.current) clearTimeout(sseIdleTimerRef.current)
      try {
        const data = JSON.parse((e as MessageEvent).data)
        // Flush any pending batch before setting final state
        cancelAnimationFrame(scanBatchRef.current.raf)
        scanBatchRef.current.dirty = false
        setConflicts(data)
        setLastScanTime(new Date())
        setScanIniSnapshot(JSON.stringify({
          ws: iniConfig?.workshopIds?.slice().sort() || [],
          mods: iniConfig?.modIds?.slice().sort() || []
        }))
        setScanProgress(100)
      } catch (err) {
        setConflictsError('Failed to parse scan results')
      } finally {
        es.close()
        if (eventSourceRef.current === es) eventSourceRef.current = null
        setConflictsLoading(false)
      }
    })

    es.addEventListener('error', (e) => {
      // Native EventSource fires Event (not MessageEvent) on connection drop.
      // Custom 'error' events from our backend ARE MessageEvents with data.
      if (sseIdleTimerRef.current) clearTimeout(sseIdleTimerRef.current)
      es.close()
      // Only null the ref if this is still the active EventSource (prevents race with re-scan)
      if (eventSourceRef.current === es) eventSourceRef.current = null

      // If we closed intentionally (navigation/unmount), don't show errors.
      // The backend may still finish — cached results will load on re-mount.
      if (closingIntentionallyRef.current) {
        closingIntentionallyRef.current = false
        setConflictsLoading(false)
        return
      }

      const me = e as MessageEvent
      if (typeof me.data === 'string') {
        try {
          const data = JSON.parse(me.data)
          setConflictsError(data.error || 'Scan failed')
        } catch {
          setConflictsError('Scan connection lost')
        }
        setConflictsLoading(false)
        toast({ title: 'Scan Failed', description: 'Lost connection to scan stream', variant: 'destructive' })
      } else {
        // Connection lost — try to recover cached results from backend.
        // Only show the destructive toast if recovery fails; otherwise the
        // user gets a less alarming "showing cached results" notice inline.
        setConflictsLoading(false)
        modsApi.getCachedConflicts().then(cached => {
          if (closingIntentionallyRef.current) return
          if (cached) {
            setConflicts(cached)
            setConflictsError('Scan disconnected — showing previously cached results.')
          } else {
            setConflictsError('Scan connection lost')
            toast({ title: 'Scan Failed', description: 'Lost connection to scan stream', variant: 'destructive' })
          }
        }).catch(() => {
          if (closingIntentionallyRef.current) return
          setConflictsError('Scan connection lost')
          toast({ title: 'Scan Failed', description: 'Lost connection to scan stream', variant: 'destructive' })
        })
      }
    })
  }, [toast, iniConfig?.workshopIds, iniConfig?.modIds])

  useEffect(() => {
    if (!reviewUnresolved || reviewDeepLinkStarted.current) return

    reviewDeepLinkStarted.current = true
    if (!conflicts && !conflictsLoading) void scanConflicts()
  }, [reviewUnresolved, conflicts, conflictsLoading, scanConflicts])

  return (
    <TooltipProvider>
      <div className="space-y-6 page-transition">
        {fetchError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Mod data could not be loaded</AlertTitle>
            <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 break-words" dir="auto">{fetchError}</span>
              <Button variant="outline" size="sm" onClick={fetchData} className="self-start">
                <RefreshCw className="mr-2 h-4 w-4" /> Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {/* Header */}
        <PageHeader
          title="Mod Manager"
          description="Add, update, and configure Steam Workshop mods on your server"
          eyebrow="Workshop"
          tone="maintain"
          icon={<Package className="w-5 h-5" />}
          actions={
            <Button onClick={() => setAdvancedAddOpen(true)} className="gap-2" variant="command">
              <Plus className="w-4 h-4" />
              Add Mod
            </Button>
          }
        />

        {/* Status Bar — only show when mods are tracked */}
        {(status?.totalModsTracked || 0) > 0 && (
        <div className="flex items-center gap-4 rounded-lg border border-border/50 bg-card/60 px-3 py-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Package className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-sm font-medium">{status?.totalModsTracked || 0} on server</span>
          </div>
          <Separator orientation="vertical" className="h-4" />
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 cursor-help">
                <Layers className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-sm font-medium">{iniConfig?.workshopIds?.length || 0} in config</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>{iniConfig?.workshopIds?.length || 0} workshop items in WorkshopItems=</p>
              <p className="text-muted-foreground">{iniConfig?.totalMods || 0} mod IDs in Mods= (some mods register multiple IDs)</p>
            </TooltipContent>
          </Tooltip>
          {modsWithUpdates.length > 0 && (
            <>
              <Separator orientation="vertical" className="h-4" />
              <div className="flex items-center gap-2 text-warning">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span className="text-sm font-medium">{modsWithUpdates.length} updates</span>
              </div>
            </>
          )}

          {/* Workshop ACF Status */}
          {!status?.workshopAcfConfigured && (
            <>
              <Separator orientation="vertical" className="h-4" />
              <div className="flex min-w-0 items-center gap-2 text-destructive" role="status">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span className="text-xs">Workshop path missing</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 border-destructive/30 px-2 text-xs text-foreground hover:bg-destructive/10"
                  onClick={handleOpenWorkshopBrowser}
                  disabled={savingWorkshopPath}
                >
                  <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                  Fix path
                </Button>
              </div>
            </>
          )}

          <div className="ml-auto flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={handleSyncFromServer} disabled={loading}>
                  <Download className="w-3.5 h-3.5 mr-1.5" />
                  Sync
                </Button>
              </TooltipTrigger>
              <TooltipContent>Sync tracked mods from server INI config</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={handleCheckUpdates} disabled={checking}>
                  <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${checking ? 'animate-spin' : ''}`} />
                  Check Updates
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {status?.lastCheck ? (() => {
                  const secs = Math.round((Date.now() - new Date(status.lastCheck).getTime()) / 1000)
                  let when: string
                  if (secs < 60) when = `${secs}s ago`
                  else if (secs < 3600) when = `${Math.floor(secs / 60)}m ago`
                  else if (secs < 86400) when = `${Math.floor(secs / 3600)}h ago`
                  else when = new Date(status.lastCheck).toLocaleDateString()
                  return <span>Last checked {when}</span>
                })() : <span>Never checked</span>}
              </TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label="More actions">
                  <MoreVertical className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setCollectionDialogOpen(true)}>
                  <Library className="w-4 h-4 mr-2" />
                  Import Collection
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setRestartSettingsOpen(true)}>
                  <Settings2 className="w-4 h-4 mr-2" />
                  Auto-Restart Settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm">Auto-restart</span>
                    <Switch
                      checked={status?.autoRestartEnabled || false}
                      onCheckedChange={handleToggleAutoRestart}
                      disabled={loading}
                      aria-label="Toggle auto-restart on mod update"
                    />
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        )}

        {/* Pending Restart Alert */}
        {status?.pendingRestart && (
          <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3 sm:items-center">
              <Clock className="w-5 h-5 animate-pulse text-warning" />
              <div>
                <p className="font-medium text-warning">Restart Pending</p>

            <FolderBrowser
              open={workshopBrowserOpen}
              onOpenChange={setWorkshopBrowserOpen}
              onSelect={handleWorkshopFolderSelected}
              initialPath={workshopBrowserInitialPath}
              title="Choose Project Zomboid server folder"
            />
                <p className="text-xs text-muted-foreground">
                  Waiting for players to leave before restarting (max {status.maxDelayMinutes} min)
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleCancelPendingRestart} disabled={loading} aria-label="Cancel pending restart">
              Cancel
            </Button>
          </div>
        )}

        {/* Stale-flag warning: backend reports N pending updates from live Workshop ACF
            but the per-mod DB flags don't reflect them yet (e.g. last check was rejected,
            or the ACF was rewritten by Steam after a sync). Surface it so it's not invisible
            inside a collapsed group. */}
        {!status?.pendingRestart
          && (status?.updatesAvailable ?? 0) > 0
          && groupedMods.updateAvailable.length === 0
          && !checking && (
          <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3 sm:items-center">
              <AlertTriangle className="w-5 h-5 text-warning" />
              <div>
                <p className="font-medium text-warning">
                  {status?.updatesAvailable} mod update{status?.updatesAvailable === 1 ? '' : 's'} reported by Steam — flags out of sync
                </p>
                <p className="text-xs text-muted-foreground">
                  The Workshop folder shows newer files than the panel has on record. Run a check to update the per-mod state.
                </p>
              </div>
            </div>
            <Button variant="warning" size="sm" onClick={handleCheckUpdates} disabled={loading || checking}>
              <RefreshCw className={`w-4 h-4 mr-2 ${checking ? 'animate-spin' : ''}`} />
              Check Now
            </Button>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[236px_minmax(0,1fr)]">
          <nav aria-label="Mod management sections" className="space-y-4 lg:sticky lg:top-4 lg:self-start">
            {MODS_NAV.map((section) => (
              <div key={section.group}>
                <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
                  {section.group}
                </p>
                <div className="space-y-0.5">
                  {section.items.map((item) => {
                    const isActive = activeTab === item.id
                    const count =
                      item.id === 'deactivated' ? groupedMods.deactivated.length : null
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-current={isActive ? 'true' : undefined}
                        title={item.hint}
                        onClick={() => {
                          setActiveTab(item.id)
                          if (CONFIG_VIEWS.includes(item.id)) {
                            setConfigSubTab(item.id as 'active' | 'order' | 'add' | 'presets' | 'tools')
                          }
                          if (item.id === 'conflicts' && !conflicts && !conflictsLoading) void scanConflicts()
                        }}
                        className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
                          isActive
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 text-sm font-medium">
                            <span className="truncate">{item.label}</span>
                            {item.id === 'order' && hasModOrderChanged && (
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                            )}
                            {count != null && count > 0 && (
                              <span
                                className={`ml-auto shrink-0 rounded-full px-1.5 font-mono text-[10px] tabular-nums ${
                                  isActive ? 'bg-primary-foreground/20' : 'bg-muted-foreground/20'
                                }`}
                              >
                                {count}
                              </span>
                            )}
                          </span>
                          <span
                            className={`mt-0.5 block text-[11px] leading-snug ${
                              isActive ? 'text-primary-foreground/75' : 'text-muted-foreground/70'
                            }`}
                          >
                            {item.hint}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </nav>

          <div className="min-w-0 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                {MODS_NAV.flatMap((s) => s.items).find((i) => i.id === activeTab)?.label}
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {MODS_NAV.flatMap((s) => s.items).find((i) => i.id === activeTab)?.hint}
              </p>
            </div>

            {/* Import Collection Dialog */}
            <Dialog
              open={collectionDialogOpen}
              onOpenChange={(open) => {
                setCollectionDialogOpen(open)
                if (!open) {
                  setShowCollectionAdvanced(false)
                  setCollectionImported(false)
                  setCollectionUrl('')
                  setCollectionMods([])
                }
              }}
            >
                <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto sm:max-h-[80vh]">
                  <DialogHeader>
                    <DialogTitle>Import Steam Workshop Collection</DialogTitle>
                    <DialogDescription>
                      Paste a collection URL to add all its mods to your server config at once
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="collection-url-input">Collection URL or ID</Label>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          id="collection-url-input"
                          value={collectionUrl}
                          onChange={(e) => setCollectionUrl(e.target.value)}
                          placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=..."
                          maxLength={200}
                          autoFocus
                        />
                        <Button onClick={handleImportCollection} disabled={importingCollection} className="w-full sm:w-auto">
                          {importingCollection ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <Download className="w-4 h-4" />
                          )}
                        </Button>
                      </div>
                    </div>

                    {collectionImported && collectionMods.length === 0 && !importingCollection && (
                      <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        No mods found in this collection. Check the URL and try again.
                      </div>
                    )}

                    {collectionMods.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <Label>Found {collectionMods.length} mods</Label>
                          <div className="flex gap-2 flex-wrap justify-end">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setShowCollectionAdvanced(!showCollectionAdvanced)}
                            >
                              {showCollectionAdvanced ? 'Hide Advanced Fields' : 'Edit IDs and Maps'}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setCollectionMods(prev => prev.map(m => ({ ...m, selected: true })))}
                            >
                              Select All
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setCollectionMods(prev => prev.map(m => ({ ...m, selected: false })))}
                            >
                              Deselect All
                            </Button>
                          </div>
                        </div>
                        <ScrollArea className="h-[min(48vh,22rem)] border rounded-lg p-2 sm:h-[min(52vh,24rem)]">
                          <div className="space-y-2">
                            {collectionMods.map((mod) => {
                              const alreadyInstalled = iniConfig?.workshopIds?.includes(mod.workshopId)
                              return (
                              <div
                                key={mod.workshopId}
                                className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${mod.selected ? 'border-primary/30 bg-primary/10' : 'bg-card/60 hover:bg-accent/20'}`}
                              >
                                <Checkbox
                                  checked={mod.selected}
                                  onCheckedChange={() => toggleModSelection(mod.workshopId)}
                                aria-label={`Select ${mod.name}`}
                                />
                                <div className="flex-1 space-y-1 min-w-0">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="font-medium text-sm truncate">{mod.name}</span>
                                    {alreadyInstalled && (
                                      <Badge variant="outline" className="text-xs text-muted-foreground">
                                        Installed
                                      </Badge>
                                    )}
                                    {mod.isMap && (
                                      <Badge variant="secondary" className="text-xs">
                                        <MapIcon className="w-3 h-3 mr-1" />
                                        Map
                                      </Badge>
                                    )}
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    ID: {mod.workshopId}
                                  </p>
                                  {mod.selected && showCollectionAdvanced && (
                                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                      <div>
                                        <Label className="text-xs" htmlFor={`collection-mod-id-${mod.workshopId}`}>Mod ID</Label>
                                        <Input
                                          id={`collection-mod-id-${mod.workshopId}`}
                                          value={mod.modId || ''}
                                          onChange={(e) => updateModId(mod.workshopId, e.target.value)}
                                          placeholder="From info.txt"
                                          maxLength={200}
                                          className="h-7 text-xs"
                                        />
                                      </div>
                                      {mod.isMap && (
                                        <div>
                                          <Label className="text-xs" htmlFor={`collection-map-folder-${mod.workshopId}`}>Map Folder</Label>
                                          <Input
                                            id={`collection-map-folder-${mod.workshopId}`}
                                            value={mod.mapFolder || ''}
                                            onChange={(e) => updateMapFolder(mod.workshopId, e.target.value)}
                                            placeholder="MapFolderName"
                                            maxLength={200}
                                            className="h-7 text-xs"
                                          />
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                                <Button
                                  size="iconDense"
                                  variant="ghost"
                                  className="h-10 w-10 sm:h-10 sm:w-10"
                                  onClick={() => openWorkshopPage(mod.workshopId)}
                                  aria-label="Open workshop page (opens in new tab)"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                </Button>
                              </div>
                            )})}
                          </div>
                        </ScrollArea>
                      </div>
                    )}
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setCollectionDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      onClick={handleAddCollectionMods}
                      disabled={loading || selectedCollectionCount === 0}
                    >
                      {loading ? 'Adding...' : `Add ${selectedCollectionCount} Mods to Server`}
                    </Button>
                  </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Add Single Mod Dialog - Improved with Multi-ID support */}
            <Dialog open={advancedAddOpen} onOpenChange={(open) => {
                setAdvancedAddOpen(open)
                if (!open) {
                  setAdvancedModInput('')
                  setDiscoveredMod(null)
                  setSelectedModIds(new Set())
                  setShowAdvancedIdSelection(false)
                  lastAutoDiscoverIdRef.current = null
                  if (autoDiscoverTimeoutRef.current) {
                    clearTimeout(autoDiscoverTimeoutRef.current)
                    autoDiscoverTimeoutRef.current = null
                  }
                }
              }}>
                <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto sm:max-h-[80vh]">
                  <DialogHeader>
                    <DialogTitle>Add Workshop Mod</DialogTitle>
                    <DialogDescription>
                      Paste a Steam Workshop URL or ID — or{' '}
                      <button
                        type="button"
                        className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 rounded-sm"
                        onClick={() => { setAdvancedAddOpen(false); setCollectionDialogOpen(true) }}
                      >
                        import an entire collection
                      </button>.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    {/* Input section */}
                    <div className="space-y-2">
                      <Label htmlFor="advanced-mod-input" className="sr-only">Workshop URL or ID</Label>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          id="advanced-mod-input"
                          value={advancedModInput}
                          onChange={(e) => handleModInputChange(e.target.value)}
                          placeholder="Paste Workshop URL or enter ID..."
                          onKeyDown={(e) => e.key === 'Enter' && !discoveringMod && handleDiscoverMod()}
                          className="font-mono text-sm"
                          maxLength={200}
                        />
                        <Button
                          id="discover-mod-btn"
                          onClick={handleDiscoverMod}
                          disabled={discoveringMod || !advancedModInput.trim()}
                          variant="secondary"
                          className="w-full shrink-0 sm:w-auto"
                        >
                          {discoveringMod ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <>
                              <Search className="w-4 h-4 mr-1" />
                              Discover
                            </>
                          )}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Example: https://steamcommunity.com/sharedfiles/filedetails/?id=3616536783
                      </p>
                    </div>

                    {/* Loading skeleton */}
                    {discoveringMod && (
                      <div className="space-y-3 p-4 border rounded-lg bg-muted/30 animate-pulse">
                        <div className="flex items-start justify-between">
                          <div className="space-y-2 flex-1">
                            <div className="h-4 bg-muted rounded w-3/4" />
                            <div className="h-3 bg-muted rounded w-1/2" />
                          </div>
                          <div className="h-5 bg-muted rounded w-16" />
                        </div>
                        <div className="space-y-1.5">
                          <div className="h-8 bg-muted rounded" />
                          <div className="h-8 bg-muted rounded" />
                        </div>
                      </div>
                    )}

                    {/* Discovered mod info */}
                    {discoveredMod && !discoveringMod && (
                      <div className="space-y-3 p-3 border rounded-lg bg-muted/30">
                        {/* Mod header */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <h4 className="font-medium text-sm truncate" title={discoveredMod.name}>
                              {discoveredMod.name}
                            </h4>
                            <div className="flex items-center gap-2 mt-0.5">
                              <code className="text-xs text-muted-foreground font-mono">
                                {discoveredMod.workshopId}
                              </code>
                              <button
                                onClick={() => window.open(`https://steamcommunity.com/sharedfiles/filedetails/?id=${discoveredMod.workshopId}`, '_blank', 'noopener,noreferrer')}
                                className="text-xs text-primary hover:underline flex items-center gap-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 rounded-sm"
                              >
                                <ExternalLink className="w-3 h-3" />
                                View
                              </button>
                            </div>
                          </div>
                          <div className="flex gap-1 shrink-0">
                            {discoveredMod.isMap && (
                              <Badge variant="secondary" className="text-xs h-5">
                                <MapIcon className="w-3 h-3 mr-1" />
                                Map
                              </Badge>
                            )}
                            {discoveredMod.isDownloaded ? (
                              <Badge variant="success" className="text-xs h-5">
                                <CheckCircle className="w-3 h-3 mr-1" />
                                Downloaded
                              </Badge>
                            ) : (
                              <Badge variant="warning" className="text-xs h-5">
                                <Download className="w-3 h-3 mr-1" />
                                Not Downloaded
                              </Badge>
                            )}
                          </div>
                        </div>

                        {/* Already added warning */}
                        {discoveredMod.isAlreadyAdded && (
                          <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 p-2 text-xs text-foreground">
                            <Info className="w-4 h-4 text-primary shrink-0" />
                            <span>Workshop ID is already in your server config</span>
                          </div>
                        )}

                        {/* Mod IDs selection */}
                        {discoveredMod.modIds.length > 0 ? (
                          <div className="space-y-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <Label className="text-xs font-medium">
                                {discoveredMod.hasMultipleModIds
                                  ? `Mod IDs (${selectedModIds.size} of ${discoveredMod.modIds.length} selected)`
                                  : 'Mod ID'}
                              </Label>
                              {discoveredMod.hasMultipleModIds && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs px-2.5"
                                  onClick={() => setShowAdvancedIdSelection(!showAdvancedIdSelection)}
                                >
                                  {showAdvancedIdSelection ? 'Hide' : 'Review IDs'}
                                </Button>
                              )}
                            </div>

                            {discoveredMod.hasMultipleModIds && !showAdvancedIdSelection ? (
                              <p className="text-xs text-muted-foreground">
                                New IDs are pre-selected automatically. Open Review IDs to manually adjust selection.
                              </p>
                            ) : (
                              <>
                                {discoveredMod.hasMultipleModIds && (
                                  <div className="flex flex-wrap gap-1.5">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 text-xs px-2.5"
                                      onClick={() => {
                                        const newIds = discoveredMod.modIds.filter(
                                          id => !discoveredMod.alreadyConfigured?.includes(id)
                                        )
                                        setSelectedModIds(new Set(newIds))
                                      }}
                                    >
                                      Select New
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 text-xs px-2.5"
                                      onClick={() => {
                                        if (selectedModIds.size === discoveredMod.modIds.length) {
                                          setSelectedModIds(new Set())
                                        } else {
                                          setSelectedModIds(new Set(discoveredMod.modIds))
                                        }
                                      }}
                                    >
                                      {selectedModIds.size === discoveredMod.modIds.length ? 'None' : 'All'}
                                    </Button>
                                  </div>
                                )}
                                <div className="space-y-1 max-h-[50vh] overflow-y-auto rounded-lg border border-border/50 bg-background/50 p-1.5">
                                  {discoveredMod.modIds.map((modId) => {
                                    const isConfigured = discoveredMod.alreadyConfigured?.includes(modId)
                                    return (
                                      <div
                                        key={modId}
                                        role="button"
                                        tabIndex={0}
                                        aria-pressed={selectedModIds.has(modId)}
                                        className={`flex items-center gap-2 px-2.5 py-1.5 rounded cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${
                                          selectedModIds.has(modId)
                                            ? 'bg-primary/10 border-l-2 border-l-primary'
                                            : isConfigured
                                              ? 'bg-muted/30 opacity-70'
                                              : 'hover:bg-muted/40'
                                        }`}
                                        onClick={() => toggleModIdSelection(modId)}
                                        onKeyDown={(event) => {
                                          if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault()
                                            toggleModIdSelection(modId)
                                          }
                                        }}
                                      >
                                        <Checkbox
                                          checked={selectedModIds.has(modId)}
                                          onCheckedChange={() => toggleModIdSelection(modId)}
                                        aria-label={`Select mod ID ${modId}`}
                                        />
                                        <code className="text-xs font-mono flex-1 truncate" title={modId}>
                                          {modId}
                                        </code>
                                        {isConfigured && (
                                          <Badge variant="outline" className="text-xs h-5 shrink-0 text-muted-foreground">
                                            Exists
                                          </Badge>
                                        )}
                                      </div>
                                    )
                                  })}
                                </div>
                              </>
                            )}
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs">
                            <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
                            <div>
                              <p className="font-medium text-warning">
                                {discoveredMod.isDownloaded
                                  ? 'No mod.info files found'
                                  : 'Mod not yet downloaded'}
                              </p>
                              <p className="text-muted-foreground mt-0.5">
                                {discoveredMod.isDownloaded
                                  ? 'This mod may use an unconventional structure'
                                  : 'Add the Workshop ID and sync after server downloads it'}
                              </p>
                            </div>
                          </div>
                        )}

                        {/* Map folders info */}
                        {discoveredMod.mapFolders.length > 0 && (
                          <div className="flex items-start gap-2 text-xs">
                            <MapIcon className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                            <div>
                              <span className="font-medium">Map folders will be added:</span>
                              <div className="text-muted-foreground mt-0.5">
                                {discoveredMod.mapFolders.join(', ')}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <DialogFooter className="flex-col sm:flex-row gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setAdvancedAddOpen(false)}
                      className="w-full sm:order-1 sm:w-auto"
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleAddModAdvanced}
                      disabled={loading || !discoveredMod || discoveringMod}
                      className="w-full sm:order-2 sm:w-auto"
                    >
                      {loading ? (
                        <>
                          <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                          Adding...
                        </>
                      ) : discoveredMod?.modIds.length ? (
                        selectedModIds.size > 0
                          ? `Add ${selectedModIds.size} Mod ID${selectedModIds.size !== 1 ? 's' : ''}`
                          : 'Add Workshop ID Only'
                      ) : discoveredMod ? (
                        'Add Workshop ID'
                      ) : (
                        'Discover First'
                      )}
                    </Button>
                  </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Restart Settings Dialog */}
            <Dialog open={restartSettingsOpen} onOpenChange={setRestartSettingsOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Auto-Restart Settings</DialogTitle>
                    <DialogDescription>
                      Configure how the server restarts when mod updates are detected
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="restart-warning-minutes">Warning Time (minutes)</Label>
                      <Input
                        id="restart-warning-minutes"
                        type="number"
                        min="0"
                        max="30"
                        value={restartWarningMinutes}
                        onChange={(e) => setRestartWarningMinutes(parseInt(e.target.value, 10) || 0)}
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        How long to wait before restarting after detecting updates
                      </p>
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-border/70 bg-card/65 p-3">
                      <div className="space-y-1">
                        <Label>Delay if Players Online</Label>
                        <p className="text-xs text-muted-foreground">
                          Wait for all players to leave before restarting
                        </p>
                      </div>
                      <Switch
                        checked={delayIfPlayersOnline}
                        onCheckedChange={setDelayIfPlayersOnline}
                      />
                    </div>

                    {delayIfPlayersOnline && (
                      <div>
                        <Label htmlFor="restart-max-delay">Maximum Delay (minutes)</Label>
                        <Input
                          id="restart-max-delay"
                          type="number"
                          min="5"
                          max="120"
                          value={maxDelayMinutes}
                          onChange={(e) => setMaxDelayMinutes(parseInt(e.target.value, 10) || 30)}
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                          Force restart after this time even if players are online
                        </p>
                      </div>
                    )}

                    <div className="rounded-lg border border-border/70 bg-secondary/40 p-3">
                      <p className="text-sm font-medium mb-2">Current Settings</p>
                      <div className="text-xs text-muted-foreground space-y-1">
                        <p>• Warning time: {restartWarningMinutes} minutes</p>
                        <p>• Delay for players: {delayIfPlayersOnline ? 'Yes' : 'No'}</p>
                        {delayIfPlayersOnline && <p>• Max delay: {maxDelayMinutes} minutes</p>}
                      </div>
                    </div>
                  </div>
                  <DialogFooter className="flex-col sm:flex-row gap-2">
                    <Button variant="outline" onClick={() => setRestartSettingsOpen(false)} className="w-full sm:w-auto">
                      Cancel
                    </Button>
                    <Button onClick={handleSaveRestartSettings} disabled={loading} className="w-full sm:w-auto">
                      {loading ? 'Saving...' : 'Save Settings'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
            </Dialog>
          </div>

          {/* Server Mods Tab — auto-tracks every workshop ID in the server INI. */}
          {activeTab === 'installed' && (
          <div className="space-y-4">
            {/* Search and Filters */}
            {mods.length > 0 && (
            <div className="flex items-center gap-4 flex-wrap">
              <div className="relative min-w-0 basis-full sm:basis-auto sm:flex-1 sm:max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder="Search mods..."
                  maxLength={200}
                  className="pl-9"
                  aria-label="Search mods"
                />
              </div>

              <Button
                variant={showUpdatesOnly ? "secondary" : "outline"}
                size="sm"
                onClick={() => setShowUpdatesOnly(!showUpdatesOnly)}
                aria-pressed={showUpdatesOnly}
                className={showUpdatesOnly ? "w-full border-warning/40 bg-warning/15 text-warning hover:bg-warning/25 sm:w-auto" : "w-full sm:w-auto"}
              >
                {showUpdatesOnly ? <Check className="w-4 h-4 mr-2" /> : <Filter className="w-4 h-4 mr-2" />}
                Updates Only
              </Button>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={showDisabled ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => {
                      const next = !showDisabled
                      setShowDisabled(next)
                      if (next) fetchDisabled()
                    }}
                    aria-pressed={showDisabled}
                    className="w-full sm:w-auto"
                  >
                    {showDisabled ? <EyeOff className="w-4 h-4 mr-2" /> : <Eye className="w-4 h-4 mr-2" />}
                    {showDisabled ? 'Hide disabled' : 'Show disabled'}
                    {showDisabled && disabledMods.length > 0 && (
                      <span className="ml-2 inline-flex items-center justify-center rounded-full bg-muted/40 px-1.5 text-[10px] font-medium tabular-nums">
                        {disabledMods.length}
                      </span>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Mods downloaded to disk but not enabled in the server INI</TooltipContent>
              </Tooltip>

              {/* Workshop collection sync indicator. Shown only when an admin
                  has wired up a collection ID. Clicking the chip refreshes
                  the diff; the inline button performs the actual sync. */}
              {collectionStatus.configured && (
                collectionStatus.error ? (
                  <button
                    type="button"
                    onClick={fetchCollectionStatus}
                    title={`Collection sync error: ${collectionStatus.error}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/20 transition-colors"
                  >
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Collection error
                  </button>
                ) : collectionStatus.inSync ? (
                  <button
                    type="button"
                    onClick={fetchCollectionStatus}
                    title={collectionStatus.title ? `In sync with "${collectionStatus.title}"` : 'Collection mirrors tracked mods'}
                    className="inline-flex items-center gap-1.5 rounded-md border border-success/40 bg-success/10 px-2.5 py-1 text-xs font-medium text-success hover:bg-success/20 transition-colors"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Collection in sync
                    {collectionStatus.autoSync && <span className="text-[10px] opacity-70">· auto</span>}
                  </button>
                ) : collectionStatus.drift > 0 ? (
                  <div className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 pl-2.5 pr-1 py-0.5 text-xs font-medium text-warning">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>{collectionStatus.drift} drift</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={handleCollectionSyncNow}
                      disabled={collectionSyncing}
                      className="h-6 px-2 ml-1 text-xs hover:bg-warning/20"
                      title="Sync tracked mods → Steam Workshop collection"
                    >
                      {collectionSyncing ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Sync'}
                    </Button>
                  </div>
                ) : collectionStatus.loading ? (
                  <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Checking collection…
                  </span>
                ) : null
              )}

              {selectedMods.size > 0 && (
                <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto bulk-bar-enter">
                  <span className="text-sm text-muted-foreground">
                    {selectedMods.size} selected
                  </span>
                  <Button variant="outline" size="sm" onClick={deselectAll}>
                    Deselect
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => setConfirmBulkRemove(true)} disabled={loading}>
                    <Trash2 className="w-4 h-4 mr-2" />
                    Remove
                  </Button>
                </div>
              )}

              {selectedMods.size === 0 && visibleServerMods.length > 0 && (
                <Button variant="ghost" size="sm" onClick={selectAllVisible} className="ml-auto w-full sm:w-auto">
                  Select All ({visibleServerMods.length})
                </Button>
              )}
            </div>
            )}

            {/* Mods List — grouped by status */}
            <Card>
              <CardContent className="p-0">
                {filteredMods.length === 0 ? (
                  searchQuery ? (
                    <div className="p-6">
                      <EmptyState
                        type="noResults"
                        title="No mods match your search"
                        description="Try a different search term, or clear the filter."
                        action={{ label: 'Clear search', onClick: () => handleSearchChange(''), variant: 'outline' }}
                      />
                    </div>
                  ) : (
                    <div className="px-4 py-10 sm:px-8">
                      <div className="mx-auto max-w-2xl">
                        {/* Hero */}
                        <div className="flex flex-col items-center text-center mb-6">
                          <div className="relative mb-4" aria-hidden="true">
                            <div className="absolute inset-0 rounded-2xl bg-primary/15 blur-xl" />
                            <div className="relative w-16 h-16 rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center">
                              <Package className="w-8 h-8 text-primary" />
                            </div>
                          </div>
                          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/80">
                            No mods tracked yet
                          </p>
                          <h3 className="text-base font-semibold text-foreground">Add Workshop mods to start managing them</h3>
                          <p className="mt-1.5 text-sm text-muted-foreground max-w-md leading-relaxed">
                            The panel watches tracked mods for Workshop updates, surfaces conflicts, and lets you reorder load order with one click.
                          </p>
                        </div>

                        {/* 3 paths to populate the list */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-5">
                          <button
                            type="button"
                            onClick={handleSyncFromServer}
                            disabled={loading}
                            className="group text-left rounded-lg border border-border/50 hover:border-primary/40 hover:bg-primary/[0.04] bg-muted/15 px-3 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                          >
                            <div className="flex items-center gap-2 mb-1.5">
                              <RefreshCw className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
                              <span className="text-xs font-semibold text-foreground/90">Sync from server</span>
                              <ChevronRight className="w-3 h-3 ml-auto text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all" aria-hidden="true" />
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-snug">
                              Imports the WorkshopItems and Mods= lines from your active server config.
                            </p>
                            <p className="mt-1.5 text-[10px] uppercase tracking-wider text-primary/70">Recommended</p>
                          </button>

                          <button
                            type="button"
                            onClick={() => setCollectionDialogOpen(true)}
                            disabled={loading}
                            className="group text-left rounded-lg border border-border/50 hover:border-primary/40 hover:bg-primary/[0.04] bg-muted/15 px-3 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                          >
                            <div className="flex items-center gap-2 mb-1.5">
                              <Library className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
                              <span className="text-xs font-semibold text-foreground/90">Import a Collection</span>
                              <ChevronRight className="w-3 h-3 ml-auto text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all" aria-hidden="true" />
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-snug">
                              Paste a Steam Workshop collection URL to add every mod in it at once.
                            </p>
                          </button>

                          <button
                            type="button"
                            onClick={() => setAdvancedAddOpen(true)}
                            disabled={loading}
                            className="group text-left rounded-lg border border-border/50 hover:border-primary/40 hover:bg-primary/[0.04] bg-muted/15 px-3 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                          >
                            <div className="flex items-center gap-2 mb-1.5">
                              <PlusCircle className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
                              <span className="text-xs font-semibold text-foreground/90">Add a single mod</span>
                              <ChevronRight className="w-3 h-3 ml-auto text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all" aria-hidden="true" />
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-snug">
                              Track a specific mod by its Workshop ID or full URL.
                            </p>
                          </button>
                        </div>

                        <p className="text-[11px] text-center text-muted-foreground/70 flex items-center justify-center gap-1.5">
                          <Info className="w-3 h-3" aria-hidden="true" />
                          Tracking is metadata only — mods are downloaded by your server, not the panel.
                        </p>
                      </div>
                    </div>
                  )
                ) : (
                  <div ref={modListRef} className="h-[calc(100vh-340px)] min-h-[300px] overflow-y-auto">
                    <div style={{ height: modListVirtualizer.getTotalSize(), position: 'relative' }}>
                      {modListVirtualizer.getVirtualItems().map(virtualRow => {
                        const item = flatModItems[virtualRow.index]
                        const groupBorder =
                          item.type === 'hint' ? 'border-l-2 border-muted-foreground/30'
                          : item.group === 'update' ? 'border-l-2 border-warning'
                          : item.group === 'neverChecked' ? 'border-l-2 border-muted-foreground/30'
                          : 'border-l-2 border-primary/30'

                        return (
                          <div
                            key={virtualRow.key}
                            className={groupBorder}
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              transform: `translateY(${virtualRow.start}px)`,
                            }}
                          >
                            {item.type === 'header' && item.group === 'update' && (
                              <div className="flex items-center gap-2.5 bg-warning/10 px-4 py-2.5 border-b border-warning/25">
                                <span className="relative inline-flex shrink-0" aria-hidden="true">
                                  <span className="absolute inset-0 rounded-full bg-warning/40 animate-ping" />
                                  <span className="relative w-2 h-2 rounded-full bg-warning" />
                                </span>
                                <span className="text-sm font-semibold text-warning">
                                  Updates Available
                                </span>
                                <span className="inline-flex h-5 items-center rounded-full bg-warning/20 px-2 font-mono text-[11px] tabular-nums text-warning">
                                  {item.count}
                                </span>
                              </div>
                            )}
                            {item.type === 'header' && item.group === 'neverChecked' && (
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 bg-muted/20 px-4 py-2 border-b border-border/40 hover:bg-muted/30 transition-colors text-left"
                                onClick={() => setNeverCheckedExpanded(!neverCheckedExpanded)}
                                aria-expanded={neverCheckedExpanded}
                              >
                                <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${neverCheckedExpanded ? 'rotate-90' : ''}`} />
                                <Clock className="w-4 h-4 text-muted-foreground" />
                                <span className="text-sm font-medium text-muted-foreground">
                                  Never Checked
                                </span>
                                <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
                                  {item.count}
                                </span>
                                {!neverCheckedExpanded && (
                                  <span className="ml-auto text-[11px] text-muted-foreground/70">
                                    Click to expand · or use <kbd className="rounded border border-border/60 bg-muted/40 px-1 py-0 font-mono text-[10px]">Check Updates</kbd>
                                  </span>
                                )}
                              </button>
                            )}
                            {item.type === 'header' && item.group === 'upToDate' && (
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 bg-primary/5 px-4 py-2 border-b border-border/40 hover:bg-primary/10 transition-colors text-left"
                                onClick={() => setUpToDateExpanded(!upToDateExpanded)}
                                aria-expanded={upToDateExpanded}
                              >
                                <ChevronRight className={`w-4 h-4 text-primary transition-transform ${upToDateExpanded ? 'rotate-90' : ''}`} />
                                <CheckCircle className="w-4 h-4 text-primary" />
                                <span className="text-sm font-medium text-primary">
                                  Up to Date
                                </span>
                                <span className="font-mono text-[11px] tabular-nums text-primary/80">
                                  {item.count}
                                </span>
                              </button>
                            )}
                            {item.type === 'hint' && (
                              <div className="flex items-center gap-3 bg-primary/5 border-b border-border/40 px-4 py-3">
                                <RefreshCw className="w-4 h-4 text-primary shrink-0" />
                                <p className="text-sm text-muted-foreground">
                                  Click <strong className="text-foreground">Check Updates</strong> above to scan all mods for new versions.
                                </p>
                              </div>
                            )}
                            {item.type === 'mod' && (
                              <div className="border-b border-border/30">
                                {renderModRow(item.mod)}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ─── Disabled mods ──────────────────────────────────────────
                Mods downloaded into the Workshop content folder but not in
                the server INI's WorkshopItems= list. Hidden by default; the
                "Show disabled" toggle in the filter bar reveals this panel
                and triggers a one-shot fetch. Each row offers a quick Enable
                that adds it to the INI (and lifts any prior ignore-list
                entry so auto-track picks it up). */}
            {showDisabled && (
              <div className="rounded-lg border border-dashed border-border/50 bg-card/40">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30">
                  <div className="flex items-center gap-2 text-sm">
                    <EyeOff className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="font-medium text-muted-foreground">Disabled mods on disk</span>
                    {!disabledLoading && (
                      <span className="text-xs text-muted-foreground/70">
                        — downloaded but not loaded by the server
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={fetchDisabled}
                      disabled={disabledLoading}
                    >
                      {disabledLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      <span className="ml-1.5">Refresh</span>
                    </Button>
                    {disabledMods.length > 0 && !disabledLoading && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={handleDeleteAllDisabled}
                        disabled={deletingId !== null || loading}
                      >
                        {deletingId === '__batch_disabled__' ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                        <span className="ml-1.5">Delete all</span>
                      </Button>
                    )}
                  </div>
                </div>
                {disabledLoading ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                    Scanning workshop folder…
                  </div>
                ) : disabledMods.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No disabled mods. Everything in the workshop folder is enabled in the server INI.
                  </div>
                ) : (
                  <div className="divide-y divide-border/30">
                    {disabledMods.map((mod) => (
                      <div key={mod.workshop_id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                        <div className="flex items-center gap-2 min-w-0 opacity-70">
                          <Package className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
                          <span className="truncate">{mod.name}</span>
                          <span className="text-xs text-muted-foreground/60 tabular-nums shrink-0">{mod.workshop_id}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <a
                                href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.workshop_id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex"
                              >
                                <Button variant="ghost" size="iconDense" className="h-7 w-7 text-muted-foreground hover:text-primary">
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </Button>
                              </a>
                            </TooltipTrigger>
                            <TooltipContent>Open Workshop page</TooltipContent>
                          </Tooltip>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2.5 text-xs"
                            onClick={() => handleEnableDiskMod(mod.workshop_id)}
                            disabled={enablingId === mod.workshop_id || deletingId !== null || loading}
                          >
                            {enablingId === mod.workshop_id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <>
                                <Plus className="w-3.5 h-3.5 mr-1" />
                                Enable
                              </>
                            )}
                          </Button>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="iconDense"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                onClick={() => handleDeleteDiskMod(mod.workshop_id, mod.name)}
                                disabled={deletingId !== null || enablingId === mod.workshop_id || loading}
                              >
                                {deletingId === mod.workshop_id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="w-3.5 h-3.5" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Delete from disk</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Ignored Mods — collapsible section */}
            {ignoredMods.length > 0 && (
              <div className="rounded-lg border border-border/30 bg-card/50">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setIgnoredModsOpen(!ignoredModsOpen)}
                >
                  <span className="flex items-center gap-2">
                    <EyeOff className="w-3.5 h-3.5" />
                    {ignoredMods.length} ignored mod{ignoredMods.length !== 1 ? 's' : ''}
                    <span className="text-xs opacity-60">— won't be re-added by auto-sync</span>
                  </span>
                  <ChevronRight className={`w-4 h-4 transition-transform ${ignoredModsOpen ? 'rotate-90' : ''}`} />
                </button>
                {ignoredModsOpen && (
                  <div className="border-t border-border/30 px-4 py-2 space-y-1">
                    {ignoredMods.map((mod) => (
                      <div key={mod.workshop_id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                        <div className="flex items-center gap-2 min-w-0">
                          <EyeOff className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                          <span className="truncate text-muted-foreground">{mod.name || `Workshop Mod ${mod.workshop_id}`}</span>
                          <span className="text-xs text-muted-foreground/50 tabular-nums shrink-0">{mod.workshop_id}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => handleUnignoreMod(mod.workshop_id)}
                            disabled={loading || deletingId !== null}
                          >
                            Re-track
                          </Button>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="iconDense"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                onClick={() => handleDeleteDiskMod(mod.workshop_id, mod.name || undefined)}
                                disabled={deletingId !== null || loading}
                              >
                                {deletingId === mod.workshop_id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="w-3.5 h-3.5" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Delete from disk</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    ))}
                    <div className="flex justify-end gap-1 pt-1 pb-0.5 border-t border-border/20 mt-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={handleDeleteAllIgnoredFromDisk}
                        disabled={loading || deletingId !== null}
                      >
                        {deletingId === '__batch_ignored__' ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                        <span className="ml-1.5">Delete all from disk</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                        onClick={handleClearAllIgnored}
                        disabled={loading || deletingId !== null}
                      >
                        Clear all ignored
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          )}

          {/* Server Config Tab */}
          {CONFIG_VIEWS.includes(activeTab) && (
          <div className="space-y-4">
            {iniConfig?.configured ? (
              <>
                {/* ─── Summary bar ───
                    Hidden in the Active Mods sub-tab, where the per-row toolbar
                    already shows the more-useful "enabled / total" count. */}
                {configSubTab !== 'active' && (
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="tabular-nums">{iniConfig.totalMods} <span className="opacity-50">mods</span></span>
                    <span className="tabular-nums">{iniConfig.workshopIds.length} <span className="opacity-50">workshop item{iniConfig.workshopIds.length !== 1 ? 's' : ''}</span></span>
                    <span className="tabular-nums">{iniConfig.maps.length} <span className="opacity-50">map{iniConfig.maps.length !== 1 ? 's' : ''}</span></span>
                  </div>
                )}

                {/* ═══ ACTIVE MODS SUB-TAB ═══ */}
                {configSubTab === 'active' && (() => {
                  const { orphaned, enabledCount, multiIdCount, groups, missingDepsMap, duplicateModIds } = activeModsData
                  const { filteredGroups } = activeModsFiltered

                  // What actually warrants a red flag: two enabled variants the
                  // scanner confirmed overlap, an enabled mod whose required ID
                  // isn't loaded, or an ID claimed by two Workshop items.
                  // A partial "1 of 5 enabled" is normal and is NOT a problem.
                  const groupAttention = (g: WsGroup) => {
                    const enabledSet = new Set(g.mods.filter(m => m.enabled).map(m => m.id))
                    const siblings = siblingConflictsMap.get(g.wsId)
                    let clash = false
                    if (siblings) {
                      for (const [modId, sibs] of siblings) {
                        if (!enabledSet.has(modId)) continue
                        for (const s of sibs) if (enabledSet.has(s)) { clash = true; break }
                        if (clash) break
                      }
                    }
                    const missing = g.mods.some(m => m.enabled && (missingDepsMap.get(m.id)?.length ?? 0) > 0)
                    const duplicate = g.mods.some(m => duplicateModIds.has(m.id))
                    return { clash, missing, duplicate, any: clash || missing || duplicate }
                  }
                  const attentionCount = groups.filter(g => groupAttention(g).any).length

                  let displayGroups = filterMultiId ? filteredGroups.filter(g => g.mods.length > 1) : filteredGroups
                  if (filterAttention) displayGroups = displayGroups.filter(g => groupAttention(g).any)
                  const totalModCount = groups.reduce((s, g) => s + g.mods.length, 0)
                  const q = deferredModManagerSearch.toLowerCase().trim()
                  const inspectedGroup = groups.find(g => g.wsId === selectedActiveWsId) || displayGroups[0] || null

                  const toggleMod = async (mod: ModEntry, wsId: string) => {
                    if (busyRef.current) return
                    const on = !mod.enabled
                    busyRef.current = true
                    try {
                      await modsApi.toggleModId(mod.id, on)
                      setIniConfig(prev => {
                        if (!prev) return prev
                        const newModIds = on ? [...prev.modIds, mod.id] : prev.modIds.filter(id => id !== mod.id)
                        const newMap = { ...prev.workshopModMap }
                        if (newMap[wsId]) {
                          newMap[wsId] = newMap[wsId].map(m => m.id === mod.id ? { ...m, enabled: on } : m)
                        }
                        return { ...prev, modIds: newModIds, totalMods: newModIds.length, workshopModMap: newMap }
                      })
                      setOrderedModIds(prev => on ? [...prev, mod.id] : prev.filter(id => id !== mod.id))
                      setLastSavedMod(mod.id)
                      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current)
                      savedTimeoutRef.current = setTimeout(() => setLastSavedMod(null), 2000)
                    } catch (e) { reportClientError('Failed to toggle mod', e); toast({ variant: 'destructive', title: 'Failed to toggle mod' }) } finally { busyRef.current = false }
                  }

                  // Mark a sibling-conflict pair as a false positive. Used when the
                  // variant detector mis-flags a shared library + dependant
                  // (e.g. DynamicTradingCommon vs DynamicTradingV2) as two
                  // variants of the same mod.
                  const dismissPair = async (a: string, b: string) => {
                    try {
                      await modsApi.addIgnoredModPair(a, b)
                      setIgnoredPairs(prev => {
                        const [x, y] = a < b ? [a, b] : [b, a]
                        if (prev.some(p => p.mod_a === x && p.mod_b === y)) return prev
                        return [...prev, { mod_a: x, mod_b: y, ignored_at: new Date().toISOString() } as any]
                      })
                      toast({ title: 'Conflict dismissed', description: `${a} ↔ ${b} marked as a false positive.` })
                    } catch (e) {
                      reportClientError('Failed to dismiss conflict', e)
                      toast({ variant: 'destructive', title: 'Failed to dismiss conflict' })
                    }
                  }
                  const restorePair = async (a: string, b: string) => {
                    try {
                      await modsApi.removeIgnoredModPair(a, b)
                      setIgnoredPairs(prev => prev.filter(p => {
                        const [x, y] = a < b ? [a, b] : [b, a]
                        return !(p.mod_a === x && p.mod_b === y)
                      }))
                    } catch (e) {
                      reportClientError('Failed to restore conflict', e)
                    }
                  }

                  const toggleAllInGroup = async (g: WsGroup) => {
                    if (busyRef.current) return
                    const on = !g.allEnabled
                    const modsToToggle = g.mods.filter(mod => mod.enabled !== on)
                    if (modsToToggle.length === 0) return
                    busyRef.current = true
                    try {
                      await modsApi.batchToggleModIds(modsToToggle.map(mod => ({ modId: mod.id, enabled: on })))
                      setIniConfig(prev => {
                        if (!prev) return prev
                        let newModIds = [...prev.modIds]
                        const newMap = { ...prev.workshopModMap }
                        for (const mod of modsToToggle) {
                          if (on) {
                            if (!newModIds.includes(mod.id)) newModIds.push(mod.id)
                          } else {
                            newModIds = newModIds.filter(id => id !== mod.id)
                          }
                        }
                        if (newMap[g.wsId]) {
                          newMap[g.wsId] = newMap[g.wsId].map(m => {
                            const toggled = modsToToggle.find(t => t.id === m.id)
                            return toggled ? { ...m, enabled: on } : m
                          })
                        }
                        return { ...prev, modIds: newModIds, totalMods: newModIds.length, workshopModMap: newMap }
                      })
                      setOrderedModIds(prev => {
                        let next = [...prev]
                        for (const mod of modsToToggle) {
                          if (on) { if (!next.includes(mod.id)) next.push(mod.id) }
                          else { next = next.filter(id => id !== mod.id) }
                        }
                        return next
                      })
                    } catch (e) { reportClientError('Failed to toggle group', e); toast({ variant: 'destructive', title: 'Failed to toggle group' }) } finally { busyRef.current = false }
                  }

                  const removeWorkshop = async (wsId: string, knownModIds?: string[]) => {
                    try {
                      await modsApi.removeFromIni(wsId, undefined, knownModIds)
                      const updated = await modsApi.getCurrentConfig()
                      setIniConfig(updated)
                      if (updated?.modIds) setOrderedModIds(updated.modIds)
                      setLastSavedMod(`removed-${wsId}`)
                      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current)
                      savedTimeoutRef.current = setTimeout(() => setLastSavedMod(null), 2000)
                    } catch (e) { reportClientError('Failed to remove workshop item', e); toast({ variant: 'destructive', title: 'Failed to remove workshop item' }) }
                  }

                  // Handle confirmed workshop removal from AlertDialog
                  const handleConfirmedRemoveWorkshop = async () => {
                    if (confirmRemoveWorkshop) {
                      await removeWorkshop(confirmRemoveWorkshop.wsId, confirmRemoveWorkshop.knownModIds)
                      setConfirmRemoveWorkshop(null)
                    }
                  }

                  const getGroupLabel = (g: WsGroup): string => {
                    const first = g.mods[0]
                    return first.name !== first.id ? first.name : first.id
                  }

                  const getGroupMissingDeps = (g: WsGroup) => Array.from(new Set(g.mods.flatMap(m => missingDepsMap.get(m.id) || [])))
                  const getGroupDuplicateIds = (g: WsGroup) => g.mods.filter(m => duplicateModIds.has(m.id)).map(m => m.id)

                  const getInspectorDepKey = (g: WsGroup, dep: string) => `active-${g.wsId}-${dep}`

                  const runInspectorDepSearch = async (g: WsGroup, dep: string, force = false) => {
                    const key = getInspectorDepKey(g, dep)
                    if (!force && depSearchData[key] && !depSearchData[key].error) return
                    setDepSearchData(prev => ({ ...prev, [key]: { loading: true, results: [], error: null, searchUrl: null } }))
                    try {
                      const res = await modsApi.searchWorkshopMods(dep, {
                        parentName: getGroupLabel(g),
                        parentWorkshopId: g.wsId,
                      })
                      setDepSearchData(prev => ({
                        ...prev,
                        [key]: {
                          loading: false,
                          results: res.results || [],
                          error: null,
                          searchUrl: res.searchUrl,
                          variantsTried: res.variantsTried,
                          steamSearchEnabled: res.steamSearchEnabled,
                        }
                      }))
                    } catch (err: any) {
                      setDepSearchData(prev => ({ ...prev, [key]: { loading: false, results: [], error: err?.message || 'Search failed', searchUrl: null } }))
                    }
                  }

                  const toggleInspectorDepSearch = (g: WsGroup, dep: string) => {
                    const key = getInspectorDepKey(g, dep)
                    setDepSearchOpen(prev => {
                      const next = new Set(prev)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })
                    if (!depSearchData[key]) runInspectorDepSearch(g, dep)
                  }

                  const handleInspectorAddDep = async (hit: DepSearchHit, dep: string, key: string) => {
                    if (busyRef.current) return
                    busyRef.current = true
                    setDepAdding(prev => [...prev, key])
                    try {
                      await modsApi.addMissingDep(hit.workshopId, hit.modId || dep)
                      setDepAddResults(prev => ({ ...prev, [key]: 'added' as const }))
                      const updated = await modsApi.getCurrentConfig()
                      setIniConfig(updated)
                      if (updated?.modIds) setOrderedModIds(updated.modIds)
                      toast({ title: 'Dependency added', description: `${hit.modName} added to the server config.` })
                    } catch (err) {
                      reportClientError('Failed to add dependency from inspector.', err)
                      setDepAddResults(prev => ({ ...prev, [key]: 'error' as const }))
                      toast({ title: 'Add failed', description: err instanceof Error ? err.message : 'Could not add dependency.', variant: 'destructive' })
                    } finally {
                      setDepAdding(prev => prev.filter(item => item !== key))
                      busyRef.current = false
                    }
                  }

                  return (
                    <div className="space-y-3 sub-tab-enter">
                      {detectedConflicts.length > 0 && (
                        <div className="space-y-1.5">
                          {detectedConflicts.map((conflict, idx) => (
                            <div
                              key={idx}
                              className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm ${
                                conflict.severity === 'warning' ? 'bg-warning/10 border-warning/40' : 'bg-primary/10 border-primary/30'
                              }`}
                            >
                              <AlertTriangle className={`w-3.5 h-3.5 shrink-0 ${conflict.severity === 'warning' ? 'text-warning' : 'text-primary'}`} />
                              <span className="flex-1 min-w-0 break-words">
                                <span className={`font-medium ${conflict.severity === 'warning' ? 'text-warning' : 'text-primary'}`}>
                                  {conflict.type === 'duplicate' && 'Duplicate Mods'}
                                  {conflict.type === 'missing_modid' && 'Missing Mod IDs'}
                                  {conflict.type === 'outdated_dependency' && 'Outdated Dependency'}
                                </span>
                                <span className="text-muted-foreground">: {conflict.message}</span>
                              </span>
                              {conflict.type === 'duplicate' && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="shrink-0 h-8 text-xs border-warning/40 text-warning hover:bg-warning/20"
                                  disabled={deduplicating}
                                  onClick={async () => {
                                    setDeduplicating(true)
                                    setDeduplicateResult(null)
                                    try {
                                      const result = await modsApi.deduplicateModIds()
                                      setDeduplicateResult(result.message)
                                      if (result.removed.length > 0) {
                                        const updated = await modsApi.getCurrentConfig()
                                        setIniConfig(updated)
                                        if (updated?.modIds) setOrderedModIds(updated.modIds)
                                      }
                                    } catch (err: unknown) {
                                      const errMsg = err instanceof Error ? err.message : 'Failed to deduplicate'
                                      const msg = errMsg.includes('<')
                                        ? 'Failed to deduplicate — server endpoint not available'
                                        : errMsg
                                      setDeduplicateResult(`Error: ${msg}`)
                                    } finally {
                                      setDeduplicating(false)
                                    }
                                  }}
                                >
                                  {deduplicating ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Wrench className="w-3 h-3 mr-1" />}
                                  Fix
                                </Button>
                              )}
                            </div>
                          ))}
                          {deduplicateResult && (
                            <p className={`text-xs px-3 ${deduplicateResult.startsWith('Removed') ? 'text-success' : 'text-muted-foreground'}`}>{deduplicateResult}</p>
                          )}
                        </div>
                      )}

                      <div className="rounded-lg border border-border/45 bg-card/35 px-3 py-2.5">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className="inline-flex items-center gap-1.5 rounded border border-primary/35 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary"
                                title={`${enabledCount} of ${totalModCount} mod IDs are currently enabled. "Mod IDs" are the internal names PZ loads — a single Workshop item can ship several IDs (variants, add-on packs, etc.).`}
                              >
                                <span className="font-mono tabular-nums text-foreground">{enabledCount}</span>
                                <span className="text-muted-foreground">of</span>
                                <span className="font-mono tabular-nums text-foreground">{totalModCount}</span>
                                <span>IDs enabled</span>
                              </span>
                              <span className="inline-flex items-center gap-1.5 rounded border border-border/45 bg-muted/25 px-2 py-1 text-[11px] text-muted-foreground">
                                <Package className="h-3 w-3" aria-hidden="true" />
                                <span className="font-mono tabular-nums text-foreground/85">{groups.length}</span>
                                Workshop item{groups.length !== 1 ? 's' : ''}
                              </span>
                              {/* One switch to jump straight to the items that are actually
                                  broken, instead of scrolling the whole list looking for red. */}
                              {attentionCount > 0 && (
                                <button
                                  type="button"
                                  onClick={() => setFilterAttention(!filterAttention)}
                                  aria-pressed={filterAttention}
                                  title="Show only workshop items with a confirmed variant clash, a missing required mod ID, or a duplicate internal ID."
                                  className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/50 ${filterAttention ? 'border-destructive/60 bg-destructive/20 text-destructive' : 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15'}`}
                                >
                                  <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                                  Needs attention ({attentionCount})
                                </button>
                              )}
                              {multiIdCount > 0 && (
                                <button
                                  type="button"
                                  onClick={() => setFilterMultiId(!filterMultiId)}
                                  aria-pressed={filterMultiId}
                                  title={filterMultiId
                                    ? 'Showing only workshop items with more than one mod ID. These are usually variants where only some should be enabled together.'
                                    : 'Show only workshop items with multiple mod IDs (usually variants — only enable the ones you want).'}
                                  className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${filterMultiId ? 'bg-primary/20 border-primary/50 text-primary' : 'border-border/40 text-muted-foreground hover:bg-muted/35 hover:text-foreground'}`}
                                >
                                  <Filter className="h-3 w-3" aria-hidden="true" />
                                  Multi-ID ({multiIdCount})
                                </button>
                              )}
                              {missingDepsMap.size > 0 && (
                                <span className="inline-flex items-center gap-1.5 rounded border border-destructive/45 bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive" title="At least one enabled mod requires another mod that isn't enabled. See the Conflicts tab → Missing Dependencies.">
                                  <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                                  {missingDepsMap.size} missing dep{missingDepsMap.size !== 1 ? 's' : ''}
                                </span>
                              )}
                              {duplicateModIds.size > 0 && (
                                <span className="inline-flex items-center gap-1.5 rounded border border-warning/45 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning" title="Multiple workshop items declare the same internal mod ID. Only one will load — review the Conflicts tab.">
                                  <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                                  {duplicateModIds.size} duplicate ID{duplicateModIds.size !== 1 ? 's' : ''}
                                </span>
                              )}
                              {lastSavedMod && (
                                <span className="text-[11px] text-success flex items-center gap-1 animate-in fade-in duration-300">
                                  <Check className="w-3 h-3" /> Saved to INI
                                </span>
                              )}
                            </div>
                            {/* Collapsed by default — it's onboarding copy, not a status line. */}
                            <details className="group/help">
                              <summary className="inline-flex cursor-pointer select-none list-none items-center gap-1 text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground">
                                <ChevronRight className="h-3 w-3 transition-transform group-open/help:rotate-90" aria-hidden="true" />
                                What am I looking at?
                              </summary>
                              <p className="mt-1.5 max-w-prose text-[11px] leading-4 text-muted-foreground/75">
                                This is what the server config actually loads. A Workshop item can ship several internal
                                mod IDs — add-ons, variants, and shared libraries. Enabled IDs are green; those are the
                                ones Project Zomboid loads. Select a row to toggle its IDs in the panel on the right.
                              </p>
                            </details>
                          </div>
                          <div className="flex w-full shrink-0 flex-col gap-2 lg:w-auto lg:items-end">
                            <div className="relative w-full lg:w-72">
                              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                              <Input value={modManagerSearch} onChange={e => handleModManagerSearchChange(e.target.value)} placeholder="Filter active mods..." aria-label="Filter active mods" className="h-9 text-xs pl-8 bg-background/60" />
                              {modManagerSearch && (
                                <button onClick={() => { handleModManagerSearchChange('') }} aria-label="Clear search" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 rounded">✕</button>
                              )}
                            </div>
                            <div className="inline-flex items-center gap-1 rounded-md border border-border/45 bg-muted/20 p-0.5" role="group" aria-label="List density">
                              {(['compact', 'detailed'] as const).map(d => (
                                <button
                                  key={d}
                                  type="button"
                                  onClick={() => setActiveDensity(d)}
                                  aria-pressed={activeDensity === d}
                                  title={d === 'compact'
                                    ? 'One line per Workshop item. Toggle individual mod IDs in the panel on the right.'
                                    : 'Show every mod ID as a clickable chip inside each row.'}
                                  className={`rounded px-2 py-1 text-[11px] font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${activeDensity === d ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                                >
                                  {d}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* (Dependency / duplicate badges are now inline above) */}

                      {/* Scrollable mod list */}
                      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_21rem]">
                      <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-muted/50 shadow-md">
                        {displayGroups.length > 0 ? (
                          <ScrollArea className="h-[calc(100vh-340px)] min-h-[300px]">
                            <div className="min-w-0 divide-y divide-border/60 [&>*:nth-child(even)]:bg-card/70">
                              {displayGroups.map(g => {
                                const isSingle = g.mods.length === 1
                                const mod0 = g.mods[0]
                                const isInspected = inspectedGroup?.wsId === g.wsId
                                const label = getGroupLabel(g)
                                const att = groupAttention(g)
                                const enabledN = g.mods.filter(m => m.enabled).length
                                const totalN = g.mods.length
                                // Chips are the dense part of the row. Compact keeps them in the
                                // inspector; the selected row always shows them so a click still
                                // reveals everything in place.
                                const showChips = !isSingle && (activeDensity === 'detailed' || isInspected)
                                const groupMissing = g.mods.flatMap(m => missingDepsMap.get(m.id) || [])
                                const groupRequires = g.mods.flatMap(m => m.require || []).filter((v, i, a) => a.indexOf(v) === i)
                                const missingRequired = groupRequires.filter(dep => groupMissing.includes(dep))

                                // Only colour the count when something is actually wrong. A partial
                                // "1 of 5" is the normal, correct state for most multi-ID items.
                                const countTone = att.any
                                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                                  : g.allEnabled
                                    ? 'border-success/30 bg-success/10 text-success'
                                    : g.someEnabled
                                      ? 'border-border/45 bg-muted/25 text-foreground/80'
                                      : 'border-border/45 bg-muted/25 text-muted-foreground'

                                const kebab = (
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button variant="ghost" size="iconDense" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground" aria-label={`More actions for ${label}`}>
                                        <MoreVertical className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem onClick={() => copyText(g.wsId).then(() => toast({ title: 'Copied', description: `Workshop ID ${g.wsId}` })).catch(() => {})}>
                                        <FileText className="mr-2 h-4 w-4" />
                                        Copy Workshop ID
                                      </DropdownMenuItem>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem className="text-destructive focus:text-destructive" title="Stops this mod loading by removing its workshop and mod IDs from the server INI. Keeps it in the panel's tracked list." onClick={() => setConfirmRemoveWorkshop({ wsId: g.wsId, knownModIds: g.mods.map(m => m.id) })}>
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        Remove from server INI
                                      </DropdownMenuItem>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem className="text-destructive focus:text-destructive" title="Stops this mod loading and removes it from the panel's tracked list. Workshop files remain on disk." onClick={() => setConfirmRemoveMod(g.wsId)}>
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        Remove from server
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                )

                                const missingRequiredBlock = missingRequired.length > 0 ? (
                                  <div className="flex flex-wrap items-center gap-1 rounded border border-destructive/35 bg-destructive/10 px-2 py-1">
                                    <AlertTriangle className="h-3 w-3 text-destructive" aria-hidden="true" />
                                    <span className="text-[10px] font-medium text-destructive/90">Missing required ID:</span>
                                    {missingRequired.map(dep => (
                                      <span key={dep} className="rounded border border-destructive/30 bg-destructive/15 px-1 font-mono text-[10px] text-destructive" title={`${dep} is not enabled — this mod may not work`}>
                                        {dep}
                                      </span>
                                    ))}
                                  </div>
                                ) : null

                                if (isSingle) {
                                  return (
                                    <ModRow
                                      key={g.wsId}
                                      selected={isInspected}
                                      dimmed={!mod0.enabled}
                                      onClick={() => setSelectedActiveWsId(g.wsId)}
                                      leading={
                                        <Checkbox
                                          checked={mod0.enabled}
                                          onCheckedChange={() => toggleMod(mod0, g.wsId)}
                                          aria-label={`${mod0.enabled ? 'Disable' : 'Enable'} ${mod0.name || mod0.id}`}
                                        />
                                      }
                                      title={<span className="truncate text-sm font-semibold leading-tight text-foreground">{mod0.name || mod0.id}</span>}
                                      titleBadges={
                                        <>
                                          {mod0.name !== mod0.id && (
                                            <span className="inline-flex items-center rounded border border-success/25 bg-success/10 px-1.5 py-0.5 font-mono text-[10px] leading-none text-success">
                                              {mod0.id}
                                            </span>
                                          )}
                                          {att.duplicate && (
                                            <span className="shrink-0 rounded border border-warning/30 bg-warning/15 px-1.5 text-[10px] text-warning" title={`Also provided by workshop item${(duplicateModIds.get(mod0.id) || []).length > 2 ? 's' : ''} ${(duplicateModIds.get(mod0.id) || []).filter(w => w !== g.wsId).join(', ')}`}>
                                              duplicate
                                            </span>
                                          )}
                                        </>
                                      }
                                      meta={
                                        <>
                                          <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium ${mod0.enabled ? 'border-success/30 bg-success/10 text-success' : 'border-border/45 bg-muted/25 text-muted-foreground'}`}>
                                            <span className={`h-1.5 w-1.5 rounded-full ${mod0.enabled ? 'bg-success' : 'bg-muted-foreground/50'}`} aria-hidden="true" />
                                            {mod0.enabled ? 'Enabled' : 'Disabled'}
                                          </span>
                                          <WorkshopIdChip wsId={g.wsId} onCopied={(id) => toast({ title: 'Copied', description: `Workshop ID ${id}` })} />
                                        </>
                                      }
                                      actions={
                                        <>
                                          <WorkshopLinkAction wsId={g.wsId} label={mod0.name || mod0.id} />
                                          {kebab}
                                        </>
                                      }
                                      footer={mod0.enabled ? missingRequiredBlock : null}
                                    />
                                  )
                                }

                                return (
                                  <ModRow
                                    key={g.wsId}
                                    selected={isInspected}
                                    dimmed={!g.someEnabled}
                                    onClick={() => setSelectedActiveWsId(g.wsId)}
                                    leading={
                                      <div className={`h-2 w-2 rounded-sm ${g.allEnabled ? 'bg-success' : g.someEnabled ? 'bg-success/40' : 'bg-muted-foreground/20'}`} aria-hidden="true" />
                                    }
                                    title={<span className="truncate text-sm font-semibold leading-tight text-foreground">{label}</span>}
                                    titleBadges={
                                      <span
                                        className={`inline-flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium tabular-nums ${countTone}`}
                                        title={`${enabledN} of ${totalN} mod IDs enabled. Some workshop items ship multiple compatible IDs (e.g. add-on packs); others ship alternatives (e.g. Lite vs Full). Check the workshop page if unsure.`}
                                      >
                                        <span>{enabledN}</span>
                                        <span className="opacity-60">of</span>
                                        <span>{totalN}</span>
                                        <span className="hidden opacity-75 sm:inline">enabled</span>
                                      </span>
                                    }
                                    meta={<WorkshopIdChip wsId={g.wsId} onCopied={(id) => toast({ title: 'Copied', description: `Workshop ID ${id}` })} />}
                                    actions={
                                      <>
                                        <WorkshopLinkAction
                                          wsId={g.wsId}
                                          label={label}
                                          hint="Open the workshop page to see which mod ID(s) you should enable"
                                        />
                                        {kebab}
                                      </>
                                    }
                                    footer={
                                      <>
                                        {showChips && (
                                          <div className="flex flex-wrap gap-1">
                                            {(() => {
                                              const groupSiblings = siblingConflictsMap.get(g.wsId)
                                              const enabledSet = new Set(g.mods.filter(m => m.enabled).map(m => m.id))
                                              const scanClashing = new Set<string>()
                                              if (groupSiblings) {
                                                for (const [modId, sibs] of groupSiblings) {
                                                  if (!enabledSet.has(modId)) continue
                                                  for (const s of sibs) {
                                                    if (enabledSet.has(s)) { scanClashing.add(modId); scanClashing.add(s) }
                                                  }
                                                }
                                              }
                                              return g.mods.map(mod => {
                                                const isDupe = duplicateModIds.has(mod.id)
                                                const sibConflicts = groupSiblings?.get(mod.id)
                                                const hasScanOverlap = !!sibConflicts && sibConflicts.size > 0
                                                const isScanClashing = scanClashing.has(mod.id)
                                                const sibList = sibConflicts ? Array.from(sibConflicts) : []
                                                const enabledSibs = sibList.filter(s => enabledSet.has(s))
                                                const fmtSibs = (arr: string[]) => arr.length <= 4 ? arr.join(', ') : `${arr.slice(0, 4).join(', ')} (+${arr.length - 4} more)`
                                                const tooltipBits = [
                                                  `${mod.id}${mod.name !== mod.id ? ` — ${mod.name}` : ''}`,
                                                  isDupe ? `⚠ Also in workshop ${(duplicateModIds.get(mod.id) || []).filter(w => w !== g.wsId).join(', ')}` : null,
                                                  isScanClashing
                                                    ? `⚠ Conflicts with ${fmtSibs(enabledSibs)} — both are enabled and share files. The one loaded last will overwrite the other.`
                                                    : hasScanOverlap
                                                      ? `Variant of ${fmtSibs(sibList)} — these share files, so only one should be enabled at a time. Currently safe.`
                                                      : null,
                                                  `Click to ${mod.enabled ? 'disable' : 'enable'}`,
                                                ].filter(Boolean).join('\n')
                                                // Colour priority: confirmed clash > known overlap > duplicate > normal.
                                                // Heuristics alone never earn red — many multi-ID mods are legit bundles.
                                                const styleClass = isScanClashing
                                                  ? (mod.enabled ? 'bg-destructive/20 text-destructive hover:bg-destructive/30 ring-1 ring-destructive/50' : 'bg-destructive/5 text-destructive/60 hover:bg-destructive/10 ring-1 ring-destructive/20')
                                                  : hasScanOverlap
                                                    ? (mod.enabled ? 'bg-success/15 text-success hover:bg-success/25 ring-1 ring-warning/30' : 'bg-muted/15 text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted/25 ring-1 ring-warning/20')
                                                    : isDupe
                                                      ? (mod.enabled ? 'bg-warning/15 text-warning hover:bg-warning/25 ring-1 ring-warning/30' : 'bg-warning/5 text-warning/50 hover:bg-warning/10 ring-1 ring-warning/20')
                                                      : (mod.enabled
                                                        ? 'bg-success/15 text-success hover:bg-success/25'
                                                        : 'bg-muted/15 text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted/25')
                                                return (
                                                  <button
                                                    key={mod.id}
                                                    onClick={(e) => { e.stopPropagation(); toggleMod(mod, g.wsId) }}
                                                    title={tooltipBits}
                                                    className={`mod-toggle-pill inline-flex max-w-[200px] cursor-pointer items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-background ${styleClass}`}
                                                  >
                                                    {isScanClashing && <AlertTriangle className="h-2.5 w-2.5 shrink-0 text-destructive" />}
                                                    {!isScanClashing && hasScanOverlap && <AlertTriangle className="h-2.5 w-2.5 shrink-0 text-warning/70" />}
                                                    <span className="truncate">{mod.id}</span>
                                                  </button>
                                                )
                                              })
                                            })()}
                                          </div>
                                        )}
                                        {(() => {
                                          const enabledMods = g.mods.filter(m => m.enabled)
                                          const enabledIds = enabledMods.map(m => m.id)
                                          const enabledSet = new Set(enabledIds)
                                          const hasMultipleEnabled = g.mods.length > 1 && enabledIds.length >= 2
                                          const groupSiblings = siblingConflictsMap.get(g.wsId)
                                          const scanClashingPairs: [string, string][] = []
                                          if (groupSiblings) {
                                            const seen = new Set<string>()
                                            for (const [modId, sibs] of groupSiblings) {
                                              if (!enabledSet.has(modId)) continue
                                              for (const s of sibs) {
                                                if (!enabledSet.has(s)) continue
                                                const key = [modId, s].sort().join('--')
                                                if (seen.has(key)) continue
                                                seen.add(key)
                                                scanClashingPairs.push([modId, s])
                                              }
                                            }
                                          }
                                          // Dismissed false positives, so a wrong "Not a conflict" can be undone.
                                          const groupModIds = new Set(g.mods.map(m => m.id))
                                          const dismissedHere = ignoredPairs.filter(p => groupModIds.has(p.mod_a) && groupModIds.has(p.mod_b))

                                          // A real clash always shows, at any density.
                                          if (scanClashingPairs.length > 0) {
                                            return (
                                              <div role="alert" className="flex flex-wrap items-start gap-1.5 text-[11px] sm:items-center">
                                                <AlertTriangle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0 text-destructive sm:mt-0" />
                                                <span className="min-w-0 break-words font-medium text-destructive/90">
                                                  Two variants of this mod are enabled and share files. One will overwrite the other — disable one.
                                                </span>
                                                <button
                                                  type="button"
                                                  onClick={(e) => {
                                                    e.stopPropagation()
                                                    for (const [a, b] of scanClashingPairs) dismissPair(a, b)
                                                  }}
                                                  title={scanClashingPairs.length === 1
                                                    ? `Mark "${scanClashingPairs[0][0]} ↔ ${scanClashingPairs[0][1]}" as a false positive — useful when one ID is a shared library required by the other (e.g. a Common dependency).`
                                                    : `Mark all ${scanClashingPairs.length} flagged pairs in this workshop item as false positives.`}
                                                  className="ml-auto inline-flex items-center gap-1 rounded border border-border/50 bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                                                >
                                                  Not a conflict
                                                </button>
                                              </div>
                                            )
                                          }

                                          // Everything below is reassurance or nuance, not a problem —
                                          // it only earns space in the detailed density.
                                          if (activeDensity !== 'detailed' && !isInspected) return null

                                          if (groupSiblings && groupSiblings.size > 0) {
                                            const overlapIds = new Set<string>()
                                            for (const [id, sibs] of groupSiblings) if (sibs.size > 0) overlapIds.add(id)
                                            return (
                                              <div
                                                className="flex flex-wrap items-start gap-1 text-[11px] text-muted-foreground/70 sm:items-center"
                                                title={`These variants share files: ${Array.from(overlapIds).join(', ')}. Enabling more than one would cause the last-loaded mod to overwrite the others. You currently have only one enabled — nothing to fix.`}
                                              >
                                                <Check aria-hidden="true" className="mt-px h-3 w-3 shrink-0 text-success/70 sm:mt-0" />
                                                <span className="min-w-0 break-words">Variants share files — only one is enabled, which is the right setup.</span>
                                              </div>
                                            )
                                          }
                                          if (hasMultipleEnabled) {
                                            return (
                                              <div className="flex flex-wrap items-start gap-1 text-[11px] text-muted-foreground/70 sm:items-center">
                                                <Info aria-hidden="true" className="mt-px h-3 w-3 shrink-0 sm:mt-0" />
                                                <span className="min-w-0 break-words">{enabledIds.length} mod IDs enabled. If unsure whether they coexist, check the workshop page.</span>
                                                {dismissedHere.length > 0 && (
                                                  <button
                                                    type="button"
                                                    onClick={(e) => { e.stopPropagation(); for (const p of dismissedHere) restorePair(p.mod_a, p.mod_b) }}
                                                    title={`Restore ${dismissedHere.length} dismissed conflict pair${dismissedHere.length !== 1 ? 's' : ''} for this workshop item`}
                                                    className="ml-auto text-[10px] text-muted-foreground/60 underline-offset-2 hover:text-foreground hover:underline"
                                                  >
                                                    Restore {dismissedHere.length} dismissed
                                                  </button>
                                                )}
                                              </div>
                                            )
                                          }
                                          if (dismissedHere.length > 0) {
                                            return (
                                              <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground/50">
                                                <span className="min-w-0">{dismissedHere.length} dismissed conflict{dismissedHere.length !== 1 ? 's' : ''}</span>
                                                <button
                                                  type="button"
                                                  onClick={(e) => { e.stopPropagation(); for (const p of dismissedHere) restorePair(p.mod_a, p.mod_b) }}
                                                  className="underline-offset-2 hover:text-foreground hover:underline"
                                                >
                                                  restore
                                                </button>
                                              </div>
                                            )
                                          }
                                          return null
                                        })()}
                                        {g.someEnabled ? missingRequiredBlock : null}
                                      </>
                                    }
                                  />
                                )
                              })}
                              {/* Orphaned mods */}
                              {!filterMultiId && orphaned.filter(id => !q || id.toLowerCase().includes(q)).map(id => (
                                <div key={`orphan-${id}`} className="group flex items-center gap-3 px-3 py-1.5 opacity-60">
                                  <AlertTriangle className="w-3 h-3 text-warning/60 shrink-0" />
                                  <span className="text-xs font-mono truncate flex-1">{id}</span>
                                  <span className="text-[11px] text-warning/50">not on disk</span>
                                  <button
                                    onClick={async () => {
                                      if (busyRef.current) return
                                      busyRef.current = true
                                      try {
                                        await modsApi.toggleModId(id, false)
                                        const updated = await modsApi.getCurrentConfig()
                                        setIniConfig(updated)
                                        if (updated?.modIds) setOrderedModIds(updated.modIds)
                                      } catch (e) { reportClientError('Failed to remove orphaned mod', e); toast({ variant: 'destructive', title: 'Failed to remove orphaned mod' }) } finally { busyRef.current = false }
                                    }}
                                    className="text-destructive/80 hover:text-destructive hover:bg-destructive/15 rounded p-1.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/50"
                                    title={`Remove orphaned mod ID ${id}`}
                                    aria-label={`Remove ${id}`}
                                  >
                                    <X className="w-4 h-4" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                        ) : (
                          <div className="space-y-2 px-3 py-8 text-center text-xs text-muted-foreground">
                            {filterAttention && attentionCount === 0 ? (
                              <>
                                <p className="text-success">Nothing needs attention — no clashes, missing IDs, or duplicates.</p>
                                <button type="button" onClick={() => setFilterAttention(false)} className="underline underline-offset-2 hover:text-foreground">
                                  Show all workshop items
                                </button>
                              </>
                            ) : q ? (
                              <p>No mods matching "{modManagerSearch}"</p>
                            ) : (
                              <p>No mod IDs found</p>
                            )}
                          </div>
                        )}
                      </div>

                      {inspectedGroup && (
                        <aside className="rounded-lg border border-border/55 bg-card/55 shadow-md xl:sticky xl:top-3 xl:self-start" aria-label="Selected workshop item details">
                          <div className="border-b border-border/45 px-3 py-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">Selected item</p>
                                <h3 className="mt-1 truncate text-sm font-semibold text-foreground" title={getGroupLabel(inspectedGroup)}>{getGroupLabel(inspectedGroup)}</h3>
                              </div>
                              <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium tabular-nums ${inspectedGroup.allEnabled ? 'border-success/30 bg-success/10 text-success' : inspectedGroup.someEnabled ? 'border-warning/35 bg-warning/10 text-warning' : 'border-border/45 bg-muted/25 text-muted-foreground'}`}>
                                {inspectedGroup.mods.filter(m => m.enabled).length} of {inspectedGroup.mods.length}
                              </span>
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                              <span className="inline-flex items-center rounded border border-border/35 bg-muted/20 px-1.5 py-0.5 font-mono tabular-nums">WS {inspectedGroup.wsId}</span>
                              {inspectedGroup.mods.length > 1 && <span className="inline-flex items-center rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-primary">Multi-ID</span>}
                            </div>
                          </div>

                          <div className="space-y-3 px-3 py-3">
                            <div className="grid grid-cols-2 gap-2">
                              <a
                                href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${inspectedGroup.wsId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border/55 bg-background/55 px-2 text-xs font-medium text-foreground hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                                Workshop
                              </a>
                              <button
                                type="button"
                                onClick={() => copyText(inspectedGroup.wsId).then(() => toast({ title: 'Copied', description: `Workshop ID ${inspectedGroup.wsId}` })).catch(() => {})}
                                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border/55 bg-background/55 px-2 text-xs font-medium text-foreground hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                              >
                                <FileText className="h-3.5 w-3.5" />
                                Copy WS
                              </button>
                            </div>

                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/75">Loaded IDs</p>
                                <button
                                  type="button"
                                  onClick={() => toggleAllInGroup(inspectedGroup)}
                                  className="rounded border border-border/45 bg-muted/25 px-2 py-1 text-[10px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                                >
                                  {inspectedGroup.allEnabled ? 'Disable all' : 'Enable all'}
                                </button>
                              </div>
                              <div className="space-y-1.5">
                                {inspectedGroup.mods.map(mod => {
                                  const missing = missingDepsMap.get(mod.id) || []
                                  const isDupe = duplicateModIds.has(mod.id)
                                  return (
                                    <button
                                      key={mod.id}
                                      type="button"
                                      onClick={() => toggleMod(mod, inspectedGroup.wsId)}
                                      className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 ${mod.enabled ? 'border-success/25 bg-success/10 text-success' : 'border-border/45 bg-muted/20 text-muted-foreground hover:text-foreground'}`}
                                      title={`Click to ${mod.enabled ? 'disable' : 'enable'} ${mod.id}`}
                                    >
                                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${mod.enabled ? 'bg-success' : 'bg-muted-foreground/45'}`} aria-hidden="true" />
                                      <span className="min-w-0 flex-1 truncate font-mono">{mod.id}</span>
                                      {missing.length > 0 && <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" aria-label="Missing dependency" />}
                                      {isDupe && <span className="shrink-0 rounded border border-warning/35 bg-warning/10 px-1 py-0 text-[9px] uppercase tracking-wide text-warning">dup</span>}
                                    </button>
                                  )
                                })}
                              </div>
                            </div>

                            {getGroupMissingDeps(inspectedGroup).length > 0 && (
                              <div className="rounded border border-destructive/35 bg-destructive/10 px-2 py-2">
                                <div className="flex items-center gap-1.5 text-[11px] font-medium text-destructive">
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                  Missing required IDs
                                </div>
                                <div className="mt-1.5 space-y-2">
                                  {getGroupMissingDeps(inspectedGroup).map(dep => {
                                    const key = getInspectorDepKey(inspectedGroup, dep)
                                    const searchOpen = depSearchOpen.has(key)
                                    const searchState = depSearchData[key]
                                    const adding = depAdding.includes(key)
                                    const added = depAddResults[key] === 'added'
                                    const errored = depAddResults[key] === 'error'

                                    return (
                                      <div key={dep} className="rounded border border-destructive/25 bg-background/25 p-1.5">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                          <button
                                            type="button"
                                            onClick={() => toggleInspectorDepSearch(inspectedGroup, dep)}
                                            className="inline-flex items-center gap-1 rounded border border-destructive/30 bg-destructive/15 px-1.5 py-0.5 font-mono text-[10px] text-destructive transition-colors hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/60"
                                            aria-expanded={searchOpen}
                                            aria-controls={`active-dep-search-${key}`}
                                            title={`Search Steam Workshop for ${dep}`}
                                          >
                                            <Search className="h-3 w-3" aria-hidden="true" />
                                            {dep}
                                          </button>
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            className="h-6 px-2 text-[10px]"
                                            onClick={() => {
                                              if (!searchOpen) toggleInspectorDepSearch(inspectedGroup, dep)
                                              else runInspectorDepSearch(inspectedGroup, dep, true)
                                            }}
                                            disabled={searchState?.loading}
                                          >
                                            {searchState?.loading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Search className="mr-1 h-3 w-3" />}
                                            Find in Workshop
                                          </Button>
                                          {added && <span className="inline-flex items-center gap-1 text-[10px] font-medium text-success"><Check className="h-3 w-3" /> Added</span>}
                                          {errored && <span className="text-[10px] font-medium text-destructive">Add failed</span>}
                                        </div>

                                        {searchOpen && (
                                          <div id={`active-dep-search-${key}`} className="mt-2 space-y-2">
                                            {searchState?.loading ? (
                                              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching Workshop for {dep}...
                                              </div>
                                            ) : searchState?.error ? (
                                              <div className="flex items-center justify-between gap-2 text-[11px]">
                                                <span className="break-words text-destructive">Search failed: {searchState.error}</span>
                                                <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => runInspectorDepSearch(inspectedGroup, dep, true)}>Retry</Button>
                                              </div>
                                            ) : searchState && searchState.results.length === 0 ? (
                                              <div className="space-y-1 text-[11px] text-muted-foreground">
                                                <p>No matches found. Try the Steam search page if the dependency has a different Workshop title.</p>
                                                {searchState.searchUrl && (
                                                  <a href={searchState.searchUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:text-primary/80">
                                                    <ExternalLink className="h-3 w-3" /> Open Workshop search
                                                  </a>
                                                )}
                                              </div>
                                            ) : searchState && searchState.results.length > 0 ? (
                                              <div className="space-y-1.5">
                                                <p className="text-[10px] text-muted-foreground">Pick the matching Workshop item, then add it to the server config.</p>
                                                {searchState.results.slice(0, 4).map((hit, hitIndex) => {
                                                  const isBest = hit.matchType === 'exact-id' || hitIndex === 0
                                                  return (
                                                  <div key={`${dep}-${hit.workshopId}-${hit.modId || ''}`} className={`rounded border px-2 py-1.5 ${isBest ? 'border-success/35 bg-success/[0.055]' : 'border-border/40 bg-card/45'}`}>
                                                    <div className="flex items-start justify-between gap-2">
                                                      <div className="min-w-0">
                                                        <div className="flex min-w-0 items-center gap-1.5">
                                                          <p className="truncate text-[11px] font-medium text-foreground" title={hit.modName}>{hit.modName}</p>
                                                          {isBest && (
                                                            <span className="shrink-0 rounded border border-success/35 bg-success/10 px-1 py-0 text-[9px] font-semibold uppercase tracking-wide text-success">
                                                              Best
                                                            </span>
                                                          )}
                                                        </div>
                                                        <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                                                          <span className="font-mono">WS {hit.workshopId}</span>
                                                          {hit.modId && <span className="font-mono">ID {hit.modId}</span>}
                                                          <span>{hit.source === 'local' ? 'local' : 'Steam'}</span>
                                                          {hit.matchType === 'exact-id' && <span className="text-success">exact ID</span>}
                                                        </p>
                                                      </div>
                                                      <div className="flex shrink-0 items-center gap-1">
                                                        <a
                                                          href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${hit.workshopId}`}
                                                          target="_blank"
                                                          rel="noopener noreferrer"
                                                          className="rounded p-1 text-muted-foreground hover:bg-muted/45 hover:text-foreground"
                                                          aria-label={`Open ${hit.modName} on Steam Workshop`}
                                                        >
                                                          <ExternalLink className="h-3.5 w-3.5" />
                                                        </a>
                                                        <Button
                                                          type="button"
                                                          variant="outline"
                                                          size="sm"
                                                          className="h-6 px-2 text-[10px]"
                                                          onClick={() => handleInspectorAddDep(hit, dep, key)}
                                                          disabled={adding || added}
                                                        >
                                                          {adding ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : added ? <Check className="mr-1 h-3 w-3" /> : <Plus className="mr-1 h-3 w-3" />}
                                                          {added ? 'Added' : 'Add'}
                                                        </Button>
                                                      </div>
                                                    </div>
                                                  </div>
                                                )})}
                                                {searchState.searchUrl && (
                                                  <a href={searchState.searchUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[10px] text-primary hover:text-primary/80">
                                                    <ExternalLink className="h-3 w-3" /> Open full Workshop search
                                                  </a>
                                                )}
                                              </div>
                                            ) : null}
                                          </div>
                                        )}
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            )}

                            {getGroupDuplicateIds(inspectedGroup).length > 0 && (
                              <div className="rounded border border-warning/35 bg-warning/10 px-2 py-2">
                                <div className="flex items-center gap-1.5 text-[11px] font-medium text-warning">
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                  Duplicate internal IDs
                                </div>
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                  {getGroupDuplicateIds(inspectedGroup).map(id => (
                                    <span key={id} className="rounded border border-warning/30 bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] text-warning">{id}</span>
                                  ))}
                                </div>
                              </div>
                            )}

                            <div className="border-t border-border/35 pt-3">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => setConfirmRemoveWorkshop({ wsId: inspectedGroup.wsId, knownModIds: inspectedGroup.mods.map(m => m.id) })}
                              >
                                <Trash2 className="mr-2 h-3.5 w-3.5" />
                                Remove from server INI
                              </Button>
                            </div>
                          </div>
                        </aside>
                      )}
                      </div>

                      {/* Mods= raw line — collapsed by default */}
                      <details className="pt-2 border-t border-border/20 group/raw">
                        <summary className="text-[11px] text-muted-foreground/60 hover:text-foreground cursor-pointer select-none list-none flex items-center gap-1 transition-colors">
                          <ChevronRight className="w-3 h-3 transition-transform group-open/raw:rotate-90" aria-hidden="true" />
                          Show raw <span className="font-mono">Mods=</span> line
                        </summary>
                        <div className="text-[11px] text-muted-foreground font-mono break-all leading-tight mt-1.5" title={`Mods=${iniConfig.modIds?.join(';') || ''}`}>
                          Mods={iniConfig.modIds?.join(';') || ''}
                        </div>
                      </details>

                      {/* Workshop item remove confirmation */}
                      <AlertDialog open={!!confirmRemoveWorkshop} onOpenChange={(open) => { if (!open) setConfirmRemoveWorkshop(null) }}>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove workshop item?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will remove the workshop item and its mod IDs from the server INI. Workshop files on disk won't be deleted.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={handleConfirmedRemoveWorkshop}
                            >
                              Remove
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )
                })()}

                {/* ═══ LOAD ORDER SUB-TAB ═══ */}
                {configSubTab === 'order' && (() => {
                  // Build modId → display name lookup from workshopModMap + tracked mods
                  const modIdNameMap = new Map<string, string>()
                  const modIdWsMap = new Map<string, string>()
                  const wsMap = iniConfig?.workshopModMap || {}
                  for (const [wsId, details] of Object.entries(wsMap)) {
                    for (const m of details) {
                      if (m.name && m.name !== m.id) modIdNameMap.set(m.id, m.name)
                      modIdWsMap.set(m.id, wsId)
                    }
                  }
                  // Fallback: use tracked mod names matched via workshop ID
                  for (const mod of mods) {
                    const details = wsMap[mod.workshop_id]
                    if (details) {
                      for (const m of details) {
                        if (!modIdNameMap.has(m.id) && mod.name) modIdNameMap.set(m.id, mod.name)
                      }
                    }
                  }

                  return (
                  <div className="space-y-3 sub-tab-enter">
                    {orderedModIds.length === 0 ? (
                      <div className="flex items-center justify-center py-10 text-muted-foreground">
                        <div className="text-center space-y-2">
                          <Layers className="w-8 h-8 mx-auto opacity-30" />
                          <p className="text-sm font-medium text-foreground/70">No mods in load order</p>
                          <p className="text-xs">Enable mods in the Active Mods tab first.</p>
                        </div>
                      </div>
                    ) : (
                    <>
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <p className="text-xs text-muted-foreground">Drag to reorder. Changes are not saved until you click Save.</p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        onClick={handleAutoSort}
                        disabled={savingModOrder || !!autoSortPreview}
                      >
                        <Wand2 className="w-3 h-3 mr-1" />
                        Auto-sort by dependencies
                      </Button>
                    </div>

                    {autoSortPreview && (
                      <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div className="space-y-0.5">
                            <p className="text-xs font-medium text-foreground">
                              Proposed order: {autoSortPreview.moved.length} mod{autoSortPreview.moved.length === 1 ? '' : 's'} would move
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              Based on {autoSortPreview.appliedEdges} dependenc{autoSortPreview.appliedEdges === 1 ? 'y' : 'ies'} declared in mod.info. Mods with no dependency keep your order.
                            </p>
                          </div>
                          <div className="flex gap-2">
                            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setAutoSortPreview(null)}>Cancel</Button>
                            <Button size="sm" className="h-8 text-xs" onClick={applyAutoSort}>Apply</Button>
                          </div>
                        </div>

                        <ScrollArea className="max-h-40">
                          <div className="space-y-0.5 pr-2">
                            {autoSortPreview.moved.map((move) => (
                              <div key={move.modId} className="flex items-center gap-2 text-[11px]">
                                <span className="tabular-nums text-muted-foreground w-8 text-right shrink-0">#{move.from}</span>
                                <ArrowRight className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                                <span className="tabular-nums text-primary w-8 text-right shrink-0">#{move.to}</span>
                                <span className="font-mono truncate shrink-0">{move.modId}</span>
                                {modIdNameMap.get(move.modId) && (
                                  <span className="text-muted-foreground/60 truncate">{modIdNameMap.get(move.modId)}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </ScrollArea>

                        {autoSortPreview.cycles.length > 0 && (
                          <div className="space-y-0.5">
                            {autoSortPreview.cycles.map((group) => (
                              <p key={group.join('|')} className="text-[11px] text-warning">
                                Circular dependency between {group.join(', ')}. No order can satisfy it, so these keep their current order relative to each other.
                              </p>
                            ))}
                          </div>
                        )}
                        {autoSortPreview.missing.length > 0 && (
                          <p className="text-[11px] text-muted-foreground">
                            {autoSortPreview.missing.length} required mod{autoSortPreview.missing.length === 1 ? ' is' : 's are'} not enabled and could not be ordered (see the Conflicts tab).
                          </p>
                        )}
                      </div>
                    )}
                    <div className="rounded-lg border border-border bg-muted/50 shadow-md overflow-hidden">
                      <ScrollArea className="h-[calc(100vh-320px)] min-h-[200px]">
                        <div className="divide-y divide-border/60 [&>*:nth-child(even)]:bg-card/70">
                          {orderedModIds
                            .map((modId, idx) => ({ modId, idx }))
                            .filter(({ modId }) => {
                              const q = deferredModManagerSearch.toLowerCase().trim()
                              if (!q) return true
                              if (modId.toLowerCase().includes(q)) return true
                              const name = modIdNameMap.get(modId)
                              return name ? name.toLowerCase().includes(q) : false
                            })
                            .map(({ modId, idx }) => {
                                const displayName = modIdNameMap.get(modId)
                                return (
                                <div
                                  key={`${modId}-${idx}`}
                                  draggable={!modManagerSearch.trim()}
                                  onDragStart={() => handleDragStart(idx)}
                                  onDragOver={(e) => handleDragOver(e, idx)}
                                  onDragEnd={handleDragEnd}
                                  className={`flex items-center gap-2 px-2.5 py-1 cursor-move transition-colors duration-150 hover:bg-muted/15 ${
                                    draggedModIndex === idx ? 'opacity-30 bg-primary/5' : ''
                                  }`}
                                >
                                  <GripVertical className="w-3 h-3 text-muted-foreground/30 shrink-0" />
                                  <span className="text-[11px] tabular-nums text-muted-foreground w-5 text-right shrink-0">{idx + 1}</span>
                                  <span className="text-[11px] font-mono truncate shrink-0">{modId}</span>
                                  {displayName && <span className="text-[11px] text-muted-foreground/60 truncate flex-1">{displayName}</span>}
                                  {!displayName && <span className="flex-1" />}
                                  <div className="flex shrink-0">
                                    <button onClick={() => moveModUp(idx)} disabled={idx === 0} className="p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-muted/30 disabled:opacity-30 rounded transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50" aria-label="Move up">
                                      <ChevronRight className="w-3.5 h-3.5 -rotate-90" />
                                    </button>
                                    <button onClick={() => moveModDown(idx)} disabled={idx === orderedModIds.length - 1} className="p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-muted/30 disabled:opacity-30 rounded transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50" aria-label="Move down">
                                      <ChevronRight className="w-3.5 h-3.5 rotate-90" />
                                    </button>
                                  </div>
                                </div>
                              )})
                            }
                        </div>
                      </ScrollArea>
                      {hasModOrderChanged && (
                        <div className="px-3 py-2 border-t border-border/40 bg-muted/20 flex items-center justify-between">
                          <span className="text-[11px] text-warning">Unsaved order changes</span>
                          <div className="flex gap-2">
                            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => { setAutoSortPreview(null); setOrderedModIds(iniConfig.modIds) }}>Reset</Button>
                            <Button size="sm" className="h-8 text-xs" onClick={handleSaveModOrder} disabled={savingModOrder}>
                              {savingModOrder ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Save className="w-3 h-3 mr-1" />}
                              Save Order
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                    </>
                    )}
                  </div>
                  )
                })()}

                {/* ═══ ADD MODS SUB-TAB ═══ */}
                {configSubTab === 'add' && (
                  <div className="space-y-4 sub-tab-enter">
                    {/* Sync Mod IDs */}
                    <div className="flex flex-col gap-3 rounded-lg border border-border/70 bg-secondary p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Sync Mod IDs from Downloads</p>
                        <p className="text-xs text-muted-foreground">
                          Reads mod.info from downloaded mods and adds their IDs to Mods= in the INI
                        </p>
                      </div>
                      <Button
                        onClick={handleSyncModIds}
                        disabled={syncing}
                        size="sm"
                        variant="outline"
                      >
                        {syncing ? (
                          <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <RefreshCw className="w-4 h-4 mr-2" />
                        )}
                        Sync Mod IDs
                      </Button>
                    </div>

                    {/* Pending Mods to Install */}
                    {modsToInstall.length > 0 && (
                      <div className="space-y-3 rounded-lg border border-border/70 bg-secondary p-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <Label className="flex items-center gap-2">
                            <Plus className="w-4 h-4" />
                            {modsToInstall.length} mods queued for INI
                          </Label>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setModsToInstall([])}
                          >
                            Clear All
                          </Button>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {modsToInstall.map(mod => (
                            <Badge key={mod.workshopId} variant="outline" className="max-w-full text-xs sm:max-w-[200px]">
                              <span className="truncate">{mod.name}</span>
                              {mod.isMap && <MapIcon className="w-3 h-3 ml-1" />}
                              <button
                                type="button"
                                aria-label={`Remove ${mod.name} from queue`}
                                onClick={() => removeFromInstallList(mod.workshopId)}
                                className="ml-1 hover:text-destructive"
                              >
                                ×
                              </button>
                            </Badge>
                          ))}
                        </div>
                        <Button onClick={handleWriteToIni} disabled={loading} size="sm">
                          <FileText className="w-4 h-4 mr-2" />
                          Write to Server INI
                        </Button>
                      </div>
                    )}

                    {modsToInstall.length === 0 && (
                      <div className="text-center py-8 text-muted-foreground">
                        <Plus className="w-10 h-10 mx-auto mb-3 opacity-30" />
                        <p className="text-sm">No mods pending</p>
                        <p className="text-xs">Use the Server Mods tab to find and add new workshop items, or click Sync to detect new downloads.</p>
                      </div>
                    )}
                  </div>
                )}

                {/* ═══ PRESETS SUB-TAB ═══ */}
                {configSubTab === 'presets' && (
                  <div className="space-y-4 sub-tab-enter">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">Save and restore mod configurations.</p>
                      <Dialog open={savePresetOpen} onOpenChange={setSavePresetOpen}>
                        <DialogTrigger asChild>
                          <Button size="sm" disabled={!iniConfig?.configured}>
                            <Save className="w-4 h-4 mr-2" />
                            Save Current
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Save Mod Preset</DialogTitle>
                            <DialogDescription>
                              Save the current mod configuration as a preset for easy switching later.
                            </DialogDescription>
                          </DialogHeader>
                          <div className="space-y-4">
                            <div className="space-y-2">
                              <Label htmlFor="presetName">Preset Name</Label>
                              <Input
                                id="presetName"
                                value={presetName}
                                onChange={(e) => setPresetName(e.target.value)}
                                placeholder="e.g., Vanilla+ Light, Hardcore, RP Server"
                                maxLength={100}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="presetDesc">Description (optional)</Label>
                              <Input
                                id="presetDesc"
                                value={presetDescription}
                                onChange={(e) => setPresetDescription(e.target.value)}
                                placeholder="Brief description of this preset..."
                                maxLength={500}
                              />
                            </div>
                            {iniConfig?.configured && (
                              <div className="rounded-lg border border-border/70 bg-secondary p-3 text-sm text-muted-foreground">
                                This will save {iniConfig.workshopIds?.length || 0} workshop items and {iniConfig.modIds?.length || 0} mod IDs.
                              </div>
                            )}
                          </div>
                          <DialogFooter className="flex-col sm:flex-row gap-2">
                            <Button variant="outline" onClick={() => setSavePresetOpen(false)} className="w-full sm:w-auto">
                              Cancel
                            </Button>
                            <Button onClick={handleSavePreset} disabled={savingPreset || !presetName.trim()} className="w-full sm:w-auto">
                              {savingPreset && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                              Save Preset
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </div>

                    {presetsLoading ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : presets.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        <FolderOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
                        <p className="text-sm">No presets saved yet</p>
                        <p className="text-xs">Save your current mod configuration to create a preset</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {presets.map((preset) => (
                          <div
                            key={preset.id}
                            className="flex flex-col gap-3 rounded-lg border border-border/70 bg-muted/50 p-3 transition-colors hover:bg-accent/20 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="font-medium truncate">{preset.name}</div>
                              <div className="text-xs text-muted-foreground truncate">
                                {preset.workshop_ids?.length || 0} mods &bull; {preset.description || 'No description'}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                Saved {new Date(preset.created_at).toLocaleDateString()}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 self-start sm:self-auto">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setConfirmApplyPreset({ id: preset.id, name: preset.name, modCount: preset.workshop_ids?.length || 0 })}
                                disabled={applyingPreset === preset.id}
                              >
                                {applyingPreset === preset.id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Download className="w-4 h-4" />
                                )}
                                <span className="ml-1.5">Load</span>
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setConfirmDeletePreset({ id: preset.id, name: preset.name })}
                                className="text-destructive hover:text-destructive"
                                aria-label={`Delete preset "${preset.name}"`}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Preset apply confirmation */}
                    <AlertDialog open={!!confirmApplyPreset} onOpenChange={(open) => { if (!open) setConfirmApplyPreset(null) }}>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Apply preset "{confirmApplyPreset?.name}"?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will replace your current mod configuration with {confirmApplyPreset?.modCount || 0} mods from this preset. Your existing Mods= and WorkshopItems= lines will be overwritten.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => {
                              if (confirmApplyPreset) {
                                handleApplyPreset(confirmApplyPreset.id, confirmApplyPreset.name)
                                setConfirmApplyPreset(null)
                              }
                            }}
                          >
                            Apply Preset
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>

                    {/* Preset delete confirmation */}
                    <AlertDialog open={!!confirmDeletePreset} onOpenChange={(open) => { if (!open) setConfirmDeletePreset(null) }}>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete preset "{confirmDeletePreset?.name}"?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This preset will be permanently deleted. This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => {
                              if (confirmDeletePreset) {
                                handleDeletePreset(confirmDeletePreset.id, confirmDeletePreset.name)
                                setConfirmDeletePreset(null)
                              }
                            }}
                          >
                            Delete Preset
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}

                {/*  TOOLS SUB-TAB  */}
                {configSubTab === 'tools' && (
                  <div className="space-y-4 sub-tab-enter">
                    <div className="rounded-lg border border-border/40 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <MapIcon className="w-4 h-4" />
                          Maps= ({iniConfig?.maps?.length || 0})
                        </div>
                        <button
                          onClick={async () => {
                            try {
                              setRepairingMaps(true)
                              const result = await modsApi.repairMapEntries()
                              setMapRepairResult(result)
                            } catch (err) {
                              reportClientError('Map repair failed.', err)
                              setMapRepairResult({ removed: [], remaining: iniConfig?.maps || [], message: 'Map repair failed — check server connection' })
                            } finally {
                              setRepairingMaps(false)
                            }
                          }}
                          disabled={repairingMaps}
                          className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-muted hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors disabled:opacity-50"
                          title="Validate and remove invalid map entries"
                        >
                          {repairingMaps ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wrench className="w-3 h-3" />}
                          Repair
                        </button>
                      </div>
                      {mapRepairResult && (
                        <div className={`p-2 rounded text-xs ${(mapRepairResult.removed.length > 0 || (mapRepairResult.added?.length ?? 0) > 0) ? 'bg-warning/10 text-warning border border-warning/20' : 'bg-success/10 text-success border border-success/20'}`}>
                          {mapRepairResult.message}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1">
                        {iniConfig.maps.map((map, i) => (
                          <Badge key={i} variant="secondary" className="text-xs max-w-[250px] truncate">
                            {map}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    {/* Workshop IDs Review */}
                    <div className="rounded-lg border border-border/40 p-3 space-y-2">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Package className="w-4 h-4" />
                        WorkshopItems= ({iniConfig.workshopIds?.length || 0})
                      </div>
                      <div className="flex flex-wrap gap-1 max-h-[200px] overflow-y-auto">
                        {iniConfig.workshopIds?.map((id, i) => (
                          <Badge key={i} variant="outline" className="text-xs font-mono max-w-[140px] truncate">
                            {id}
                          </Badge>
                        ))}
                      </div>
                      <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded font-mono break-all max-h-[80px] overflow-y-auto">
                        WorkshopItems={iniConfig.workshopIds?.join(';') || ''}
                      </div>
                    </div>

                    {/* Operator Notes */}
                    <div className="rounded-lg border border-border/40 p-3 space-y-3 text-sm text-muted-foreground">
                      <div className="text-xs font-semibold text-foreground flex items-center gap-2">
                        <Info className="w-3.5 h-3.5" />
                        Operator Notes
                      </div>
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-warning shrink-0" />
                        <div>
                          <p className="font-medium text-foreground text-xs">Load Order Matters</p>
                          <p className="text-xs">Frameworks and dependencies must load before content mods. Wrong order can cause silent failures.</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <MapIcon className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                        <div>
                          <p className="font-medium text-foreground text-xs">Map Mods Need Extra Care</p>
                          <p className="text-xs">After importing map mods, verify map folder names so spawns and cells load correctly.</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <RefreshCw className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                        <div>
                          <p className="font-medium text-foreground text-xs">Sync After Downloading New Mods</p>
                          <p className="text-xs">Workshop items without matching mod IDs usually means Steam hasn't finished downloading.</p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center py-8">
                <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">{iniConfig?.error || 'Server config file not found'}</p>
                <p className="text-sm text-muted-foreground">Start the server once — it will create the INI file automatically.</p>
              </div>
            )}
          </div>
          )}

          {/* ─── Conflicts Tab ─── */}
          {activeTab === 'conflicts' && (
            <ConflictsPanel
              conflicts={conflicts}
              focusDependencies={reviewUnresolved}
              conflictsLoading={conflictsLoading}
              conflictsError={conflictsError}
              conflictsStale={conflictsStale}
              lastScanTime={lastScanTime}
              scanConflicts={scanConflicts}
              scanProgress={scanProgress}
              scanCurrentMod={scanCurrentMod}
              scanModsScanned={scanModsScanned}
              scanTotalMods={scanTotalMods}
              streamConflicts={streamConflicts}
              fetchData={fetchData}
              busyRef={busyRef}
              savingModOrder={savingModOrder}
              promoteModOverOpponent={promoteModOverOpponent}
              toast={toast}
              depSearchOpen={depSearchOpen}
              setDepSearchOpen={setDepSearchOpen}
              depSearchData={depSearchData}
              setDepSearchData={setDepSearchData}
              depAdding={depAdding}
              setDepAdding={setDepAdding}
              depAddResults={depAddResults}
              setDepAddResults={setDepAddResults}
            />
          )}

          {/* ─── Collection Tab ─── */}
          {activeTab === 'collection' && (
          <div className="space-y-4">
            <WorkshopCollectionPanel />
          </div>
          )}

          {/* ─── Deactivated Tab ───
              Tracked mods that are no longer present in the active server INI's
              WorkshopItems= list. Kept tracked so you can re-enable them, but
              segregated from the live server view. */}
          {activeTab === 'deactivated' && (
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <EyeOff className="w-4 h-4 text-muted-foreground" />
                  <CardTitle className="text-base">Deactivated Mods</CardTitle>
                  <Badge variant="outline" className="font-mono text-[11px] tabular-nums">
                    {groupedMods.deactivated.length}
                  </Badge>
                </div>
                <CardDescription>
                  Tracked by the panel but not present in the server INI's <code className="text-[11px]">WorkshopItems=</code> list. They won't be loaded by the server. Re-enable to put them back into the INI, or delete to stop tracking entirely.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {!iniConfig ? (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    Loading server config…
                  </div>
                ) : groupedMods.deactivated.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
                    <CheckCircle className="w-8 h-8 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">
                      No deactivated mods.
                    </p>
                    <p className="text-xs text-muted-foreground/70 max-w-md">
                      Every tracked mod is referenced in the server INI's WorkshopItems= list.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Toolbar: select-all / enable / delete bulk actions */}
                    {(() => {
                      const deactivatedIds = groupedMods.deactivated.map(m => m.workshop_id)
                      const selectedDeactivated = deactivatedIds.filter(id => selectedMods.has(id))
                      const allSelected = selectedDeactivated.length === deactivatedIds.length && deactivatedIds.length > 0
                      const someSelected = selectedDeactivated.length > 0
                      const missingNameCount = groupedMods.deactivated.filter(m => !m.name || /^Workshop Mod /i.test(m.name)).length
                      return (
                        <div className="space-y-2 border-b border-border/40 bg-muted/15 px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="flex items-center gap-2">
                              <Checkbox
                                checked={allSelected}
                                onCheckedChange={(checked) => {
                                  setSelectedMods(prev => {
                                    const next = new Set(prev)
                                    if (checked) {
                                      for (const id of deactivatedIds) next.add(id)
                                    } else {
                                      for (const id of deactivatedIds) next.delete(id)
                                    }
                                    return next
                                  })
                                }}
                                aria-label="Select all deactivated mods"
                              />
                              <span className="text-xs text-muted-foreground">
                                {someSelected ? `${selectedDeactivated.length} selected` : `Select all (${deactivatedIds.length})`}
                              </span>
                            </div>
                            <div className="ml-auto flex items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={!someSelected || loading}
                                onClick={() => handleBulkEnable(selectedDeactivated)}
                              >
                                <PlusCircle className="w-4 h-4 mr-1.5" />
                                Re-enable{someSelected ? ` (${selectedDeactivated.length})` : ''}
                              </Button>
                            </div>
                          </div>
                          <details className="group/deactivated-danger rounded border border-border/35 bg-card/35 px-2.5 py-1.5">
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px] text-muted-foreground hover:text-foreground">
                              <span className="inline-flex items-center gap-1.5">
                                <ChevronRight className="h-3 w-3 transition-transform group-open/deactivated-danger:rotate-90" aria-hidden="true" />
                                Tracking cleanup
                              </span>
                              <span className="text-muted-foreground/65">destructive</span>
                            </summary>
                            <div className="mt-2 flex flex-col gap-2 border-t border-border/25 pt-2 sm:flex-row sm:items-center sm:justify-between">
                              <p className="text-[11px] leading-4 text-muted-foreground">
                                Delete only removes panel tracking. Workshop files stay on disk, but you will need to add the mod manually later.
                              </p>
                              <Button
                                variant="destructive"
                                size="sm"
                                className="self-start sm:self-auto"
                                disabled={loading || (deactivatedIds.length === 0)}
                                onClick={async () => {
                                  const ids = someSelected ? selectedDeactivated : deactivatedIds
                                  const label = someSelected
                                    ? `Delete ${ids.length} selected deactivated mod${ids.length === 1 ? '' : 's'} from tracking? This cannot be undone (re-add them manually if needed).`
                                    : `Delete ALL ${ids.length} deactivated mod${ids.length === 1 ? '' : 's'} from tracking? This cannot be undone (re-add them manually if needed).`
                                  const ok = await confirm({ title: 'Delete from tracking?', description: label, confirmLabel: 'Delete' })
                                  if (!ok) return
                                  setSelectedMods(new Set(ids))
                                  handleBulkRemove(ids)
                                }}
                              >
                                <Trash2 className="w-4 h-4 mr-1.5" />
                                {someSelected ? `Delete selected (${selectedDeactivated.length})` : `Delete all (${deactivatedIds.length})`}
                              </Button>
                            </div>
                          </details>
                          {missingNameCount > 0 && (
                            <div className="flex items-start gap-2 rounded border border-border/40 bg-card/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                              <div className="flex-1 flex items-center gap-2 flex-wrap">
                                <span className="flex-1 min-w-0">
                                  <strong className="text-foreground/80">{missingNameCount}</strong> mod{missingNameCount === 1 ? '' : 's'} show a generic name. Click <strong>Refresh names</strong> to look them up (checks disk first, then the Steam Workshop API).
                                </span>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 px-2 text-[11px]"
                                  disabled={loading}
                                  onClick={() => {
                                    const targets = groupedMods.deactivated
                                      .filter(m => !m.name || /^Workshop Mod /i.test(m.name))
                                      .map(m => m.workshop_id)
                                    handleRefreshNames(targets)
                                  }}
                                >
                                  <RefreshCw className={`w-3 h-3 mr-1 ${loading ? 'animate-spin' : ''}`} />
                                  Refresh names
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* Rows: per-row Enable + Delete; checkbox for bulk select */}
                    <div className="divide-y divide-border/30">
                      {groupedMods.deactivated.map(mod => {
                        const isSelected = selectedMods.has(mod.workshop_id)
                        return (
                          <div
                            key={mod.id}
                            className={`group/modrow flex items-center gap-3 px-3 py-2.5 border-l-2 border-muted-foreground/20 hover:bg-accent/40 transition-colors ${isSelected ? 'bg-accent/30' : ''}`}
                          >
                            <div className="shrink-0">
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={() => toggleModSelect(mod.workshop_id)}
                                aria-label={`Select ${mod.name || mod.workshop_id}`}
                              />
                            </div>
                            <a
                              href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.workshop_id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="shrink-0 relative grid place-items-center w-16 h-16 rounded-md border border-border/50 bg-muted/30 text-muted-foreground overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
                              aria-label={`Open ${mod.name || `Workshop item ${mod.workshop_id}`} on Steam Workshop`}
                              title="Open Steam Workshop page"
                            >
                              <Package className="w-7 h-7" aria-hidden="true" />
                              <img
                                src={demoMode ? `${import.meta.env.BASE_URL}spiffo.png` : `/api/mods/thumbnail/${mod.workshop_id}`}
                                alt=""
                                loading="lazy"
                                decoding="async"
                                className="absolute inset-0 w-full h-full object-cover rounded-md opacity-80"
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                              />
                            </a>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="truncate text-sm font-medium text-foreground/90">
                                  {mod.name || `Workshop Mod ${mod.workshop_id}`}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 flex-wrap mt-0.5 text-[11px] text-muted-foreground">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    copyText(mod.workshop_id).then(() => {
                                      toast({ title: 'Copied', description: `Workshop ID ${mod.workshop_id}` })
                                    }).catch(() => { /* no-op */ })
                                  }}
                                  className="inline-flex items-center gap-1 rounded border border-border/40 bg-muted/40 px-1 py-0.5 font-mono text-[10px] leading-none text-muted-foreground hover:border-primary/40 hover:bg-primary/10 hover:text-primary transition-colors"
                                  aria-label={`Copy workshop ID ${mod.workshop_id}`}
                                >
                                  <span className="text-[9px] font-semibold uppercase tracking-wider opacity-70">WS</span>
                                  <span>{mod.workshop_id}</span>
                                </button>
                                {mod.last_checked && (
                                  <span>Checked {new Date(mod.last_checked).toLocaleDateString()}</span>
                                )}
                              </div>
                            </div>
                            <div className="shrink-0 flex items-center gap-0.5">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <a
                                    href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.workshop_id}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex"
                                  >
                                    <Button
                                      variant="ghost"
                                      size="iconDense"
                                      className="h-8 w-8 text-muted-foreground hover:text-primary"
                                      aria-label="Open workshop page"
                                    >
                                      <ExternalLink className="w-4 h-4" />
                                    </Button>
                                  </a>
                                </TooltipTrigger>
                                <TooltipContent>Open Workshop Page</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="iconDense"
                                    className="h-8 w-8 text-muted-foreground hover:text-primary"
                                    onClick={() => handleEnableMod(mod.workshop_id)}
                                    disabled={loading}
                                    aria-label={`Re-enable ${mod.name || mod.workshop_id}`}
                                  >
                                    <PlusCircle className="w-4 h-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Re-enable (add back to WorkshopItems=)</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="iconDense"
                                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                    onClick={() => setConfirmRemoveMod(mod.workshop_id)}
                                    disabled={loading}
                                    aria-label={`Delete ${mod.name || mod.workshop_id} from tracking`}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Delete from tracking</TooltipContent>
                              </Tooltip>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
          )}
          </div>
        </div>
      </div>

      {/* Single mod remove confirmation */}
      <AlertDialog open={!!confirmRemoveMod} onOpenChange={(open) => { if (!open) setConfirmRemoveMod(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this mod from the server?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the mod from the server INI config so it stops loading. The Workshop files stay on disk (so re-adding later is instant).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (confirmRemoveMod) handleRemoveMod(confirmRemoveMod); setConfirmRemoveMod(null) }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk remove confirmation */}
      <AlertDialog open={confirmBulkRemove} onOpenChange={setConfirmBulkRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {selectedMods.size} mod{selectedMods.size !== 1 ? 's' : ''} from the server?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the selected mods from the server INI config so they stop loading. Workshop files stay on disk (so re-adding later is instant).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { handleBulkRemove(); setConfirmBulkRemove(false) }}
            >
              Remove {selectedMods.size} mod{selectedMods.size !== 1 ? 's' : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}
