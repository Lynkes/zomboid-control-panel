import { useState, useEffect, useContext, useRef, useCallback, useMemo } from 'react'
import {
  Server,
  Plus,
  Trash2,
  Edit2,
  Check,
  Power,
  MoreVertical,
  Loader2,
  FolderOpen,
  Download,
  Search,
  AlertCircle,
  CheckCircle,
  CheckCircle2,
  RefreshCw,
  ShieldCheck,
  Info,
  Globe,
  Monitor,
  Wifi,
  HardDrive,
  Database,
  ArrowRight,
  GitBranch,
  Cpu,
  Network,
  Play,
  Square,
  Container,
  RotateCw,
  Link,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { reportClientError, reportClientWarning } from '@/lib/client-errors'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { serversApi, serversDetectApi, dockerApi, DockerContainerStats, DockerContainerSummary, ServerInstance, configApi, serverApi, updateApi, UpdateStatus, DiscoveredMount, ComposedServerStatus } from '@/lib/api'
import { ServerStatusBadge } from '@/components/ServerStatusBadge'
import { SocketContext } from '@/contexts/SocketContext'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { PasswordInput } from '@/components/PasswordInput'
import { RconTestConnection } from '@/components/RconTestConnection'
import { MountDiscoveryBanner } from '@/components/MountDiscoveryBanner'
import { DiscoverySetup } from '@/components/DiscoverySetup'

interface DetectedServerConfig {
  dataPath: string
  serverConfigPath: string
  dockerContainerName: string
  serverName: string
  iniFile: string
  rconPort: number
  rconPassword: string
  serverPort: number
  publicName: string
  hasRcon: boolean
  matchedBatFile?: string | null
  matchedInstallPath?: string | null
}

interface CustomBatFile {
  path: string
  folder: string
  fileName: string
  serverName: string
}

interface AutoScanResult {
  scanPath: string
  installPaths: string[]
  dataPaths: string[]
  customBatFiles: CustomBatFile[]
  detectedConfigs: DetectedServerConfig[]
}

interface DetectedServer {
  serverName: string
  iniFile: string
  rconPort: number
  rconPassword: string
  serverPort: number
  publicName: string
  hasRcon: boolean
}

interface DetectResult {
  valid: boolean
  dataPath: string
  serverConfigPath: string
  installPath: string
  validInstallPath: boolean
  hasNoSteam: boolean
  detectedServers: DetectedServer[]
}

interface NewServerForm {
  name: string
  serverName: string
  installPath: string
  zomboidDataPath: string
  serverConfigPath: string
  dockerContainerName: string
  rconHost: string
  rconPort: number
  rconPassword: string
  serverPort: number
  minMemory: number
  maxMemory: number
  useNoSteam: boolean
  useDebug: boolean
  isRemote: boolean
}

const defaultNewServer: NewServerForm = {
  name: '',
  serverName: 'servertest',
  installPath: '',
  zomboidDataPath: '',
  serverConfigPath: '',
  dockerContainerName: '',
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
  isRemote: false
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export default function Servers() {
  const [servers, setServers] = useState<ServerInstance[]>([])
  const [serverStatuses, setServerStatuses] = useState<Record<string, { running: boolean; pid: string | null }>>({})
  const [rconStatuses, setRconStatuses] = useState<Record<string, string>>({})
  const [dockerAvailable, setDockerAvailable] = useState(false)
  const [dockerContainers, setDockerContainers] = useState<DockerContainerSummary[]>([])
  const [dockerStats, setDockerStats] = useState<Record<string, DockerContainerStats>>({})
  const [dockerActionPending, setDockerActionPending] = useState<string | null>(null)
  // Full 3-signal status (host/RCON/bridge) for the active server only — the
  // other servers' cards fall back to the host-only signal in serverStatuses.
  const [activeStatus, setActiveStatus] = useState<ComposedServerStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingServer, setEditingServer] = useState<ServerInstance | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [deleteServer, setDeleteServer] = useState<ServerInstance | null>(null)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteProgress, setDeleteProgress] = useState(0)
  const deleteProgressRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [activating, setActivating] = useState<string | number | null>(null)

  // Add server dialog
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newServer, setNewServer] = useState<NewServerForm>(defaultNewServer)
  const [addingServer, setAddingServer] = useState(false)
  const [addMode, setAddMode] = useState<'local' | 'remote'>('local')

  // Two PZ servers on one host must not share a save folder, a server name or
  // a port. PZ binds serverPort and serverPort+1, so adjacent ports collide.
  const samePath = (a?: string | null, b?: string | null) =>
    !!a && !!b && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

  const tandemConflicts = useMemo(() => {
    if (addMode !== 'local') return []
    const others = servers.filter(s => !s.isRemote)
    if (others.length === 0) return []
    const found: Array<{ label: string; detail: string }> = []
    for (const other of others) {
      if (newServer.serverName && other.serverName === newServer.serverName) {
        found.push({ label: 'Config name', detail: `${other.name} already uses ${other.serverName}.ini` })
      }
      if (Math.abs(Number(other.serverPort) - Number(newServer.serverPort)) <= 1) {
        found.push({ label: 'Game port', detail: `${other.name} uses ${other.serverPort} and ${Number(other.serverPort) + 1}` })
      }
      if (Number(other.rconPort) === Number(newServer.rconPort)) {
        found.push({ label: 'RCON port', detail: `${other.name} uses ${other.rconPort}` })
      }
      if (samePath(other.zomboidDataPath, newServer.zomboidDataPath)) {
        found.push({ label: 'Save folder', detail: `${other.name} uses the same Zomboid data folder` })
      }
      if (samePath(other.installPath, newServer.installPath)) {
        found.push({ label: 'Install folder', detail: `shared with ${other.name} — a SteamCMD update or a Workshop download will hit both` })
      }
    }
    return found
  }, [addMode, servers, newServer.serverName, newServer.serverPort, newServer.rconPort, newServer.zomboidDataPath, newServer.installPath])

  // Detection state
  const [detecting, setDetecting] = useState(false)
  const [detectResult, setDetectResult] = useState<DetectResult | null>(null)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [selectedServerConfig, setSelectedServerConfig] = useState<string>('')

  // Auto-scan state
  const [autoScanning, setAutoScanning] = useState(false)
  const [autoScanPath, setAutoScanPath] = useState('')
  const [autoScanResult, setAutoScanResult] = useState<AutoScanResult | null>(null)
  const [showAutoScan, setShowAutoScan] = useState(false)

  // Steam update/verify state
  const [steamOperation, setSteamOperation] = useState<{ server: ServerInstance; type: 'update' | 'verify'; branch: string } | null>(null)
  const [steamLogs, setSteamLogs] = useState<string[]>([])
  const [steamRunning, setSteamRunning] = useState(false)
  const [steamCompleted, setSteamCompleted] = useState<'success' | 'error' | null>(null)
  const [clearingInstall, setClearingInstall] = useState(false)
  const [confirmClearInstall, setConfirmClearInstall] = useState(false)
  const [steamcmdPath, setSteamcmdPath] = useState('')
  const [updateInfo, setUpdateInfo] = useState<UpdateStatus | null>(null)
  const [gameVersion, setGameVersion] = useState<string | null>(null)
  const [availableBranches, setAvailableBranches] = useState<Array<{name: string, description: string, buildId?: string | null, timeUpdated?: string | null}>>([
    { name: 'public', description: 'Public (Stable)' },
    { name: 'unstable', description: 'Unstable beta' }
  ])
  const [loadingBranches, setLoadingBranches] = useState(false)

  // Mount discovery — offers a one-click "connect this" profile when PZ
  // server files are found at a common bind-mount path and no profile
  // uses them yet.
  const [discoveredMounts, setDiscoveredMounts] = useState<DiscoveredMount[]>([])
  const [scanningMounts, setScanningMounts] = useState(false)
  const [discoverySetupMount, setDiscoverySetupMount] = useState<DiscoveredMount | null>(null)
  const connectableMounts = discoveredMounts.filter(
    (mount) => mount.dataPath && mount.serverNames.length > 0,
  )
  const activeServerId = servers.find((server) => server.isActive)?.id ?? null

  const { toast } = useToast()
  const socket = useContext(SocketContext)
  const navigate = useNavigate()



  // Fetch servers
  const fetchServers = useCallback(async () => {
    try {
      const data = await serversApi.getAll()
      setServers(data.servers || [])
    } catch (error) {
      reportClientError('Failed to fetch servers.', error)
      toast({ title: 'Error', description: 'Failed to load servers', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [toast])

  // Per-server running status — scans host processes once and attributes
  // matches to each configured server's install path. Refreshes on a slow
  // 15s cadence (process detection is heavyweight) and on socket events.
  // Skipped while the tab is hidden so background tabs don't keep firing
  // a heavyweight host-process scan.
  const fetchServerStatuses = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    try {
      const data = await serversApi.getStatus()
      const next: Record<string, { running: boolean; pid: string | null }> = {}
      for (const s of data.servers || []) {
        next[String(s.id)] = { running: !!s.running, pid: s.pid }
      }
      setServerStatuses(next)
    } catch (error) {
      // Non-fatal: status is supplemental info, not the source of truth.
      reportClientWarning('Failed to fetch per-server status.', error)
    }
  }, [])

  const fetchRconStatuses = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    try {
      const data = await serversApi.getRconStatuses()
      setRconStatuses(Object.fromEntries((data.servers || []).map((server) => [String(server.id), server.status])))
    } catch (error) {
      reportClientWarning('Failed to fetch per-server RCON status.', error)
    }
  }, [])

  const fetchDockerState = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    try {
      const status = await dockerApi.getStatus()
      setDockerAvailable(status.enabled && status.available)
      setDockerContainers(status.containers || [])
      if (!status.enabled || !status.available) {
        setDockerStats({})
        return
      }
      const stats = await dockerApi.getStats()
      setDockerStats(stats.containers || {})
    } catch (error) {
      setDockerAvailable(false)
      reportClientWarning('Failed to fetch managed Docker state.', error)
    }
  }, [])

  const handleDockerAction = useCallback(async (
    container: DockerContainerSummary,
    action: 'start' | 'stop' | 'restart',
  ) => {
    setDockerActionPending(`${action}-${container.id}`)
    try {
      const server = servers.find((item) => item.dockerContainerName === container.name || item.dockerContainerName === container.id)
      if (!server) throw new Error('No server profile maps to this container')
      const result = await dockerApi.runAction(server.dockerContainerName || container.id, action, server.id)
      if (!result.success) throw new Error(result.error || `Failed to ${action} container`)
      toast({ title: `Container ${action} requested`, description: container.name, variant: 'success' as const })
      await fetchDockerState()
    } catch (error) {
      toast({
        title: `Container ${action} failed`,
        description: error instanceof Error ? error.message : 'Docker action failed',
        variant: 'destructive',
      })
    } finally {
      setDockerActionPending(null)
    }
  }, [fetchDockerState, servers, toast])

  const handleConfigureRemoteBridge = useCallback(async (server: ServerInstance) => {
    try {
      if (!server.isActive) {
        await serversApi.activate(server.id)
        await fetchServers()
      }
      navigate('/settings?tab=bridge')
    } catch (error) {
      toast({
        title: 'Could not select remote server',
        description: error instanceof Error ? error.message : 'Server activation failed',
        variant: 'destructive',
      })
    }
  }, [fetchServers, navigate, toast])

  // Provider-aware host/RCON/bridge status for whichever server is active —
  // shown on its card via ServerStatusBadge instead of a single Running/
  // Stopped flag that hides RCON/bridge trouble behind a "running" container.
  const fetchActiveStatus = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    try {
      setActiveStatus(await serversApi.getComposedStatus())
    } catch (error) {
      setActiveStatus(null)
      reportClientWarning('Failed to fetch active server status.', error)
    }
  }, [])

  // Load steamcmd path and servers on mount
  useEffect(() => {
    fetchServers()
    fetchServerStatuses()
    fetchRconStatuses()
    fetchDockerState()
    const statusInterval = setInterval(fetchServerStatuses, 15000)
    const rconStatusInterval = setInterval(fetchRconStatuses, 30000)
    const dockerInterval = setInterval(fetchDockerState, 10000)
    // Load steamcmd path from settings
    configApi.getAppSettings().then(data => {
      if (data.settings?.steamcmdPath) {
        setSteamcmdPath(data.settings.steamcmdPath)
      }
    }).catch(e => reportClientWarning('Failed to load settings.', e))
    // Load update status
    updateApi.getStatus().then(status => {
      if (status.updateAvailable?.updateAvailable) {
        setUpdateInfo(status.updateAvailable)
      }
      if (status.gameVersion) {
        setGameVersion(status.gameVersion)
      }
    }).catch(e => reportClientWarning('Failed to load update status.', e))
    return () => {
      clearInterval(statusInterval)
      clearInterval(rconStatusInterval)
      clearInterval(dockerInterval)
    }
  }, [fetchServers, fetchServerStatuses, fetchRconStatuses, fetchDockerState])

  useEffect(() => {
    if (!activeServerId) {
      setActiveStatus(null)
      return
    }
    fetchActiveStatus()
    const interval = setInterval(fetchActiveStatus, 10000)
    return () => clearInterval(interval)
  }, [activeServerId, fetchActiveStatus])

  // Silently probe for common bind-mount PZ installs — non-fatal since the
  // banner is a convenience, not a requirement.
  useEffect(() => {
    serversApi.discoverMounts()
      .then(data => setDiscoveredMounts(data.mounts || []))
      .catch(e => reportClientWarning('Mount discovery failed.', e))
  }, [])

  const handleScanMounts = async () => {
    setScanningMounts(true)
    try {
      const data = await serversApi.discoverMounts()
      const mounts = data.mounts || []
      const connectableCount = mounts.filter(
        (mount) => mount.dataPath && mount.serverNames.length > 0,
      ).length
      setDiscoveredMounts(mounts)
      toast({
        title: connectableCount
          ? `${connectableCount} server${connectableCount === 1 ? '' : 's'} found`
          : 'No servers found',
      })
    } catch (error) {
      toast({
        title: 'Scan Failed',
        description: error instanceof Error ? error.message : 'Mount discovery failed',
        variant: 'destructive'
      })
    } finally {
      setScanningMounts(false)
    }
  }

  // Listen for update status changes (clears banner after successful update)
  useEffect(() => {
    if (!socket) return

    const handleUpdateAvailable = (data: UpdateStatus) => {
      setUpdateInfo(data.updateAvailable ? data : null)
    }
    const handleUpdateCheck = (data: UpdateStatus) => {
      setUpdateInfo(data.updateAvailable ? data : null)
    }

    socket.on('server:updateAvailable', handleUpdateAvailable)
    socket.on('server:updateCheck', handleUpdateCheck)
    return () => {
      socket.off('server:updateAvailable', handleUpdateAvailable)
      socket.off('server:updateCheck', handleUpdateCheck)
    }
  }, [socket])

  // Fetch available Steam branches when steam operation dialog opens
  useEffect(() => {
    if (!steamOperation) return

    const fetchBranches = async () => {
      setLoadingBranches(true)
      try {
        const detection = await serverApi.detectSteamCmd()
        const resolvedSteamcmdPath = detection.found && detection.path ? detection.path : steamcmdPath
        if (resolvedSteamcmdPath && resolvedSteamcmdPath !== steamcmdPath) {
          setSteamcmdPath(resolvedSteamcmdPath)
        }
        const data = await serverApi.getBranches(resolvedSteamcmdPath)
        if (data.branches && Array.isArray(data.branches)) {
          setAvailableBranches(() => {
            const fetched = data.branches as Array<{ name: string; description: string; buildId?: string | null }>
            // SteamCMD's anonymous branch listing usually only returns `public`.
            // Make sure the installed branch, the server's branch, and the currently
            // selected branch all remain pickable so we never silently drop the user's choice.
            const extras: typeof fetched = []
            const have = new Set(fetched.map(b => b.name))
            const normalize = (v: string | undefined | null) => (v || '').trim().toLowerCase()
            const candidates = [
              normalize(updateInfo?.installed?.branch),
              normalize(steamOperation?.server.branch),
              normalize(steamOperation?.branch),
            ].filter(Boolean) as string[]
            for (const name of candidates) {
              if (!have.has(name)) {
                const description = name === 'unstable'
                  ? 'Build 42 testing branch. Back up saves and expect mod incompatibilities.'
                  : name === 'iwbums'
                    ? 'Experimental testing branch. Back up saves before switching.'
                    : 'Beta branch selected for this server.'
                extras.push({ name, description })
                have.add(name)
              }
            }
            return [...fetched, ...extras]
          })
          // Only reconcile the selected branch if it's truly unknown and not the
          // installed/server branch. Never override what the server is actually running.
          setSteamOperation((prev) => {
            if (!prev) return prev
            const names = new Set(data.branches.map((b: { name: string }) => b.name))
            const installed = (updateInfo?.installed?.branch || '').trim().toLowerCase()
            const serverBranch = (prev.server.branch || '').trim().toLowerCase()
            if (prev.branch === installed) return prev
            if (prev.branch === serverBranch) return prev
            if (names.has(prev.branch)) return prev
            const fallback = installed || serverBranch || (names.has('public') ? 'public' : data.branches[0]?.name)
            return fallback ? { ...prev, branch: fallback } : prev
          })
        }
      } catch (error) {
        reportClientError('Failed to fetch branches.', error)
        // Keep default branches on error
      } finally {
        setLoadingBranches(false)
      }
    }

    fetchBranches()
  }, [steamOperation, steamcmdPath, updateInfo?.installed?.branch])

  // Listen for server changes
  useEffect(() => {
    if (!socket) return

    const handleActiveServerChanged = () => {
      setActiveStatus(null)
      fetchServers()
    }

    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, fetchServers])

  // Listen for Steam update/verify events
  useEffect(() => {
    if (!socket) return

    const handleSteamStart = (data: { type: string; message: string }) => {
      setSteamRunning(true)
      setSteamLogs([data.message])
    }

    const handleSteamLog = (data: { type: string; text: string }) => {
      setSteamLogs(prev => [...prev.slice(-200), data.text]) // Keep last 200 lines
    }

    const handleSteamComplete = (data: { success: boolean; message: string }) => {
      setSteamRunning(false)
      setSteamCompleted(data.success ? 'success' : 'error')
      setSteamLogs(prev => [...prev, '', data.success ? '✓ ' + data.message : '✗ ' + data.message])
      toast({
        title: data.success ? 'Success' : 'Failed',
        description: data.message,
        variant: data.success ? 'default' : 'destructive'
      })
    }

    socket.on('steam:start', handleSteamStart)
    socket.on('steam:log', handleSteamLog)
    socket.on('steam:complete', handleSteamComplete)

    return () => {
      socket.off('steam:start', handleSteamStart)
      socket.off('steam:log', handleSteamLog)
      socket.off('steam:complete', handleSteamComplete)
    }
  }, [socket, toast])

  // Detect server settings from data path
  const handleDetectServer = async () => {
    if (!newServer.zomboidDataPath.trim()) {
      toast({ title: 'Error', description: 'Please enter the server data path first', variant: 'destructive' })
      return
    }

    setDetecting(true)
    setDetectError(null)
    setDetectResult(null)
    setSelectedServerConfig('')

    try {
      const data = await serversDetectApi.detect({
        dataPath: newServer.zomboidDataPath,
        installPath: newServer.installPath || undefined
      }) as unknown as DetectResult & { error?: string }

      if (!data || data.error) {
        setDetectError(data?.error || 'Detection failed')
        return
      }

      setDetectResult(data)

      // Auto-select first server if only one
      if (data.detectedServers.length === 1) {
        handleSelectServerConfig(data.detectedServers[0], data)
      } else if (data.detectedServers.length > 1) {
        toast({
          title: 'Multiple Servers Found',
          description: 'Please select which server configuration to use'
        })
      }

      // Update useNoSteam based on detection
      if (data.hasNoSteam) {
        setNewServer(prev => ({ ...prev, useNoSteam: true }))
      }

    } catch (error) {
      setDetectError(error instanceof Error ? error.message : 'Detection failed')
    } finally {
      setDetecting(false)
    }
  }

  // Auto-scan a folder to find all PZ server paths
  const handleAutoScan = async () => {
    if (!autoScanPath.trim()) {
      toast({ title: 'Error', description: 'Please enter a folder path to scan', variant: 'destructive' })
      return
    }

    setAutoScanning(true)
    setAutoScanResult(null)

    try {
      const data = await serversDetectApi.autoScan({ scanPath: autoScanPath, maxDepth: 4 }) as unknown as AutoScanResult & { error?: string }

      if (!data || data.error) {
        toast({ title: 'Scan Failed', description: data.error || 'Unknown error', variant: 'destructive' })
        return
      }

      setAutoScanResult(data)

      if (data.detectedConfigs.length === 0) {
        toast({
          title: 'No servers found',
          description: 'No Project Zomboid servers were found in the scanned folder'
        })
      } else {
        toast({
          title: 'Servers found!',
          description: `Found ${data.detectedConfigs.length} server configuration(s)`
        })
      }

    } catch (error) {
      toast({
        title: 'Scan Failed',
        description: error instanceof Error ? error.message : 'Auto-scan failed',
        variant: 'destructive'
      })
    } finally {
      setAutoScanning(false)
    }
  }

  // Select a scanned server config and populate the form
  const handleSelectScannedConfig = (config: DetectedServerConfig, installPath?: string) => {
    // Use matched bat file if available, otherwise use provided installPath
    const effectiveInstallPath = config.matchedBatFile || installPath || ''

    setNewServer({
      ...defaultNewServer,
      name: config.publicName || config.serverName,
      serverName: config.serverName,
      zomboidDataPath: config.dataPath,
      installPath: effectiveInstallPath,
      rconPort: config.rconPort,
      rconPassword: config.rconPassword,
      serverPort: config.serverPort,
    })
    setSelectedServerConfig(config.serverName)
    setShowAutoScan(false)

    // Also set the detect result for consistency
    setDetectResult({
      valid: true,
      dataPath: config.dataPath,
      serverConfigPath: config.serverConfigPath,
      installPath: effectiveInstallPath,
      validInstallPath: !!effectiveInstallPath,
      hasNoSteam: false,
      detectedServers: [{
        serverName: config.serverName,
        iniFile: config.iniFile,
        rconPort: config.rconPort,
        rconPassword: config.rconPassword,
        serverPort: config.serverPort,
        publicName: config.publicName,
        hasRcon: config.hasRcon
      }]
    })
  }

  // Select a detected server config
  const handleSelectServerConfig = (config: DetectedServer, result?: DetectResult) => {
    const res = result || detectResult
    setSelectedServerConfig(config.serverName)
    setNewServer(prev => ({
      ...prev,
      name: config.publicName || config.serverName,
      serverName: config.serverName,
      zomboidDataPath: res?.dataPath || prev.zomboidDataPath,
      serverConfigPath: res?.serverConfigPath || prev.serverConfigPath,
      rconPort: config.rconPort,
      rconPassword: config.rconPassword,
      serverPort: config.serverPort
    }))

    if (!config.hasRcon) {
      toast({
        title: 'RCON not configured',
        description: 'This server has no RCON password set. You\'ll need to configure it in the server INI file.',
        variant: 'destructive'
      })
    }
  }

  const handleActivateServer = useCallback(async (server: ServerInstance) => {
    if (server.isActive) return

    setActivating(server.id)
    try {
      await serversApi.activate(server.id)
      toast({
        title: 'Server Activated',
        description: `Now managing: ${server.name}`
      })
      fetchServers()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to activate server',
        variant: 'destructive'
      })
    } finally {
      setActivating(null)
    }
  }, [toast, fetchServers])

  // Inline Start/Stop on server cards. The Node side `serverApi.start/stop`
  // operate on the currently-active instance only, so for inactive servers
  // we activate first, wait for the switch to land, then issue start. This
  // mirrors what users would otherwise do manually from the dropdown.
  const [serverActionPending, setServerActionPending] = useState<string | null>(null)
  const handleInlineStart = useCallback(async (server: ServerInstance) => {
    setServerActionPending(`start-${server.id}`)
    try {
      if (!server.isActive) {
        await serversApi.activate(server.id)
      }
      await serverApi.start()
      toast({ title: 'Server Starting', description: server.name || server.serverName })
      fetchServers()
      fetchServerStatuses()
    } catch (error) {
      toast({
        title: 'Failed to start server',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setServerActionPending(null)
    }
  }, [toast, fetchServers, fetchServerStatuses])

  const handleInlineStop = useCallback(async (server: ServerInstance) => {
    setServerActionPending(`stop-${server.id}`)
    try {
      if (!server.isActive) {
        await serversApi.activate(server.id)
      }
      await serverApi.stop()
      toast({ title: 'Server Stopping', description: server.name || server.serverName })
      fetchServers()
      fetchServerStatuses()
    } catch (error) {
      toast({
        title: 'Failed to stop server',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setServerActionPending(null)
    }
  }, [toast, fetchServers, fetchServerStatuses])

  const handleDeleteServer = async () => {
    if (!deleteServer) return

    setDeleting(true)
    setDeleteProgress(0)

    // Animate progress: fast to ~70%, then slow crawl to ~90%
    let prog = 0
    deleteProgressRef.current = setInterval(() => {
      prog += prog < 70 ? 8 : 1
      if (prog > 92) prog = 92
      setDeleteProgress(prog)
    }, 200)

    try {
      // If deleteFiles is checked and server has an installPath, delete the files first
      if (deleteFiles && deleteServer.installPath) {
        try {
          const result = await serversDetectApi.deleteFiles(deleteServer.installPath) as { error?: string }
          if (result?.error) {
            toast({
              title: 'File deletion failed',
              description: result.error,
              variant: 'destructive'
            })
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Could not delete server files'
          toast({
            title: 'Warning',
            description: `${msg} — removing from panel anyway.`,
            variant: 'destructive'
          })
        }
      }

      await serversApi.delete(deleteServer.id)

      // Complete the progress bar before closing
      if (deleteProgressRef.current) clearInterval(deleteProgressRef.current)
      setDeleteProgress(100)
      await new Promise(r => setTimeout(r, 350))

      toast({
        title: 'Deleted',
        description: deleteFiles
          ? `Server "${deleteServer.name}" and its files have been deleted`
          : `Server "${deleteServer.name}" removed from panel`
      })
      setDeleteServer(null)
      setDeleteFiles(false)
      fetchServers()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete server',
        variant: 'destructive'
      })
    } finally {
      if (deleteProgressRef.current) clearInterval(deleteProgressRef.current)
      setDeleting(false)
      setDeleteProgress(0)
    }
  }

  const handleSaveEdit = async () => {
    if (!editingServer || savingEdit) return

    // Validate port range
    if (editingServer.rconPort < 1 || editingServer.rconPort > 65535) {
      toast({ title: 'Error', description: 'RCON port must be between 1 and 65535', variant: 'destructive' })
      return
    }

    setSavingEdit(true)
    try {
      await serversApi.update(editingServer.id, editingServer)
      toast({ title: 'Saved', description: 'Server settings updated' })
      setEditingServer(null)
      fetchServers()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update server',
        variant: 'destructive'
      })
    } finally {
      setSavingEdit(false)
    }
  }

  // Start Steam update/verify operation
  const handleStartSteamOperation = async () => {
    if (!steamOperation || !steamcmdPath.trim()) {
      toast({ title: 'Error', description: 'Please enter the SteamCMD path', variant: 'destructive' })
      return
    }

    const installFolder = getInstallFolder(steamOperation.server.installPath)
    if (!installFolder) {
      toast({ title: 'Error', description: 'Server install path not configured', variant: 'destructive' })
      return
    }

    // Save steamcmd path to settings for future use
    try {
      await configApi.updateAppSettings({ steamcmdPath })
    } catch (e) {
      // Non-critical, continue anyway
    }

    setSteamLogs([])
    setSteamRunning(true)
    setSteamCompleted(null)

    try {
      if (steamOperation.type === 'verify') {
        await serversApi.steamVerify(steamcmdPath, installFolder, steamOperation.branch)
      } else {
        await serversApi.steamUpdate(steamcmdPath, installFolder, steamOperation.branch)
      }
    } catch (error) {
      setSteamRunning(false)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to start operation',
        variant: 'destructive'
      })
    }
  }

  // Wipe the install folder so a stuck/corrupted SteamCMD state (partial
  // download, mismatched appmanifest, "Missing configuration" etc.) can be
  // fixed by reinstalling from scratch, without needing shell access.
  // Reuses the same guarded /delete-files endpoint the "Remove Server ->
  // Delete Everything" flow uses (requires PZ marker files to be present,
  // refuses to delete folders it doesn't recognize as a PZ install).
  const handleClearInstallFolder = async () => {
    if (!steamOperation) return
    const installFolder = getInstallFolder(steamOperation.server.installPath)
    if (!installFolder) {
      toast({ title: 'Error', description: 'Server install path not configured', variant: 'destructive' })
      return
    }

    setClearingInstall(true)
    try {
      const result = await serversDetectApi.deleteFiles(installFolder) as { error?: string }
      if (result?.error) {
        toast({ title: 'Could Not Clear Folder', description: result.error, variant: 'destructive' })
        return
      }
      setSteamLogs([])
      setSteamCompleted(null)
      toast({
        title: 'Installation Folder Cleared',
        description: 'The folder was wiped. Click Start Update to reinstall from scratch.',
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to clear installation folder',
        variant: 'destructive',
      })
    } finally {
      setClearingInstall(false)
      setConfirmClearInstall(false)
    }
  }

  // Open steam operation dialog
  const openSteamOperation = async (server: ServerInstance, type: 'update' | 'verify') => {
    // Prefer the branch that's actually installed on disk (from steamcmd appmanifest),
    // then fall back to the server's stored branch, then to Steam's default 'public'.
    // Steam's stable branch is named 'public'; map legacy 'stable' to it so it matches the fetched list.
    const normalize = (v: string | undefined | null) => (v || '').trim().toLowerCase()
    const installed = normalize(updateInfo?.installed?.branch)
    const stored = normalize(server.branch)
    const pick = installed || stored
    const initialBranch = !pick || pick === 'stable' ? 'public' : pick
    setSteamOperation({ server, type, branch: initialBranch })
    setSteamLogs([])
    setSteamRunning(false)
    setSteamCompleted(null)

    // Load steamcmd path from settings if not already set
    if (!steamcmdPath) {
      try {
        const data = await configApi.getAppSettings()
        if (data.settings?.steamcmdPath) {
          setSteamcmdPath(data.settings.steamcmdPath)
        }
      } catch (e) {
        // Ignore - user can enter manually
      }
    }
  }

  // Get clean install path (folder only, not batch file)
  const getInstallFolder = (installPath: string | undefined): string => {
    if (!installPath) return ''
    // If path ends with a script/executable, get the parent folder
    if (/\.(bat|sh|exe)$/i.test(installPath)) {
      const lastSlash = Math.max(installPath.lastIndexOf('\\'), installPath.lastIndexOf('/'))
      return lastSlash > 0 ? installPath.substring(0, lastSlash) : installPath
    }
    return installPath
  }

  const handleAddExistingServer = async () => {
    // For remote servers, only need name, rcon credentials
    if (addMode === 'remote') {
      if (!newServer.name.trim()) {
        toast({ title: 'Error', description: 'Server name is required', variant: 'destructive' })
        return
      }
      if (!newServer.rconHost.trim()) {
        toast({ title: 'Error', description: 'RCON host is required', variant: 'destructive' })
        return
      }
      if (!newServer.rconPassword.trim()) {
        toast({ title: 'Error', description: 'RCON password is required', variant: 'destructive' })
        return
      }
    } else {
      // Local server validation
      if (!selectedServerConfig) {
        toast({ title: 'Error', description: 'Please detect a server first', variant: 'destructive' })
        return
      }
      if (!newServer.rconPassword.trim()) {
        toast({ title: 'Error', description: 'RCON password is required. Configure it in your server INI file first.', variant: 'destructive' })
        return
      }
    }

    setAddingServer(true)
    try {
      const createResult = await serversApi.create({
        name: newServer.name || newServer.serverName,
        serverName: newServer.serverName,
        installPath: newServer.installPath,
        zomboidDataPath: newServer.zomboidDataPath,
        serverConfigPath: newServer.serverConfigPath,
        rconHost: newServer.rconHost,
        rconPort: newServer.rconPort,
        rconPassword: newServer.rconPassword,
        dockerContainerName: newServer.dockerContainerName || null,
        serverPort: newServer.serverPort,
        minMemory: newServer.minMemory,
        maxMemory: newServer.maxMemory,
        useNoSteam: newServer.useNoSteam,
        useDebug: newServer.useDebug,
        isRemote: addMode === 'remote'
      } as Partial<ServerInstance>)

      if (createResult.server?.id) {
        await serversApi.activate(createResult.server.id)
      }

      toast({ title: 'Server Added', description: `"${newServer.name}" added to panel` })
      setShowAddDialog(false)
      setNewServer(defaultNewServer)
      setDetectResult(null)
      setDetectError(null)
      setSelectedServerConfig('')
      fetchServers()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to add server',
        variant: 'destructive'
      })
    } finally {
      setAddingServer(false)
    }
  }

  const resetAddDialog = () => {
    setShowAddDialog(false)
    setNewServer(defaultNewServer)
    setDetectResult(null)
    setDetectError(null)
    setSelectedServerConfig('')
    setAutoScanResult(null)
    setAutoScanPath('')
    setShowAutoScan(false)
    setAddMode('local')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6 page-transition">
      {/* Header */}
      <PageHeader
        title="Managed Servers"
        description="Manage multiple Project Zomboid servers from one panel"
        eyebrow="Fleet"
        tone="servers"
        icon={<Server className="w-5 h-5 text-primary" />}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={handleScanMounts}
              disabled={scanningMounts}
              aria-label="Scan for servers"
              title="Scan for servers"
            >
              {scanningMounts ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Search className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>
            <Button variant="outline" onClick={() => { setAddMode('remote'); setShowAddDialog(true) }}>
              <Globe className="w-4 h-4 mr-2" /> Add Remote Server
            </Button>
            <Button variant="outline" onClick={() => { setAddMode('local'); setShowAddDialog(true) }}>
              <FolderOpen className="w-4 h-4 mr-2" /> Add Existing Server
            </Button>
            <Button variant="command" onClick={() => navigate('/server-setup')}>
              <Download className="w-4 h-4 mr-2" /> Install New Server
            </Button>
          </div>
        }
      />

      {/* Discovered mounts — offer a one-click connect when no server profile uses them yet */}
      {servers.length === 0 && connectableMounts.length > 0 && (
        <div className="space-y-2">
          {connectableMounts.map(mount => (
            <MountDiscoveryBanner
              key={mount.installPath}
              mount={mount}
              onConnect={setDiscoverySetupMount}
            />
          ))}
        </div>
      )}

      {/* Server Grid */}
      {servers.length === 0 ? (
        <Card className="mission-brief overflow-hidden border-primary/20 bg-card">
          <CardContent className="py-10">
            <div className="mx-auto max-w-4xl space-y-8">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
                  <Server className="h-7 w-7" />
                </div>
                <h3 className="text-xl font-semibold text-foreground">No Servers Configured</h3>
                <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Start with one server. After it is active, dashboard, players, backups, mods, and remote actions come online.
                </p>
              </div>

              <div className="mission-step-grid grid gap-4 md:grid-cols-3">
                <div className="mission-step-card rounded-2xl border border-border/60 bg-background/40 p-5">
                  <div className="mission-step-icon mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                    <FolderOpen className="h-5 w-5" />
                  </div>
                  <p className="text-sm font-semibold text-foreground">Add an existing local server</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Use this when server files already exist on this machine.
                  </p>
                  <Button variant="outline" className="onboarding-cta mt-4 w-full" onClick={() => { setAddMode('local'); setShowAddDialog(true) }}>
                    <FolderOpen className="mr-2 h-4 w-4" />
                    Add Existing Server
                  </Button>
                </div>

                <div className="mission-step-card rounded-2xl border border-border/60 bg-background/40 p-5">
                  <div className="mission-step-icon mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                    <Download className="h-5 w-5" />
                  </div>
                  <p className="text-sm font-semibold text-foreground">Install a new local server</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Use the installer when you need files, ports, passwords, and memory setup in one flow.
                  </p>
                  <Button className="onboarding-cta mt-4 w-full" onClick={() => navigate('/server-setup')}>
                    <Download className="mr-2 h-4 w-4" />
                    Install New Server
                  </Button>
                </div>

                <div className="mission-step-card rounded-2xl border border-border/60 bg-background/40 p-5">
                  <div className="mission-step-icon mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                    <Globe className="h-5 w-5" />
                  </div>
                  <p className="text-sm font-semibold text-foreground">Connect a remote server</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Use this for servers running on another machine through RCON.
                  </p>
                  <Button variant="secondary" className="onboarding-cta mt-4 w-full" onClick={() => { setAddMode('remote'); setShowAddDialog(true) }}>
                    <Globe className="mr-2 h-4 w-4" />
                    Add Remote Server
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 rounded-2xl border border-border/60 bg-background/30 p-5 md:grid-cols-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">Step 1</p>
                  <p className="mt-1 text-sm font-medium text-foreground">Bring in one server</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">Step 2</p>
                  <p className="mt-1 text-sm font-medium text-foreground">Set it active and verify RCON</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">Step 3</p>
                  <p className="mt-1 text-sm font-medium text-foreground">Return to Dashboard for live control</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 stagger-in">
          {servers.map(server => {
            const hasUpdate = updateInfo?.updateAvailable && server.isActive
            return (
            <Card
              key={server.id}
              className={`relative overflow-hidden transition-colors ${
                server.isActive
                  ? 'border-primary/60 ring-1 ring-primary/25 bg-gradient-to-br from-primary/[0.04] via-card to-card'
                  : 'hover:border-primary/30'
              } ${hasUpdate ? 'border-warning/60' : ''}`}
            >
              {/* Active indicator bar — thicker gradient stripe when active */}
              {server.isActive && (
                <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-primary via-primary/80 to-primary/40" aria-hidden="true" />
              )}
              {hasUpdate && !server.isActive && (
                <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-warning via-warning/80 to-warning/40" aria-hidden="true" />
              )}

              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <CardTitle className="flex items-center gap-2 flex-wrap min-w-0">
                      <span className="truncate">{server.name}</span>
                      {server.isActive ? (
                        <Badge variant="default" className="text-xs">
                          <Check className="w-3 h-3 mr-1" /> Selected
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          Inactive
                        </Badge>
                      )}
                      {(() => {
                        // The selected server has real RCON/bridge signals from the
                        // composed status endpoint; every other card only knows
                        // whatever the host-process scan found for it.
                        if (server.isActive && activeStatus) {
                          return (
                            <ServerStatusBadge
                              compact
                              host={activeStatus.host}
                              server={activeStatus.server}
                              bridge={activeStatus.bridge}
                            />
                          )
                        }
                        const status = serverStatuses[String(server.id)]
                        const host = server.isRemote
                          ? { status: 'unknown', label: 'Host' }
                          : status
                            ? { status: status.running ? 'running' : 'stopped', label: 'Process' }
                            : undefined
                        const rconStatus = rconStatuses[String(server.id)]
                        const rcon = rconStatus
                          ? rconStatus === 'connected'
                            ? { status: 'connected', label: 'RCON' }
                            : rconStatus === 'unconfigured'
                              ? { status: 'unknown', label: 'RCON', detail: 'Not configured' }
                              : { status: 'disconnected', label: 'RCON', detail: rconStatus === 'auth_failed' ? 'Authentication failed' : 'Unavailable' }
                          : undefined
                        return <ServerStatusBadge compact host={host} server={rcon} />
                      })()}
                      {server.isRemote && (
                        <Badge variant="outline" className="text-xs">
                          <Globe className="w-3 h-3 mr-1" /> Remote
                        </Badge>
                      )}
                      {hasUpdate && (
                        <Badge variant="warning" className="text-xs">
                          <RefreshCw className="w-3 h-3 mr-1" /> Update Available
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription className="font-mono text-xs">
                      {server.serverName}
                    </CardDescription>
                  </div>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="iconDense" className="shrink-0" aria-label={`Options for ${server.name || server.serverName}`}>
                        <MoreVertical className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditingServer({ ...server })}>
                        <Edit2 className="w-4 h-4 mr-2" /> Edit
                      </DropdownMenuItem>
                      {!server.isActive && (
                        <DropdownMenuItem onClick={() => handleActivateServer(server)} disabled={activating !== null}>
                          <Power className="w-4 h-4 mr-2" /> Set Active
                        </DropdownMenuItem>
                      )}
                      {!server.isRemote && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => openSteamOperation(server, 'update')}>
                            <RefreshCw className="w-4 h-4 mr-2" /> Update Server
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openSteamOperation(server, 'verify')}>
                            <ShieldCheck className="w-4 h-4 mr-2" /> Verify Files
                          </DropdownMenuItem>
                        </>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => setDeleteServer(server)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="w-4 h-4 mr-2" /> Remove from Panel
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                {/* Paths Section */}
                {!server.isRemote && (server.installPath || server.zomboidDataPath) && (
                  <div className="rounded-md border border-border/40 bg-muted/15 divide-y divide-border/30">
                    {server.installPath && (
                      <div className="flex items-start gap-2.5 px-3 py-2">
                        <HardDrive className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Install Path</p>
                          <p className="font-mono text-xs text-foreground/85 truncate mt-0.5" title={server.installPath}>{server.installPath}</p>
                        </div>
                      </div>
                    )}
                    {server.zomboidDataPath && (
                      <div className="flex items-start gap-2.5 px-3 py-2">
                        <Database className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Data Path</p>
                          <p className="font-mono text-xs text-foreground/85 truncate mt-0.5" title={server.zomboidDataPath}>{server.zomboidDataPath}</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {(() => {
                  const container = server.dockerContainerName
                    ? dockerContainers.find((item) => item.name === server.dockerContainerName || item.id === server.dockerContainerName)
                    : null
                  if (!container || !dockerAvailable) return null
                  const stats = dockerStats[container.id] || dockerStats[container.name]
                  const isRunning = container.state === 'running'
                  const pending = dockerActionPending !== null
                  return (
                    <div className="space-y-2 border-y border-border/50 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <Container className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="truncate text-xs font-medium">{container.name}</span>
                          <span className={cn('text-xs', isRunning ? 'text-muted-foreground' : 'text-destructive')}>
                            {container.state}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="iconDense" variant="ghost" disabled={pending || isRunning} onClick={() => handleDockerAction(container, 'start')} aria-label={`Start ${container.name}`}>
                                {dockerActionPending === `start-${container.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Start container</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="iconDense" variant="ghost" disabled={pending || !isRunning} onClick={() => handleDockerAction(container, 'stop')} aria-label={`Stop ${container.name}`}>
                                {dockerActionPending === `stop-${container.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Stop container</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="iconDense" variant="ghost" disabled={pending} onClick={() => handleDockerAction(container, 'restart')} aria-label={`Restart ${container.name}`}>
                                {dockerActionPending === `restart-${container.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Restart container</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                      {stats && (
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                          <span className="text-muted-foreground">CPU <span className="font-mono text-foreground">{stats.cpuPercent}%</span></span>
                          <span className="text-muted-foreground">RAM <span className="font-mono text-foreground">{formatBytes(stats.memoryUsed)} ({stats.memoryPercent}%)</span></span>
                          <span className="text-muted-foreground">Net <span className="font-mono text-foreground">{formatBytes(stats.networkRx)} in</span></span>
                          <span className="text-muted-foreground">Disk <span className="font-mono text-foreground">{formatBytes(stats.diskWrite)} write</span></span>
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* Network & Config Grid */}
                <div className={`grid ${server.isRemote ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3'} gap-2`}>
                  <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
                    <div className="grid place-items-center w-7 h-7 rounded-md border border-primary/25 bg-primary/[0.06] text-primary shrink-0" aria-hidden="true">
                      <Network className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">RCON</p>
                      <p className="font-mono text-xs text-foreground/90 truncate tabular-nums">{server.rconHost}:{server.rconPort}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
                    <div className="grid place-items-center w-7 h-7 rounded-md border border-primary/25 bg-primary/[0.06] text-primary shrink-0" aria-hidden="true">
                      <Globe className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Game Port</p>
                      <p className="font-mono text-xs text-foreground/90 tabular-nums">{server.serverPort}</p>
                    </div>
                  </div>
                  {!server.isRemote && (
                    <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
                      <div className="grid place-items-center w-7 h-7 rounded-md border border-border/55 bg-muted/40 text-muted-foreground shrink-0" aria-hidden="true">
                        <Cpu className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Memory</p>
                        <p className="font-mono text-xs text-foreground/90 tabular-nums">{server.minMemory}–{server.maxMemory} GB</p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Branch & Build Info (if update info available for active server) */}
                {server.isActive && (updateInfo || gameVersion) && (
                  <div className="p-2.5 rounded-md bg-muted/50 border border-border/50">
                    <div className="flex items-center justify-between flex-wrap gap-y-1">
                      <div className="flex items-center gap-2">
                        {gameVersion && (
                          <Badge variant="outline" className="text-xs font-mono">v{gameVersion}</Badge>
                        )}
                        {updateInfo && (
                          <>
                            <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
                            <Badge variant="secondary" className="text-xs font-mono">{updateInfo.installed.branch}</Badge>
                          </>
                        )}
                      </div>
                      {updateInfo && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground">Build:</span>
                          <span className="font-mono font-medium">{updateInfo.installed.buildId}</span>
                          {updateInfo.updateAvailable && (
                            <>
                              <ArrowRight className="w-3 h-3 text-warning" />
                              <span className="font-mono font-semibold text-warning">{updateInfo.latest.buildId}</span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Server branch badge for non-active */}
                {!server.isActive && server.branch && (
                  <div className="flex items-center gap-2">
                    <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Branch:</span>
                    <Badge variant="secondary" className="text-xs font-mono">{server.branch}</Badge>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex flex-wrap gap-2 pt-1">
                  {(() => {
                    const status = serverStatuses[String(server.id)]
                    const isRunning = status?.running ?? false
                    const startPending = serverActionPending === `start-${server.id}`
                    const stopPending = serverActionPending === `stop-${server.id}`
                    const hasManagedContainer = dockerAvailable && server.dockerContainerName && dockerContainers.some((item) => item.name === server.dockerContainerName || item.id === server.dockerContainerName)
                    if (server.isRemote || hasManagedContainer) return null
                    return isRunning ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleInlineStop(server)}
                        disabled={stopPending || serverActionPending !== null}
                        title="Stop this server"
                      >
                        {stopPending ? (
                          <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Stopping...</>
                        ) : (
                          <><Square className="w-4 h-4 mr-1.5" /> Stop</>
                        )}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleInlineStart(server)}
                        disabled={startPending || serverActionPending !== null}
                        title={server.isActive ? 'Start this server' : 'Switch to this server and start it'}
                      >
                        {startPending ? (
                          <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Starting...</>
                        ) : (
                          <><Play className="w-4 h-4 mr-1.5" /> Start</>
                        )}
                      </Button>
                    )
                  })()}
                  {server.isRemote && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleConfigureRemoteBridge(server)}
                      title="Configure the SFTP bridge for this remote server"
                    >
                      <Link className="w-4 h-4 mr-1.5" /> Configure SFTP Bridge
                    </Button>
                  )}
                  {hasUpdate && (
                    <Button
                      size="sm"
                      variant="warning"
                      onClick={() => openSteamOperation(server, 'update')}
                    >
                      <RefreshCw className="w-4 h-4 mr-1.5" /> Update Now
                    </Button>
                  )}
                  {!server.isActive && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => handleActivateServer(server)}
                      disabled={activating === server.id}
                    >
                      {activating === server.id ? (
                        <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Activating...</>
                      ) : (
                        <><Power className="w-4 h-4 mr-1.5" /> Switch to This Server</>
                      )}
                    </Button>
                  )}
                </div>

                {/* Created date */}
                {server.createdAt && (
                  <p className="text-[11px] text-muted-foreground/60 pt-1">
                    Added {new Date(server.createdAt).toLocaleDateString()}
                  </p>
                )}
              </CardContent>
            </Card>
          )})}
        </div>
      )}

      {/* Add Existing Server Dialog */}
      <Dialog open={showAddDialog} onOpenChange={(open) => !open && resetAddDialog()}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{addMode === 'remote' ? 'Add Remote Server' : 'Add Existing Server'}</DialogTitle>
            <DialogDescription>
              {addMode === 'remote'
                ? 'Connect to a PZ server on another machine via RCON. Only RCON-based features will be available.'
                : 'Scan a folder to auto-detect server paths, or enter them manually'}
            </DialogDescription>
          </DialogHeader>

          {addMode === 'local' && servers.some(s => !s.isRemote) && (
            <div className="space-y-1.5 rounded-md border border-border/60 p-3">
              <p className="text-xs font-medium">Running a second server alongside the first</p>
              <ul className="space-y-1">
                {[
                  ['Install folder', 'its own — SteamCMD and Workshop downloads overwrite a shared one'],
                  ['Zomboid data folder', 'its own — saves, config and DB live here'],
                  ['Config name', 'unique, it names the .ini'],
                  ['Game port', 'PZ takes the port and the next one, so step by 2'],
                  ['RCON port', 'unique'],
                  ['SteamCMD itself', 'safe to share'],
                ].map(([k, v]) => (
                  <li key={k} className="grid grid-cols-[9rem_1fr] gap-2 text-xs">
                    <span className="text-muted-foreground">{k}</span>
                    <span>{v}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Mode Selector */}
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => { setAddMode('local'); setNewServer(defaultNewServer); setDetectResult(null); setDetectError(null); setSelectedServerConfig('') }}
              className={`flex items-center gap-3 p-3 rounded-lg border-2 transition-[background-color,border-color,color] ${
                addMode === 'local'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-muted-foreground/30'
              }`}
            >
              <Monitor className={`w-5 h-5 ${addMode === 'local' ? 'text-primary' : 'text-muted-foreground'}`} />
              <div className="text-left">
                <p className="text-sm font-medium">Local Server</p>
                <p className="text-xs text-muted-foreground">Same machine as panel</p>
              </div>
            </button>
            <button
              onClick={() => { setAddMode('remote'); setNewServer({ ...defaultNewServer, isRemote: true, rconHost: '' }); setDetectResult(null); setDetectError(null); setSelectedServerConfig('') }}
              className={`flex items-center gap-3 p-3 rounded-lg border-2 transition-[background-color,border-color,color] ${
                addMode === 'remote'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-muted-foreground/30'
              }`}
            >
              <Globe className={`w-5 h-5 ${addMode === 'remote' ? 'text-primary' : 'text-muted-foreground'}`} />
              <div className="text-left">
                <p className="text-sm font-medium">Remote Server</p>
                <p className="text-xs text-muted-foreground">RCON only — another machine</p>
              </div>
            </button>
          </div>

          {/* Remote Server Info Banner */}
          {addMode === 'remote' && (
            <Alert className="border-primary/20 bg-primary/5">
              <Wifi className="h-4 w-4 text-primary" />
              <AlertTitle>RCON-Only Connection</AlertTitle>
              <AlertDescription>
                Features like config editing, mod management, backups, server start/stop, and file operations will be unavailable. You can still use the console, manage players, send chat messages, control weather and events, and run scheduled commands.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-4 py-2">
            {addMode === 'remote' ? (
              /* ========== REMOTE SERVER FORM ========== */
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Server Display Name *</Label>
                  <Input
                    value={newServer.name}
                    onChange={e => setNewServer({ ...newServer, name: e.target.value })}
                    placeholder="My Remote PZ Server"
                    maxLength={64}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>RCON Host / IP *</Label>
                    <Input
                      value={newServer.rconHost}
                      onChange={e => setNewServer({ ...newServer, rconHost: e.target.value })}
                      placeholder="192.168.1.100 or myserver.com"
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">The IP address or hostname of the remote PZ server</p>
                  </div>
                  <div className="space-y-2">
                    <Label>RCON Port *</Label>
                    <Input
                      type="number"
                      value={newServer.rconPort}
                      onChange={e => setNewServer({ ...newServer, rconPort: parseInt(e.target.value) || 27015 })}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>RCON Password *</Label>
                  <PasswordInput
                    value={newServer.rconPassword}
                    onChange={value => setNewServer({ ...newServer, rconPassword: value })}
                    placeholder="Enter the RCON password set in the server's INI file"
                    label="RCON password"
                  />
                  <RconTestConnection
                    host={newServer.rconHost}
                    port={newServer.rconPort}
                    password={newServer.rconPassword}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Game Port (optional)</Label>
                  <Input
                    type="number"
                    value={newServer.serverPort}
                    onChange={e => setNewServer({ ...newServer, serverPort: parseInt(e.target.value) || 16261 })}
                  />
                  <p className="text-xs text-muted-foreground">The PZ game port — used for display purposes only</p>
                </div>
              </div>
            ) : (
              /* ========== LOCAL SERVER FORM ========== */
              <>
            {/* Auto Scan Section */}
            <div className="p-4 rounded-lg bg-muted/50 border space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">Auto Detect Servers</p>
                  <p className="text-xs text-muted-foreground">Scan a folder to find all PZ servers automatically</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAutoScan(!showAutoScan)}
                >
                  {showAutoScan ? 'Manual Entry' : 'Auto Scan'}
                </Button>
              </div>

              {showAutoScan && (
                <div className="space-y-3 pt-2">
                  <div className="flex gap-2">
                    <Input
                      value={autoScanPath}
                      onChange={e => setAutoScanPath(e.target.value)}
                      placeholder="Path to scan for PZ servers"
                      className="font-mono text-sm flex-1"
                    />
                    <Button
                      onClick={handleAutoScan}
                      disabled={autoScanning || !autoScanPath.trim()}
                    >
                      {autoScanning ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <><Search className="w-4 h-4 mr-1" /> Scan</>
                      )}
                    </Button>
                  </div>

                  {/* Auto Scan Results */}
                  {autoScanResult && autoScanResult.detectedConfigs.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Found {autoScanResult.detectedConfigs.length} server(s). Click to select:
                      </p>
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {autoScanResult.detectedConfigs.map((config, idx) => (
                          <div
                            key={config.serverName || idx}
                            className="p-3 rounded border bg-background hover:bg-accent cursor-pointer transition-colors"
                            onClick={() => handleSelectScannedConfig(config, autoScanResult.installPaths[0])}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-medium">{config.publicName || config.serverName}</span>
                              <Badge variant="secondary" className="text-xs font-mono">
                                {config.serverName}.ini
                              </Badge>
                            </div>
                            <div className="text-xs text-muted-foreground mt-1 font-mono truncate">
                              📁 Data: {config.dataPath}
                            </div>
                            {config.matchedBatFile ? (
                              <div className="mt-1 text-xs font-mono text-primary truncate">
                                ✓ Matched: {config.matchedBatFile}
                              </div>
                            ) : autoScanResult.installPaths.length > 0 ? (
                              <div className="mt-1 text-xs text-warning">
                                ⚠ No matching startup script - will use default install path
                              </div>
                            ) : (
                              <div className="mt-1 text-xs text-warning">
                                ⚠ No install path found - enter manually below
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Show available paths summary */}
                      <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
                        {autoScanResult.installPaths.length > 0 && (
                          <p>📁 Install paths found: {autoScanResult.installPaths.length}</p>
                        )}
                        {autoScanResult.customBatFiles && autoScanResult.customBatFiles.length > 0 && (
                          <p>🎯 Custom startup scripts: {autoScanResult.customBatFiles.map(b => b.fileName).join(', ')}</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Manual Entry Section */}
            {!showAutoScan && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Server Data Path *</Label>
                <div className="flex gap-2">
                  <Input
                    value={newServer.zomboidDataPath}
                    onChange={e => {
                      setNewServer({ ...newServer, zomboidDataPath: e.target.value })
                      setDetectResult(null)
                      setDetectError(null)
                    }}
                    placeholder="Path to Zomboid data folder"
                    className="font-mono text-sm flex-1"
                    maxLength={260}
                  />
                  <Button
                    variant="secondary"
                    onClick={handleDetectServer}
                    disabled={detecting || !newServer.zomboidDataPath.trim()}
                  >
                    {detecting ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <><Search className="w-4 h-4 mr-1" /> Detect</>
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  The folder containing Server/, Saves/, Logs/ subfolders
                </p>
              </div>

              <div className="space-y-2">
                <Label>Server Install Path (Optional)</Label>
                <Input
                  value={newServer.installPath}
                  onChange={e => setNewServer({ ...newServer, installPath: e.target.value })}
                  placeholder="Path to PZ server folder (contains StartServer64.bat or start-server.sh)"
                  className="font-mono text-sm"
                  maxLength={260}
                />
              </div>
            </div>
            )}

            {/* Detection Error */}
            {detectError && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive">
                <AlertCircle className="w-4 h-4" />
                <span className="text-sm">{detectError}</span>
              </div>
            )}

            {/* Detection Result */}
            {detectResult && (
              <div className="space-y-4">
                {detectResult.detectedServers.length === 0 ? (
                  <Alert className="border-warning/40 bg-warning/10">
                    <AlertCircle className="h-4 w-4 text-warning" />
                    <AlertTitle className="text-warning">No server configs found</AlertTitle>
                    <AlertDescription>Run the server once to create the INI file.</AlertDescription>
                  </Alert>
                ) : (
                  <>
                    {/* Server Selection (if multiple) */}
                    {detectResult.detectedServers.length > 1 && (
                      <div className="space-y-2">
                        <Label>Select Server Configuration</Label>
                        <Select
                          value={selectedServerConfig}
                          onValueChange={(val) => {
                            const config = detectResult.detectedServers.find(s => s.serverName === val)
                            if (config) handleSelectServerConfig(config)
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Choose a server..." />
                          </SelectTrigger>
                          <SelectContent>
                            {detectResult.detectedServers.map(s => (
                              <SelectItem key={s.serverName} value={s.serverName}>
                                {s.publicName || s.serverName} ({s.serverName}.ini)
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* Detected Settings Summary */}
                    {selectedServerConfig && (
                      <div className="space-y-3 rounded-lg border bg-muted/50 p-4">
                        <div className="mb-3 flex items-center gap-2 text-primary">
                          <CheckCircle className="w-4 h-4" />
                          <span className="font-medium">Server detected successfully!</span>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                          <div>
                            <span className="text-muted-foreground">Server Name:</span>
                            <p className="font-medium">{newServer.name}</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Config File:</span>
                            <p className="font-mono">{newServer.serverName}.ini</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Game Port:</span>
                            <p className="font-mono">{newServer.serverPort}</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">RCON Port:</span>
                            <p className="font-mono">{newServer.rconPort}</p>
                          </div>
                        </div>

                        {tandemConflicts.length > 0 && (
                          <div className="space-y-1.5 rounded-md border border-destructive/50 bg-destructive/5 p-3">
                            <p className="text-xs font-medium text-destructive">
                              Clashes with a server already added — both cannot run at once
                            </p>
                            <ul className="space-y-1">
                              {tandemConflicts.map((c: { label: string; detail: string }, i: number) => (
                                <li key={`${c.label}-${i}`} className="grid grid-cols-[7rem_1fr] gap-2 text-xs">
                                  <span className="text-muted-foreground">{c.label}</span>
                                  <span>{c.detail}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* RCON Password Section */}
                        <div className="space-y-2 mt-2">
                          <Label>RCON Password *</Label>
                          <PasswordInput
                            placeholder="Enter RCON password"
                            value={newServer.rconPassword}
                            className="bg-background"
                            onChange={value => setNewServer({ ...newServer, rconPassword: value })}
                            label="RCON password"
                          />
                          {!newServer.rconPassword ? (
                            <p className="text-xs text-warning">
                              Required for server control. You can also set <code className="rounded bg-warning/20 px-1">RCONPassword=yourpassword</code> in your {newServer.serverName}.ini file.
                            </p>
                          ) : (
                            <p className="flex items-center gap-1 text-xs text-primary">
                              <CheckCircle className="w-3 h-3" /> Password set
                            </p>
                          )}
                          <RconTestConnection
                            host={newServer.rconHost || '127.0.0.1'}
                            port={newServer.rconPort}
                            password={newServer.rconPassword}
                          />
                        </div>

                        {/* Memory Configuration */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                          <div className="space-y-2">
                            <Label>Min Memory (GB)</Label>
                            <Input
                              type="number"
                              min={1}
                              max={64}
                              value={newServer.minMemory}
                              className="bg-background"
                              onChange={e => setNewServer({ ...newServer, minMemory: Math.max(1, parseInt(e.target.value) || 2) })}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Max Memory (GB)</Label>
                            <Input
                              type="number"
                              min={1}
                              max={64}
                              value={newServer.maxMemory}
                              className="bg-background"
                              onChange={e => setNewServer({ ...newServer, maxMemory: Math.max(1, parseInt(e.target.value) || 4) })}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={resetAddDialog}>
              Cancel
            </Button>
            <Button
              onClick={handleAddExistingServer}
              disabled={addingServer || (addMode === 'local' ? (!selectedServerConfig || !newServer.rconPassword) : (!newServer.name || !newServer.rconHost || !newServer.rconPassword))}
            >
              {addingServer ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Adding...</>
              ) : (
                <><Plus className="w-4 h-4 mr-2" /> Add Server</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editingServer} onOpenChange={() => setEditingServer(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Server</DialogTitle>
            <DialogDescription>
              Update server configuration settings
            </DialogDescription>
          </DialogHeader>

          {editingServer && (
            <div className="space-y-4">
              {/* Remote server indicator */}
              {editingServer.isRemote && (
                <Alert className="border-primary/20 bg-primary/5">
                  <Globe className="h-4 w-4 text-primary" />
                  <AlertTitle>Remote Server</AlertTitle>
                  <AlertDescription>RCON-only management is available for this server.</AlertDescription>
                </Alert>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Display Name</Label>
                  <Input
                    value={editingServer.name}
                    onChange={e => setEditingServer({ ...editingServer, name: e.target.value })}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Server Name</Label>
                  <Input
                    value={editingServer.serverName}
                    onChange={e => setEditingServer({ ...editingServer, serverName: e.target.value })}
                    maxLength={64}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Managed Docker Container</Label>
                  <Input
                    value={editingServer.dockerContainerName || ''}
                    onChange={e => setEditingServer({ ...editingServer, dockerContainerName: e.target.value || null })}
                    placeholder="Optional explicit container name"
                    maxLength={128}
                  />
                  <p className="text-xs text-muted-foreground">Requires PANEL_DOCKER_CONTROL_ENABLED and the container label zomboid-panel.managed=true.</p>
                </div>
              </div>

              {!editingServer.isRemote && (
              <>
              <div className="space-y-2">
                <Label>Install Path</Label>
                <Input
                  value={editingServer.installPath}
                  onChange={e => setEditingServer({ ...editingServer, installPath: e.target.value })}
                  className="font-mono text-sm"
                />
              </div>

              <div className="space-y-2">
                <Label>Zomboid Data Path</Label>
                <Input
                  value={editingServer.zomboidDataPath || ''}
                  onChange={e => setEditingServer({ ...editingServer, zomboidDataPath: e.target.value })}
                  className="font-mono text-sm"
                  placeholder="Leave empty for default"
                />
              </div>

              <div className="space-y-2">
                <Label className="flex items-center gap-1.5">
                  Custom Start Command
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[280px]">
                      <p className="text-xs">Override the default startup script with a custom command. Supports arguments. Leave empty to use the default bat/sh file detection.</p>
                    </TooltipContent>
                  </Tooltip>
                </Label>
                <Input
                  value={editingServer.startCommand || ''}
                  onChange={e => setEditingServer({ ...editingServer, startCommand: e.target.value })}
                  className="font-mono text-sm"
                  placeholder="e.g. ./start-server.sh -servername MyServer"
                  maxLength={1024}
                />
                {editingServer.startCommand && /[&|;<>`${}()!\[\]]/.test(editingServer.startCommand) && (
                  <p className="text-xs text-destructive">Command contains disallowed shell characters</p>
                )}
              </div>
              </>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    RCON Host
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[200px]">
                        <p className="text-xs">Leave as 127.0.0.1 if the panel runs on the same machine as the game server</p>
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <Input
                    value={editingServer.rconHost}
                    onChange={e => setEditingServer({ ...editingServer, rconHost: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>RCON Port</Label>
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={editingServer.rconPort}
                    onChange={e => {
                      const val = parseInt(e.target.value)
                      if (!isNaN(val)) setEditingServer({ ...editingServer, rconPort: Math.min(65535, Math.max(1, val)) })
                    }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>RCON Password</Label>
                  <PasswordInput
                    value={editingServer.rconPassword}
                    onChange={value => setEditingServer({ ...editingServer, rconPassword: value })}
                    label="RCON password"
                  />
                  <RconTestConnection
                    host={editingServer.rconHost}
                    port={editingServer.rconPort}
                    password={editingServer.rconPassword}
                  />
                </div>
                {!editingServer.isRemote && (
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    Admin Password
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[240px]">
                        <p className="text-xs">Server admin password passed as -adminpassword launch argument. Takes effect on next server start.</p>
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <PasswordInput
                    value={editingServer.adminPassword || ''}
                    onChange={value => setEditingServer({ ...editingServer, adminPassword: value })}
                    placeholder="Set admin password"
                    label="admin password"
                  />
                </div>
                )}
              </div>

              <div className={editingServer.isRemote ? "grid grid-cols-1 gap-4" : "grid grid-cols-1 sm:grid-cols-3 gap-4"}>
                <div className="space-y-2">
                  <Label>Game Port</Label>
                  <Input
                    type="number"
                    value={editingServer.serverPort}
                    onChange={e => setEditingServer({ ...editingServer, serverPort: parseInt(e.target.value) || 16261 })}
                  />
                </div>
                {!editingServer.isRemote && (
                <>
                <div className="space-y-2">
                  <Label>Min Memory (GB)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={64}
                    value={editingServer.minMemory}
                    onChange={e => setEditingServer({ ...editingServer, minMemory: Math.max(1, parseInt(e.target.value) || 2) })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Max Memory (GB)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={64}
                    value={editingServer.maxMemory}
                    onChange={e => setEditingServer({ ...editingServer, maxMemory: Math.max(1, parseInt(e.target.value) || 4) })}
                  />
                </div>
                </>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingServer(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={savingEdit}>
              <Check className="w-4 h-4 mr-2" /> {savingEdit ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteServer} onOpenChange={(open) => { if (!open && !deleting) { setDeleteServer(null); setDeleteFiles(false); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Server from Panel?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4">
                <p>This will remove "{deleteServer?.name}" from the panel management.</p>

                {deleteServer?.installPath && (
                  <div className="flex items-start gap-3 p-3 rounded-lg border bg-muted/50">
                    <Checkbox
                      id="deleteFiles"
                      checked={deleteFiles}
                      onCheckedChange={(checked) => setDeleteFiles(checked === true)}
                      disabled={deleting}
                      className="mt-1"
                    />
                    <label htmlFor="deleteFiles" className="text-sm cursor-pointer">
                      <span className="font-medium text-destructive">Also delete server files</span>
                      <p className="text-muted-foreground mt-1">
                        This will permanently delete all files in:<br />
                        <code className="text-xs bg-background px-1 rounded">{deleteServer?.installPath}</code>
                      </p>
                    </label>
                  </div>
                )}

                {!deleteFiles && !deleting && (
                  <p className="text-sm text-muted-foreground">
                    Server files will NOT be deleted - you can add this server back later.
                  </p>
                )}

                {deleting && (
                  <div className="space-y-2 pt-1">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>{deleteFiles ? 'Deleting server files...' : 'Removing server...'}</span>
                    </div>
                    <Progress value={deleteProgress} className="h-1.5" />
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <Button
              onClick={handleDeleteServer}
              disabled={deleting}
              className={deleteFiles ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
            >
              {deleting ? (
                <><Loader2 className="w-4 h-4 animate-spin mr-2" />Removing...</>
              ) : deleteFiles ? 'Delete Everything' : 'Remove from Panel'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Steam Update/Verify Dialog */}
      <Dialog open={!!steamOperation} onOpenChange={(open) => !open && !steamRunning && setSteamOperation(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {steamOperation?.type === 'verify' ? (
                <><ShieldCheck className="w-5 h-5" /> Verify Game Files</>
              ) : (
                <><RefreshCw className="w-5 h-5" /> Update Server</>
              )}
            </DialogTitle>
            <DialogDescription>
              {steamOperation?.type === 'verify'
                ? 'Check and repair game files using SteamCMD'
                : 'Download the latest version using SteamCMD'
              }
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>SteamCMD Path *</Label>
              <Input
                value={steamcmdPath}
                onChange={e => setSteamcmdPath(e.target.value)}
                placeholder="Path to SteamCMD folder"
                className="font-mono text-sm"
                disabled={steamRunning}
              />
              <p className="text-xs text-muted-foreground">
                Folder containing steamcmd
              </p>
            </div>

            <div className="space-y-2">
              <Label>Server Install Path</Label>
              <Input
                value={getInstallFolder(steamOperation?.server.installPath)}
                disabled
                className="font-mono text-sm bg-muted"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={steamRunning || clearingInstall}
                onClick={() => setConfirmClearInstall(true)}
              >
                <Trash2 className="w-3.5 h-3.5 mr-2" /> Clear Installation Folder
              </Button>
              <p className="text-xs text-muted-foreground">
                Deletes everything in the install path so you can reinstall from
                scratch. Use this if SteamCMD updates keep failing (stuck or
                corrupted download state) instead of fixing it manually.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Steam Branch {loadingBranches && <Loader2 className="inline-block w-3 h-3 ml-1 animate-spin" />}</Label>
              <Select
                value={steamOperation?.branch || 'public'}
                onValueChange={(value) => steamOperation && setSteamOperation({ ...steamOperation, branch: value })}
                disabled={steamRunning || loadingBranches}
              >
                <SelectTrigger className="w-full text-foreground">
                  {(() => {
                    const current = availableBranches.find(b => b.name === steamOperation?.branch)
                    if (loadingBranches) return <span className="text-muted-foreground">Loading branches...</span>
                    if (!current) return <span className="text-muted-foreground">Select branch</span>
                    return (
                      <span className="flex items-center gap-2">
                        <span className="capitalize">{current.name === 'public' ? 'Public (Stable)' : current.name}</span>
                        {(() => {
                          const sb = (steamOperation?.server.branch || '').trim().toLowerCase()
                          const ib = (updateInfo?.installed?.branch || '').trim().toLowerCase()
                          const isCurrent = current.name === ib || current.name === sb
                          return isCurrent ? (
                            <span className="rounded border border-border/60 px-1 py-px font-mono text-[10px] uppercase tracking-wider text-muted-foreground">current</span>
                          ) : null
                        })()}
                      </span>
                    )
                  })()}
                </SelectTrigger>
                <SelectContent>
                  {availableBranches.map((b) => (
                    <SelectItem key={b.name} value={b.name}>
                      <div className="flex flex-col">
                        <span className="capitalize">{b.name === 'public' ? 'Public (Stable)' : b.name}</span>
                        {b.description && <span className="text-xs text-muted-foreground">{b.description}</span>}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {(() => {
                  const selected = availableBranches.find(b => b.name === steamOperation?.branch)
                  if (!selected) return 'Select the Steam branch to download from'
                  const details = [selected.description]
                  if (selected.buildId) details.push(`Build ${selected.buildId}`)
                  if (selected.timeUpdated) details.push(`Updated ${new Date(selected.timeUpdated).toLocaleString()}`)
                  return details.join(' - ')
                })()}
              </p>
            </div>

            {steamLogs.length > 0 && (
              <div className="space-y-2">
                <Label>Progress</Label>
                <div className="h-48 overflow-y-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs text-foreground">
                  {steamLogs.map((log, i) => (
                    <div key={i}>{log}</div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSteamOperation(null)}
              disabled={steamRunning}
            >
              {steamRunning ? 'Running...' : steamCompleted ? 'Close' : 'Cancel'}
            </Button>
            {!steamCompleted && (
              <Button
                onClick={handleStartSteamOperation}
                disabled={steamRunning || !steamcmdPath.trim()}
              >
                {steamRunning ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Running...</>
                ) : steamOperation?.type === 'verify' ? (
                  <><ShieldCheck className="w-4 h-4 mr-2" /> Start Verify</>
                ) : (
                  <><RefreshCw className="w-4 h-4 mr-2" /> Start Update</>
                )}
              </Button>
            )}
            {steamCompleted === 'success' && (
              <Button
                variant="default"
                onClick={() => setSteamOperation(null)}
              >
                <CheckCircle2 className="w-4 h-4 mr-2" /> Done
              </Button>
            )}
            {steamCompleted === 'error' && (
              <Button
                onClick={() => { setSteamCompleted(null); handleStartSteamOperation(); }}
                disabled={!steamcmdPath.trim()}
              >
                <RefreshCw className="w-4 h-4 mr-2" /> Retry
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear Installation Folder confirmation */}
      <AlertDialog open={confirmClearInstall} onOpenChange={(open) => !open && !clearingInstall && setConfirmClearInstall(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear Installation Folder?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes everything in{' '}
              <code className="text-xs bg-background px-1 rounded">
                {getInstallFolder(steamOperation?.server.installPath)}
              </code>
              {' '}— including the game files, SteamCMD's download state, and any
              mods installed there. Use this to recover from a SteamCMD update
              that keeps failing (corrupted or stuck installation). You'll need
              to run Start Update again afterward to reinstall from scratch.
              This does not affect your save data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearingInstall}>Cancel</AlertDialogCancel>
            <Button
              onClick={handleClearInstallFolder}
              disabled={clearingInstall}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {clearingInstall ? (
                <><Loader2 className="w-4 h-4 animate-spin mr-2" />Clearing...</>
              ) : (
                <><Trash2 className="w-4 h-4 mr-2" />Clear Folder</>
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Discovery Setup — "Connect" from the mount discovery banner */}
      <DiscoverySetup
        open={!!discoverySetupMount}
        onOpenChange={(open) => !open && setDiscoverySetupMount(null)}
        mount={discoverySetupMount}
        onCreated={() => { fetchServers(); fetchServerStatuses() }}
      />
    </div>
  )
}
