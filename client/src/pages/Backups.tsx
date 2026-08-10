import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Archive,
  Download,
  Trash2,
  RotateCcw,
  Loader2,
  Clock,
  HardDrive,
  FolderOpen,
  RefreshCw,
  Settings,
  AlertTriangle,
  Check,
  Upload,
  FileText,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
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
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/contexts/SocketContext'
import { backupApi, serversApi, BackupStatus, BackupFile, BackupHistoryRecord, BackupSnapshot } from '@/lib/api'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

interface BackupProgress {
  phase: 'preparing' | 'archiving' | 'finalizing' | 'complete' | 'error'
  percent: number
  message: string
  filesProcessed?: number
  totalFiles?: number
  currentFile?: string
}

export default function Backups() {
  const { toast } = useToast()
  const socket = useSocket()

  // Refs for cleanup
  const progressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // State
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
  const [backups, setBackups] = useState<BackupFile[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creatingBackup, setCreatingBackup] = useState(false)
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null)
  const [deletingBackups, setDeletingBackups] = useState(false)
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null)
  const [uploadingBackup, setUploadingBackup] = useState(false)
  const [uploadPercent, setUploadPercent] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Active server context — backups don't apply to remote servers because
  // the panel can't reach the remote filesystem. We fetch this on mount
  // and refresh when the server-changed socket event fires (handled via
  // socket effect below) so the banner / button-disable stays accurate.
  const [activeServerRemote, setActiveServerRemote] = useState(false)
  const [activeServerId, setActiveServerId] = useState<string | number | null>(null)
  const [history, setHistory] = useState<BackupHistoryRecord[]>([])

  // Selection state
  const [selectedBackups, setSelectedBackups] = useState<Set<string>>(new Set())

  // Settings state
  const [showSettings, setShowSettings] = useState(false)
  const [backupSchedule, setBackupSchedule] = useState('0 */6 * * *')
  const [backupMaxCount, setBackupMaxCount] = useState(10)
  const [savingSettings, setSavingSettings] = useState(false)

  // Dialog state
  const [restoreDialog, setRestoreDialog] = useState<{ open: boolean; backupName: string | null }>({
    open: false,
    backupName: null,
  })
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; names: string[] }>({
    open: false,
    names: [],
  })
  const [deleteOlderDialog, setDeleteOlderDialog] = useState(false)
  const [deleteOlderDays, setDeleteOlderDays] = useState(7)
  const [deletingOlder, setDeletingOlder] = useState(false)
  const [snapshotDialog, setSnapshotDialog] = useState<{ name: string; snapshot: BackupSnapshot } | null>(null)

  // Fetch functions
  const fetchBackupStatus = useCallback(async () => {
    try {
      const status = await backupApi.getStatus()
      setBackupStatus(status)
      setBackupSchedule(status.schedule)
      setBackupMaxCount(status.maxBackups)
      setLoadError(null)
    } catch {
      setLoadError('Failed to load backup status.')
    }
  }, [])

  const fetchBackups = useCallback(async () => {
    try {
      const data = await backupApi.listBackups()
      setBackups(data.backups || [])
      setLoadError(null)
      // Clear selection for backups that no longer exist
      setSelectedBackups(prev => {
        const backupNames = new Set((data.backups || []).map(b => b.name))
        const newSelection = new Set<string>()
        prev.forEach(name => {
          if (backupNames.has(name)) {
            newSelection.add(name)
          }
        })
        return newSelection
      })
    } catch {
      setLoadError('Failed to load backups.')
    }
  }, [])

  const fetchHistory = useCallback(async (serverId: string | number | null) => {
    if (serverId == null) {
      setHistory([])
      return
    }
    try {
      const data = await backupApi.getHistory(serverId)
      setHistory(data.records || [])
    } catch {
      setHistory([])
    }
  }, [])

  const refreshAll = useCallback(async () => {
    setLoading(true)
    try {
      const active = await serversApi.getResolvedActive().catch(() => ({ server: null }))
      setActiveServerRemote(!!active.server?.isRemote)
      setActiveServerId(active.server?.id ?? null)
      await Promise.all([
        fetchBackupStatus(),
        fetchBackups(),
        fetchHistory(active.server?.id ?? null),
      ])
    } finally {
      setLoading(false)
    }
  }, [fetchBackupStatus, fetchBackups, fetchHistory])

  // Initial load
  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  // Socket.IO for progress updates
  useEffect(() => {
    if (!socket) return

    const handleBackupProgress = (data: BackupProgress) => {
      setBackupProgress(data)
      
      // Clear any existing timeout
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
        progressTimeoutRef.current = null
      }
      
      if (data.phase === 'complete') {
        setCreatingBackup(false)
        fetchBackups()
        fetchBackupStatus()
        progressTimeoutRef.current = setTimeout(() => setBackupProgress(null), 2000)
      } else if (data.phase === 'error') {
        setCreatingBackup(false)
        progressTimeoutRef.current = setTimeout(() => setBackupProgress(null), 3000)
      }
    }

    socket.on('backup:progress', handleBackupProgress)

    return () => {
      socket.off('backup:progress', handleBackupProgress)
      // Clear timeout on unmount
      if (progressTimeoutRef.current) {
        clearTimeout(progressTimeoutRef.current)
      }
    }
  }, [socket, fetchBackups, fetchBackupStatus])

  // Actions
  const handleCreateBackup = async () => {
    setCreatingBackup(true)
    setBackupProgress({ phase: 'preparing', percent: 0, message: 'Starting backup...' })
    try {
      const result = await backupApi.createBackup()
      if (result.success && result.backup) {
        toast({
          title: 'Safehouse Snapshot Created',
          description: `Stored ${result.backup.name} in ${result.duration?.toFixed(1)}s`,
          variant: 'success' as const,
        })
        await fetchBackups()
        await fetchBackupStatus()
      } else {
        throw new Error(result.message || 'Failed to create backup')
      }
    } catch (error) {
      toast({
        title: 'Backup Failed',
        description: error instanceof Error ? error.message : 'Failed to create backup',
        variant: 'destructive',
      })
      setBackupProgress({ phase: 'error', percent: 0, message: 'Backup failed' })
    } finally {
      setCreatingBackup(false)
    }
  }

  // Upload an existing .zip from the user's machine into the backups folder.
  // The file gets stored with an "uploaded-" prefix and shows up in the list
  // alongside scheduled backups; the user then clicks Restore to apply it.
  const handleUploadFile = async (file: File) => {
    if (!file) return
    if (activeServerRemote) {
      toast({ title: 'Not available for remote servers', description: 'Backup uploads write to the local filesystem and aren’t supported for remote servers.', variant: 'destructive' })
      return
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast({ title: 'Invalid file', description: 'Only .zip backup archives are accepted.', variant: 'destructive' })
      return
    }
    // Hard cap matches the server-side express.raw limit (4 GB). Anything
    // larger would upload for minutes and then 413 — fail fast instead.
    const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024
    if (file.size > MAX_UPLOAD_BYTES) {
      toast({ title: 'File too large', description: `Backup archives must be 4 GB or smaller. This file is ${(file.size / (1024 * 1024 * 1024)).toFixed(2)} GB.`, variant: 'destructive' })
      return
    }
    if (file.size === 0) {
      toast({ title: 'Empty file', description: 'The selected .zip is empty.', variant: 'destructive' })
      return
    }
    setUploadingBackup(true)
    setUploadPercent(0)
    try {
      const result = await backupApi.uploadBackup(file, setUploadPercent)
      toast({
        title: 'Backup Uploaded',
        description: `Stored as ${result.name}. Use Restore to apply it.`,
        variant: 'success' as const,
      })
      await fetchBackups()
      await fetchBackupStatus()
    } catch (error) {
      toast({
        title: 'Upload Failed',
        description: error instanceof Error ? error.message : 'Failed to upload backup',
        variant: 'destructive',
      })
    } finally {
      setUploadingBackup(false)
      setUploadPercent(0)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleRestoreBackup = async (name: string) => {
    setRestoreDialog({ open: false, backupName: null })
    setRestoringBackup(name)
    try {
      const result = await backupApi.restoreBackup(name, { createPreRestoreBackup: true })
      if (result.success) {
        toast({
          title: 'Recovery Point Restored',
          description: `Rolled back to ${name} in ${(result.duration || 0).toFixed(1)}s`,
          variant: 'success' as const,
        })
        await fetchBackups()
      } else {
        throw new Error(result.message || 'Failed to restore backup')
      }
    } catch (error) {
      toast({
        title: 'Restore Failed',
        description: error instanceof Error ? error.message : 'Failed to restore backup',
        variant: 'destructive',
      })
    } finally {
      setRestoringBackup(null)
    }
  }

  const handleViewSnapshot = async (name: string) => {
    try {
      const result = await backupApi.getSnapshot(name)
      if (!result.success || !result.snapshot) throw new Error(result.message || 'No panel snapshot in this backup')
      setSnapshotDialog({ name, snapshot: result.snapshot })
    } catch (error) {
      toast({
        title: 'Snapshot unavailable',
        description: error instanceof Error ? error.message : 'Could not read backup snapshot',
        variant: 'destructive',
      })
    }
  }

  const handleDeleteBackups = async (names: string[]) => {
    setDeleteDialog({ open: false, names: [] })
    setDeletingBackups(true)
    try {
      let successCount = 0
      let failCount = 0
      for (const name of names) {
        try {
          const result = await backupApi.deleteBackup(name)
          if (result.success) {
            successCount++
          } else {
            failCount++
          }
        } catch {
          failCount++
        }
      }

      if (successCount > 0) {
        toast({
          title: 'Old Snapshots Cleared',
          description: `Removed ${successCount} backup${successCount !== 1 ? 's' : ''}${failCount > 0 ? ` (${failCount} failed)` : ''}`,
          variant: 'success' as const,
        })
      }
      if (failCount > 0 && successCount === 0) {
        toast({
          title: 'Delete Failed',
          description: `Failed to delete ${failCount} backup${failCount !== 1 ? 's' : ''}`,
          variant: 'destructive',
        })
      }

      setSelectedBackups(new Set())
      await fetchBackups()
    } catch (error) {
      toast({
        title: 'Delete Failed',
        description: error instanceof Error ? error.message : 'Failed to delete backups',
        variant: 'destructive',
      })
    } finally {
      setDeletingBackups(false)
    }
  }

  const handleDeleteOlderThan = async () => {
    setDeleteOlderDialog(false)
    setDeletingOlder(true)
    try {
      const result = await backupApi.deleteOlderThan(deleteOlderDays)
      if (result.success) {
        toast({
          title: 'Old Backups Removed',
          description: result.message || `Removed ${result.deleted || 0} aging backups`,
          variant: 'success' as const,
        })
        await fetchBackups()
      } else {
        toast({
          title: 'Delete Failed',
          description: result.message || 'Failed to delete old backups',
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: 'Delete Failed',
        description: error instanceof Error ? error.message : 'Failed to delete old backups',
        variant: 'destructive',
      })
    } finally {
      setDeletingOlder(false)
    }
  }

  const handleSaveSettings = async () => {
    setSavingSettings(true)
    try {
      await backupApi.updateSettings({
        enabled: backupStatus?.enabled || false,
        schedule: backupSchedule,
        maxBackups: backupMaxCount,
      })
      await fetchBackupStatus()
      toast({
        title: 'Backup Plan Updated',
        description: 'The panel saved your current backup schedule and limits.',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Backup Plan Update Failed',
        description: error instanceof Error ? error.message : 'Failed to save settings',
        variant: 'destructive',
      })
    } finally {
      setSavingSettings(false)
    }
  }

  const toggleBackupEnabled = async (enabled: boolean) => {
    try {
      await backupApi.updateSettings({ enabled })
      await fetchBackupStatus()
      toast({
        title: enabled ? 'Automatic Snapshots Armed' : 'Automatic Snapshots Stood Down',
        description: enabled ? 'Recurring backup jobs are now active.' : 'Recurring backup jobs are currently paused.',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Automatic Backup Update Failed',
        description: error instanceof Error ? error.message : 'Failed to update backup settings',
        variant: 'destructive',
      })
    }
  }

  // Selection handlers
  const toggleBackupSelection = (name: string) => {
    setSelectedBackups(prev => {
      const newSet = new Set(prev)
      if (newSet.has(name)) {
        newSet.delete(name)
      } else {
        newSet.add(name)
      }
      return newSet
    })
  }

  const toggleSelectAll = () => {
    if (selectedBackups.size === backups.length) {
      setSelectedBackups(new Set())
    } else {
      setSelectedBackups(new Set(backups.map(b => b.name)))
    }
  }

  // Helpers
  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  }

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr)
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  // Translate the small set of cron presets we expose into a human label.
  // Falls back to the raw cron string for anything custom so the user
  // still gets meaningful information without us shipping a full parser.
  const describeSchedule = (cron: string | undefined): string => {
    if (!cron) return 'No schedule'
    const map: Record<string, string> = {
      '*/15 * * * *': 'every 15 minutes',
      '*/30 * * * *': 'every 30 minutes',
      '0 * * * *': 'every hour',
      '0 */2 * * *': 'every 2 hours',
      '0 */4 * * *': 'every 4 hours',
      '0 */6 * * *': 'every 6 hours',
      '0 */8 * * *': 'every 8 hours',
      '0 */12 * * *': 'every 12 hours',
      '0 0 * * *': 'daily at midnight',
      '0 6 * * *': 'daily at 6 AM',
      '0 12 * * *': 'daily at noon',
      '0 18 * * *': 'daily at 6 PM',
    }
    return map[cron] || cron
  }

  const totalSize = useMemo(() => {
    return backups.reduce((sum, b) => sum + b.size, 0)
  }, [backups])

  const isAnySelected = selectedBackups.size > 0
  const allSelected = backups.length > 0 && selectedBackups.size === backups.length

  return (
    <div className="space-y-6 page-transition">
      {/* Header */}
      <PageHeader
        title="World Backups"
        description="Create, restore, and manage your server world backups"
        icon={<Archive className="w-5 h-5 text-primary" />}
        actions={
          <div className="flex items-center gap-2">
            <Button
              onClick={handleCreateBackup}
              disabled={creatingBackup || restoringBackup !== null || !backupStatus?.savesExists || activeServerRemote}
              className="gap-2"
              title={activeServerRemote ? 'Backups are not available for remote servers' : undefined}
            >
              {creatingBackup ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Archive className="w-4 h-4" />
              )}
              {creatingBackup ? 'Creating...' : 'Create Backup'}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleUploadFile(file)
              }}
            />
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingBackup || restoringBackup !== null || activeServerRemote}
              className="gap-2"
              title={activeServerRemote ? 'Backups are not available for remote servers' : 'Upload an existing world_backup_*.zip from another machine'}
            >
              {uploadingBackup ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              {uploadingBackup ? `Uploading ${uploadPercent}%` : 'Upload .zip'}
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowSettings(!showSettings)}
              className="gap-2"
            >
              <Settings className="w-4 h-4" />
              Settings
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={refreshAll}
              disabled={loading}
              aria-label="Refresh backup status"
              title="Refresh backup status"
            >
              <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            </Button>
          </div>
        }
      />

      {loadError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Backup data unavailable</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={refreshAll} className="self-start sm:self-auto">
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {activeServerRemote && (
        <Alert className="border-warning/40 bg-warning/10">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle>Backups disabled for remote servers</AlertTitle>
          <AlertDescription>
            The active server is configured as remote, so the panel can&apos;t reach its filesystem.
            Create, upload, and restore are unavailable until you switch to a local server.
          </AlertDescription>
        </Alert>
      )}

      {activeServerId != null && history.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-border/50 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">History</span>
          <span>{history.length} recorded backup{history.length === 1 ? '' : 's'}</span>
          <span>Latest: {formatDate(history[0].createdAt)}</span>
          <span className="font-mono">{history[0].fileName}</span>
        </div>
      )}

      {/* Status Cards */}
      {backups.length > 0 && (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 stagger-in">
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="grid place-items-center w-10 h-10 rounded-md border border-primary/30 bg-primary/[0.06] text-primary shrink-0" aria-hidden="true">
              <Archive className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Total Backups</p>
              <p className="text-xl font-semibold leading-tight mt-0.5 text-foreground">{backups.length}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="grid place-items-center w-10 h-10 rounded-md border border-border/55 bg-muted/30 text-muted-foreground shrink-0" aria-hidden="true">
              <HardDrive className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Total Size</p>
              <p className="text-xl font-semibold leading-tight mt-0.5 text-foreground tabular-nums">{formatBytes(totalSize)}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="grid place-items-center w-10 h-10 rounded-md border border-primary/30 bg-primary/[0.06] text-primary shrink-0" aria-hidden="true">
              <Clock className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Last Backup</p>
              <p className="text-sm font-semibold leading-tight mt-0.5 text-foreground truncate">
                {backupStatus?.lastBackup ? formatDate(backupStatus.lastBackup.created) : 'Never'}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div
              className={cn(
                'grid place-items-center w-10 h-10 rounded-md border shrink-0',
                backupStatus?.enabled
                  ? 'border-primary/30 bg-primary/[0.06] text-primary'
                  : 'border-border/55 bg-muted/30 text-muted-foreground'
              )}
              aria-hidden="true"
            >
              <Clock className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Auto-Backup</p>
              <p className={cn('text-sm font-semibold leading-tight mt-0.5 truncate', backupStatus?.enabled ? 'text-foreground' : 'text-muted-foreground')}>
                {backupStatus?.enabled ? 'On' : 'Off'}
              </p>
              <p className="text-[11px] text-muted-foreground/80 truncate" title={backupStatus?.schedule || ''}>
                {backupStatus?.enabled
                  ? `Runs ${describeSchedule(backupStatus?.schedule)} · keep ${backupStatus?.maxBackups ?? '?'}`
                  : 'No scheduled backups'}
              </p>
            </div>
            <Switch
              checked={backupStatus?.enabled || false}
              onCheckedChange={toggleBackupEnabled}
              aria-label="Toggle scheduled backups"
            />
          </CardContent>
        </Card>
      </div>
      )}

      {/* Settings Panel (collapsible) */}
      {showSettings && (
        <Card className="border-primary/15">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Settings className="w-5 h-5" />
              Backup Settings
            </CardTitle>
            <CardDescription>Configure scheduled backup settings.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="backup-schedule">Backup Frequency</Label>
                <Select value={backupSchedule} onValueChange={setBackupSchedule}>
                  <SelectTrigger id="backup-schedule" className="w-full">
                    <SelectValue placeholder="Select frequency" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="*/15 * * * *">Every 15 minutes</SelectItem>
                    <SelectItem value="*/30 * * * *">Every 30 minutes</SelectItem>
                    <SelectItem value="0 * * * *">Every hour</SelectItem>
                    <SelectItem value="0 */2 * * *">Every 2 hours</SelectItem>
                    <SelectItem value="0 */4 * * *">Every 4 hours</SelectItem>
                    <SelectItem value="0 */6 * * *">Every 6 hours</SelectItem>
                    <SelectItem value="0 */8 * * *">Every 8 hours</SelectItem>
                    <SelectItem value="0 */12 * * *">Every 12 hours</SelectItem>
                    <SelectItem value="0 0 * * *">Daily at midnight</SelectItem>
                    <SelectItem value="0 6 * * *">Daily at 6 AM</SelectItem>
                    <SelectItem value="0 12 * * *">Daily at noon</SelectItem>
                    <SelectItem value="0 18 * * *">Daily at 6 PM</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  How often to automatically create backups
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="backup-max">Maximum Backups to Keep</Label>
                <Input
                  id="backup-max"
                  type="number"
                  min={1}
                  max={100}
                  value={backupMaxCount}
                  onChange={(e) => {
                    const parsed = parseInt(e.target.value, 10)
                    // Only update if valid number in range
                    if (!isNaN(parsed) && parsed >= 1 && parsed <= 100) {
                      setBackupMaxCount(parsed)
                    } else if (e.target.value === '') {
                      setBackupMaxCount(10) // Reset to default if cleared
                    }
                  }}
                  className="max-w-24"
                />
                <p className="text-xs text-muted-foreground">
                  Oldest backups will be auto-deleted when limit is reached
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-xs text-muted-foreground">
                {backupStatus?.savesPath && (
                  <span className="flex flex-wrap items-center gap-1 break-all">
                    <FolderOpen className="w-3 h-3" />
                    Saves: {backupStatus.savesPath}
                  </span>
                )}
              </div>
              <Button onClick={handleSaveSettings} disabled={savingSettings} size="sm" className="h-10 gap-2 self-start sm:self-auto">
                {savingSettings && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Save Settings
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Progress Bar */}
      {(creatingBackup || backupProgress) && (
        <Card className="border-primary/15 bg-primary/5">
          <CardContent className="pt-6">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {backupProgress?.phase === 'complete' ? (
                    <Check className="w-5 h-5 text-primary" />
                  ) : backupProgress?.phase === 'error' ? (
                    <AlertTriangle className="w-5 h-5 text-destructive" />
                  ) : (
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  )}
                  <span className="font-medium">
                    {backupProgress?.message || 'Creating backup...'}
                  </span>
                </div>
                <span className="text-sm text-muted-foreground">
                  {backupProgress?.percent || 0}%
                </span>
              </div>
              <Progress value={backupProgress?.percent || 0} className="h-2" />
              {backupProgress?.currentFile && (
                <p className="text-xs text-muted-foreground truncate">
                  {backupProgress.currentFile}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Backup Card */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <CardTitle className="text-lg">Backup Files</CardTitle>
              {!backupStatus?.savesExists && (
                <span className="flex items-center gap-1 text-xs text-warning">
                  <AlertTriangle className="w-3 h-3" />
                  Saves folder not found
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {isAnySelected && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleteDialog({ open: true, names: Array.from(selectedBackups) })}
                  disabled={deletingBackups}
                  className="h-10 gap-2"
                >
                  <Trash2 className="w-4 h-4" />
                  Delete ({selectedBackups.size})
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteOlderDialog(true)}
                disabled={deletingOlder || backups.length === 0}
                className="h-10 gap-2"
              >
                {deletingOlder ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Clock className="w-4 h-4" />
                )}
                Delete Older
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : backups.length === 0 ? (
            <EmptyState type="noData" title="No safety net" description="Create a backup before changing saves, mods, or server settings — one bad update away from lost progress." action={{ label: 'Create Backup', onClick: handleCreateBackup, variant: 'default' }} />
          ) : (
            <div className="space-y-2">
              {/* Select All Header */}
              <div className="flex items-center gap-3 px-3 py-2.5 border border-border/50 bg-muted/20 rounded-lg">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleSelectAll}
                  id="select-all"
                />
                <Label htmlFor="select-all" className="text-sm font-medium cursor-pointer flex-1">
                  {selectedBackups.size === 0
                    ? `Select all · ${backups.length} backup${backups.length === 1 ? '' : 's'}`
                    : allSelected
                      ? `All ${backups.length} selected · click to clear`
                      : `${selectedBackups.size} of ${backups.length} selected`}
                </Label>
                {selectedBackups.size > 0 && (
                  <span className="inline-flex h-5 items-center rounded-full bg-primary/15 px-2 font-mono text-[11px] tabular-nums text-primary">
                    {selectedBackups.size}
                  </span>
                )}
              </div>

              {/* Backup List */}
              <ScrollArea className="h-[300px] sm:h-[400px]">
                <div className="space-y-2 pr-4">
                  {backups.map((backup, idx) => {
                    const isSelected = selectedBackups.has(backup.name)
                    const isRestoring = restoringBackup === backup.name
                    const isLatest = idx === 0

                    return (
                      <div
                        key={backup.name}
                        className={cn(
                          'group/backup flex items-center gap-3 p-3 rounded-lg border transition-colors',
                          isSelected
                            ? 'border-primary/40 bg-primary/[0.08]'
                            : 'bg-muted/20 border-border/40 hover:border-primary/30 hover:bg-muted/40'
                        )}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleBackupSelection(backup.name)}
                          disabled={isRestoring}
                          aria-label={`Select backup ${backup.name}`}
                        />

                        {/* Leading archive tile — latest backup glows primary, others sit muted */}
                        <div
                          className={cn(
                            'grid place-items-center w-9 h-9 rounded-md border shrink-0',
                            isLatest
                              ? 'border-primary/40 bg-primary/[0.08] text-primary'
                              : 'border-border/55 bg-muted/30 text-muted-foreground'
                          )}
                          aria-hidden="true"
                        >
                          <Archive className="w-4 h-4" />
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <p className="font-medium text-sm text-foreground truncate">{backup.name}</p>
                            {isLatest && (
                              <span className="shrink-0 inline-flex h-5 items-center rounded-full bg-primary/15 px-2 text-[10px] font-medium uppercase tracking-wide text-primary">
                                Latest
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1 tabular-nums">
                              <HardDrive className="w-3 h-3" />
                              {formatBytes(backup.size)}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {formatDate(backup.created)}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleViewSnapshot(backup.name)}
                            className="h-9 w-9"
                            aria-label={`View snapshot for ${backup.name}`}
                            title="View server snapshot"
                          >
                            <FileText className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRestoreDialog({ open: true, backupName: backup.name })}
                            disabled={isRestoring || restoringBackup !== null || creatingBackup}
                            className="h-9 w-9 text-warning hover:text-warning hover:bg-warning/10"
                            aria-label={`Restore ${backup.name}`}
                            title="Restore this backup"
                          >
                            {isRestoring ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <RotateCcw className="w-4 h-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => backupApi.downloadBackup(backup.name)}
                            className="h-9 w-9"
                            aria-label={`Download ${backup.name}`}
                            title="Download backup"
                          >
                            <Download className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteDialog({ open: true, names: [backup.name] })}
                            disabled={deletingBackups}
                            className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10"
                            aria-label={`Delete ${backup.name}`}
                            title="Delete backup"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </ScrollArea>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={snapshotDialog !== null} onOpenChange={(open) => !open && setSnapshotDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Server Snapshot</AlertDialogTitle>
            <AlertDialogDescription>{snapshotDialog?.name}</AlertDialogDescription>
          </AlertDialogHeader>
          {snapshotDialog && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
                <span>Server</span><span className="text-foreground">{snapshotDialog.snapshot.server.name}</span>
                <span>Provider</span><span className="text-foreground">{snapshotDialog.snapshot.server.provider}</span>
                <span>Captured</span><span className="text-foreground">{new Date(snapshotDialog.snapshot.createdAt).toLocaleString()}</span>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">SERVER.INI</p>
                <pre className="max-h-36 overflow-auto rounded border border-border/60 bg-muted/20 p-2 text-xs">{Object.entries(snapshotDialog.snapshot.serverIni).map(([key, value]) => `${key}=${value}`).join('\n') || 'No captured settings'}</pre>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">SANDBOX</p>
                <pre className="max-h-36 overflow-auto rounded border border-border/60 bg-muted/20 p-2 text-xs">{Object.entries(snapshotDialog.snapshot.sandboxVars).map(([key, value]) => `${key}=${value}`).join('\n') || 'No captured settings'}</pre>
              </div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setSnapshotDialog(null)}>Close</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Restore Confirmation Dialog */}
      <AlertDialog open={restoreDialog.open} onOpenChange={(open) => setRestoreDialog({ open, backupName: null })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-warning">
              <AlertTriangle className="w-5 h-5" />
              Restore Backup
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                Restore <strong>{restoreDialog.backupName}</strong>. This will <span className="font-medium text-destructive">replace</span> the current world data.
              </p>
              <ul className="list-disc list-inside text-sm space-y-1 mt-2">
                <li>Stop the server first.</li>
                <li>The panel will create a safety backup before restoring.</li>
                <li>This action cannot be undone.</li>
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => restoreDialog.backupName && handleRestoreBackup(restoreDialog.backupName)}
              className="bg-warning text-warning-foreground hover:bg-warning/90"
            >
              Restore this backup
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialog.open} onOpenChange={(open) => setDeleteDialog({ open, names: [] })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" />
              Delete Backup{deleteDialog.names.length > 1 ? 's' : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteDialog.names.length === 1 ? (
                <p>
                  Delete <strong>{deleteDialog.names[0]}</strong>? This permanently removes the backup file.
                </p>
              ) : (
                <p>
                  Delete <strong>{deleteDialog.names.length} backups</strong>? This permanently removes those files.
                </p>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handleDeleteBackups(deleteDialog.names)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete backup{deleteDialog.names.length > 1 ? 's' : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Older Than Dialog */}
      <AlertDialog open={deleteOlderDialog} onOpenChange={setDeleteOlderDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-warning">
              <Clock className="w-5 h-5" />
              Delete Old Backups
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4">
                <p>Delete every backup older than the number of days you choose here.</p>
                <div className="flex items-center gap-3">
                  <Label htmlFor="delete-days" className="text-foreground whitespace-nowrap">Delete backups older than</Label>
                  <Input
                    id="delete-days"
                    type="number"
                    min={1}
                    max={365}
                    value={deleteOlderDays}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10)
                      if (!isNaN(val) && val >= 1 && val <= 365) {
                        setDeleteOlderDays(val)
                      }
                    }}
                    className="w-20"
                  />
                  <span className="text-foreground">days</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  This permanently deletes backups created more than {deleteOlderDays} days ago.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteOlderThan}
              className="bg-warning text-warning-foreground hover:bg-warning/90"
            >
              Delete older backups
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
