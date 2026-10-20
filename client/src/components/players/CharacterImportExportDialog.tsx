import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { Link } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Copy, Download, Loader2, Trash2, Upload } from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { configApi, panelBridgeApi, playersApi } from '@/lib/api'
import { useDateFormat } from '@/lib/dateFormat'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { cn, copyText } from '@/lib/utils'

export interface SavedCharacterExport {
  username: string
  filename: string
  size: number
  timestamp: string
}

interface CharacterImportExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The player the export and the import act on: the dossier's selection. */
  player: string
  bridgeConnected: boolean
  bridgeStatusLoading: boolean
  autoExportEnabled: boolean
  onAutoExportEnabledChange: (enabled: boolean) => void
  savedExports: SavedCharacterExport[]
  onSavedExportsChange: Dispatch<SetStateAction<SavedCharacterExport[]>>
}

// Export / import of one player's character through PanelBridge, plus the
// auto-export-on-login switch and the saved exports list. Lives in its own
// component so its state (the exported JSON, the pasted import, the
// confirmation) stays out of the Players page.
export function CharacterImportExportDialog({
  open,
  onOpenChange,
  player,
  bridgeConnected,
  bridgeStatusLoading,
  autoExportEnabled,
  onAutoExportEnabledChange,
  savedExports,
  onSavedExportsChange,
}: CharacterImportExportDialogProps) {
  const { t } = useTranslation('players')
  const { formatDateTime } = useDateFormat()
  const { toast } = useToast()

  // The exported JSON together with the player it was exported for: the
  // download is named after that player, not whoever is selected by then.
  const [exported, setExported] = useState<{ player: string; json: string } | null>(null)
  const [importCharacterData, setImportCharacterData] = useState('')
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [importConfirmOpen, setImportConfirmOpen] = useState(false)
  const [pendingImportData, setPendingImportData] = useState<Record<string, unknown> | null>(null)

  // Ref for copy timeout cleanup
  const copiedTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current)
      }
    }
  }, [])

  // The saved exports list, re-read from the server: an import writes a
  // recovery copy of the player's current data there first (the confirm text
  // promises it), and auto-exports land in it on every login, so the list
  // the page loaded once is stale. Re-read whenever the dialog opens and
  // after every import. Only the latest answer is applied.
  const exportsRequestRef = useRef(0)
  const refreshSavedExports = useCallback(() => {
    const requestId = ++exportsRequestRef.current
    Promise.resolve()
      .then(() => playersApi.getExports())
      .then((response) => {
        if (requestId === exportsRequestRef.current && response?.exports) onSavedExportsChange(response.exports)
      })
      .catch(() => {})
  }, [onSavedExportsChange])
  useEffect(() => {
    if (open) refreshSavedExports()
  }, [open, refreshSavedExports])

  // A different player was selected: the previous player's export is not
  // theirs to show, copy or download.
  const playerRef = useRef(player)
  useEffect(() => {
    playerRef.current = player
    setExported(null)
  }, [player])

  const handleExport = async () => {
    const exportedPlayer = player
    setExporting(true)
    try {
      const response = await panelBridgeApi.exportCharacter(exportedPlayer)
      // The selection moved on while the bridge was answering.
      if (playerRef.current !== exportedPlayer) return
      const exportData = response.data || response
      const jsonStr = JSON.stringify(exportData, null, 2)
      setExported({ player: exportedPlayer, json: jsonStr })
      toast({
        title: t('toasts.characterExportedTitle'),
        description: t('toasts.characterExportedDesc', { player: exportedPlayer }),
      })
    } catch (error) {
      toast({
        title: t('toasts.exportFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.exportFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setExporting(false)
    }
  }

  // Overwrites the target player's XP/perks/skills/traits/inventory/wornItems --
  // split out of the Apply button so the confirm dialog can hold the parsed
  // data until the operator confirms the target player by name.
  const runCharacterImport = async (data: Record<string, unknown>) => {
    setImporting(true)
    try {
      const response = await panelBridgeApi.importCharacter(player, data)
      const restored = response.data?.restored
      // Submitted a non-empty perks/inventory section but restored
      // nothing from it: the Lua side counts honestly (see
      // PanelBridge.lua importPlayerData) but a caller that only
      // reads the counts from the description, not the title,
      // would still see an unconditionally success-styled toast.
      const submittedPerks = data && typeof data.perks === 'object' && data.perks !== null && Object.keys(data.perks).length > 0
      const submittedItems = Array.isArray((data as { inventory?: unknown[] })?.inventory) && (data as { inventory: unknown[] }).inventory.length > 0
      const noneApplied = (restored?.perks ?? 0) === 0 && (restored?.items ?? 0) === 0 && (submittedPerks || submittedItems)
      toast({
        title: t(noneApplied ? 'toasts.characterImportedTitleNoneApplied' : 'toasts.characterImportedTitle'),
        description: noneApplied
          ? t('toasts.characterImportedDescNoneApplied', { player })
          : t('toasts.characterImportedDesc', { perks: restored?.perks ?? 0, items: restored?.items ?? 0, player }),
      })
      setImportCharacterData('')
    } catch (error) {
      toast({
        title: t('toasts.importFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.importFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setImporting(false)
      setImportConfirmOpen(false)
      setPendingImportData(null)
      // Also after a failed import: the recovery copy is written before the
      // import is attempted.
      refreshSavedExports()
    }
  }

  return (
    <>
      {/* Import/Export Character Dialog */}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="w-5 h-5" />
              {t('importExport.title')}
            </DialogTitle>
            <DialogDescription>
              {t('importExport.description')}
            </DialogDescription>
          </DialogHeader>
          {!bridgeStatusLoading && !bridgeConnected && (
            <Alert className="border-warning/40 bg-warning/10">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertTitle className="text-warning">{t('importExport.bridgeOfflineTitle')}</AlertTitle>
              <AlertDescription>
                <Trans
                  i18nKey="importExport.bridgeOfflineDesc"
                  t={t}
                  components={{ 1: <Link to="/settings" className="text-primary underline hover:text-foreground" /> }}
                />
              </AlertDescription>
            </Alert>
          )}
          <div className={cn("grid grid-cols-1 md:grid-cols-2 gap-4", !bridgeConnected && 'opacity-60 pointer-events-none')}>
            {/* Export */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium flex items-center gap-2">
                <Download className="w-4 h-4" />
                {t('importExport.exportTitle')}
              </h4>
              <p className="text-xs text-muted-foreground">{t('importExport.exportDesc')}</p>
              <Button
                variant="outline"
                disabled={!player || exporting}
                onClick={handleExport}
                size="sm"
                className="w-full"
              >
                {exporting ? (
                  <Loader2 className="w-4 h-4 me-2 animate-spin" />
                ) : (
                  <Download className="w-4 h-4 me-2" />
                )}
                {/* A 32-char username (PZ's own limit) cut the label and
                    pushed the Import column off a phone screen; it truncates
                    inside the button now, full name in the title. */}
                <span className="min-w-0 truncate" title={player || undefined}>
                  {t('importExport.exportButton', { player: player || t('importExport.exportButtonFallback') })}
                </span>
              </Button>

              {exported && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">{t('importExport.characterDataLabel')}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      aria-label={copied ? t('importExport.copiedAria') : t('importExport.copyCharacterDataAria')}
                      onClick={() => {
                        copyText(exported.json)
                        setCopied(true)
                        if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current)
                        copiedTimeoutRef.current = setTimeout(() => setCopied(false), 2000)
                      }}
                    >
                      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </Button>
                  </div>
                  <Textarea
                    readOnly
                    value={exported.json}
                    className="h-32 resize-none font-mono text-xs"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      const blob = new Blob([exported.json], { type: 'application/json' })
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = `${exported.player}_character.json`
                      a.click()
                      URL.revokeObjectURL(url)
                    }}
                  >
                    <Download className="w-4 h-4 me-2" />
                    {t('importExport.downloadFileButton')}
                  </Button>
                </div>
              )}
            </div>

            {/* Import */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium flex items-center gap-2">
                <Upload className="w-4 h-4" />
                {t('importExport.importTitle')}
              </h4>
              <p className="text-xs text-muted-foreground">{t('importExport.importDesc')}</p>
              <Textarea
                value={importCharacterData}
                onChange={(e) => setImportCharacterData(e.target.value)}
                placeholder={t('importExport.importPlaceholder')}
                className="h-24 resize-none font-mono text-xs"
              />
              <div className="flex gap-2">
                <Button
                  disabled={importing || !player || !importCharacterData.trim()}
                  onClick={() => {
                    let data
                    try {
                      data = JSON.parse(importCharacterData)
                    } catch {
                      toast({
                        title: t('toasts.invalidJsonTitle'),
                        description: t('toasts.invalidJsonDesc'),
                        variant: 'destructive',
                      })
                      return
                    }
                    setPendingImportData(data)
                    setImportConfirmOpen(true)
                  }}
                  size="sm"
                  className="flex-1"
                >
                  {importing ? (
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4 me-2" />
                  )}
                  {t('importExport.applyButton')}
                </Button>
                <label className="cursor-pointer">
                  <Button variant="outline" size="sm" asChild>
                    <span>
                      <Upload className="w-4 h-4 me-1" />
                      {t('importExport.fileButton')}
                    </span>
                  </Button>
                  <input
                    type="file"
                    accept=".json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) {
                        if (file.size > 5 * 1024 * 1024) {
                          toast({
                            title: t('toasts.fileTooLargeTitle'),
                            description: t('toasts.fileTooLargeDesc'),
                            variant: 'destructive',
                          })
                          e.target.value = ''
                          return
                        }
                        const reader = new FileReader()
                        reader.onload = (ev) => {
                          setImportCharacterData(ev.target?.result as string || '')
                        }
                        reader.readAsText(file)
                      }
                      e.target.value = ''
                    }}
                  />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">{t('importExport.playerMustBeOnline')}</p>
            </div>
          </div>

          {/* Auto-export on login */}
          <div className="border-t border-border/40 pt-4 mt-2 space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <h4 className="text-sm font-medium">{t('importExport.autoExportTitle')}</h4>
                <p className="text-xs text-muted-foreground">{t('importExport.autoExportDesc')}</p>
              </div>
              <Checkbox
                id="autoExportOnLogin"
                checked={autoExportEnabled}
                onCheckedChange={async (checked: boolean) => {
                  onAutoExportEnabledChange(checked)
                  try {
                    await configApi.updateAppSettings({ autoExportOnLogin: checked })
                  } catch {
                    onAutoExportEnabledChange(!checked)
                    toast({ title: t('toasts.updateSettingFailed'), variant: 'destructive' })
                  }
                }}
              />
            </div>

            {savedExports.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-medium text-muted-foreground">{t('importExport.savedExportsTitle', { count: savedExports.length })}</h4>
                <ScrollArea className="max-h-[180px]">
                  <div className="space-y-1">
                    {savedExports.map((exp) => (
                      <div key={`${exp.username}-${exp.filename}`} className="flex items-center justify-between gap-2 rounded-md border border-border/40 px-3 py-1.5 text-xs">
                        <div className="min-w-0 flex-1">
                          <span className="font-medium">{exp.username}</span>
                          <span className="text-muted-foreground ms-2">{formatDateTime(exp.timestamp, { seconds: true })}</span>
                          <span className="text-muted-foreground ms-2">{t('importExport.sizeKb', { size: (exp.size / 1024).toFixed(1) })}</span>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            title={t('importExport.downloadTitle')}
                            aria-label={t('importExport.downloadExportAria', { username: exp.username })}
                            onClick={async () => {
                              try {
                                const data = await playersApi.getExport(exp.username, exp.filename)
                                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
                                const url = URL.createObjectURL(blob)
                                const a = document.createElement('a')
                                a.href = url
                                a.download = exp.filename
                                a.click()
                                URL.revokeObjectURL(url)
                              } catch {
                                toast({ title: t('toasts.downloadFailed'), variant: 'destructive' })
                              }
                            }}
                          >
                            <Download className="w-3 h-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                            title={t('importExport.deleteTitle')}
                            aria-label={t('importExport.deleteExportAria', { username: exp.username })}
                            onClick={async () => {
                              try {
                                await playersApi.deleteExport(exp.username, exp.filename)
                                onSavedExportsChange(prev => prev.filter(e => e.filename !== exp.filename || e.username !== exp.username))
                              } catch {
                                toast({ title: t('toasts.deleteFailed'), variant: 'destructive' })
                              }
                            }}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Character Import Confirmation -- the failure mode here is the wrong
          player, so the target's name is the title, not a line inside the
          body. Pam's panelBridge.js snapshots the target's current data to
          Saved Exports before overwriting; if that snapshot fails the server
          refuses the import instead of proceeding, so this is honestly
          recoverable and the copy says so. */}
      <AlertDialog open={importConfirmOpen} onOpenChange={(open) => { if (!open) { setImportConfirmOpen(false); setPendingImportData(null) } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('importConfirm.title', { player })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('importConfirm.description', { player })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={importing}>{t('importConfirm.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={importing}
              onClick={(e) => { e.preventDefault(); if (pendingImportData) runCharacterImport(pendingImportData) }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {importing ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : null}
              {t('importConfirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
