import { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, AlertTriangle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useSocket } from '@/contexts/SocketContext'
import {
  templatesApi,
  serversApi,
  serverApi,
  SimTemplate,
  SimTemplateDiff,
  SimTemplateApplyResult,
  ServerInstance,
} from '@/lib/api'
import { resolveServerRunning } from '@/lib/serverStatus'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { TemplateDiffList } from './TemplateDiffList'
import { TemplateApplyPanel } from './TemplateApplyPanel'

interface TemplatePreviewDialogProps {
  template: SimTemplate | null
  canManage: boolean
  onClose: () => void
  onApplied: () => void
}

export function TemplatePreviewDialog({ template, canManage, onClose, onApplied }: TemplatePreviewDialogProps) {
  const { t } = useTranslation('templatePreviewDialog')
  const { toast } = useToast()
  const confirm = useConfirm()
  const socket = useSocket()
  const [server, setServer] = useState<ServerInstance | null>(null)
  const [serverLoading, setServerLoading] = useState(true)
  const [running, setRunning] = useState<boolean | null>(null)
  const [diff, setDiff] = useState<SimTemplateDiff | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [scopeIni, setScopeIni] = useState(true)
  const [scopeSandbox, setScopeSandbox] = useState(true)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<SimTemplateApplyResult | null>(null)

  // Closing this dialog and reopening it for a different template does not
  // unmount it (Templates.tsx just swaps the `template` prop via
  // setPreviewTemplate), so a slow preview response for the PREVIOUS
  // template can land after a newer load() has already started and
  // overwrite this render with the wrong template's server/running/diff --
  // same shape as the fetch-race hunt's ChunkCleaner.tsx loadIdRef
  // precedent. Every setState below a real await is gated on this still
  // being the most recent load() call.
  const loadIdRef = useRef(0)

  const load = useCallback(async (tpl: SimTemplate) => {
    const loadId = ++loadIdRef.current
    setServerLoading(true)
    setDiff(null)
    setDiffError(null)
    setApplyResult(null)
    setApplyError(null)
    setScopeIni(true)
    setScopeSandbox(true)
    setRunning(null)

    const { server: active } = await serversApi.getResolvedActive().catch(() => ({ server: null }))
    if (loadIdRef.current !== loadId) return
    setServer(active)
    // GH#114-shaped (2026-09-08): TemplateApplyPanel disables Apply and
    // shows a "stop the server first" warning unless `running` is
    // CONFIRMED false -- deliberately fail-closed, same as
    // ServerConfig.tsx's save-guard, because applying a template
    // overwrites live INI/Sandbox config. The raw local scan
    // (serverApi.getStatus()) used to be trusted directly here, which is
    // blind to a docker-local server's containerized process: it reports
    // a confident `running: false` for a server that is actually up, which
    // would have silently defeated this exact guard (Apply enabled, no
    // warning, on a running server) rather than merely showing a wrong
    // badge. resolveServerRunning() shares the same provider-aware,
    // fail-closed contract this dialog already needs -- it never resolves
    // to `false` except when a signal source positively confirms stopped.
    if (active && !active.isRemote) {
      resolveServerRunning(active, serverApi.getStatus, serversApi.getComposedStatus)
        .then((result) => {
          if (loadIdRef.current !== loadId) return
          setRunning(result)
        })
    }

    if (active && !active.isRemote) {
      try {
        const result = await templatesApi.preview(tpl.meta.id, active.id)
        if (loadIdRef.current !== loadId) return
        if (result.success && result.diff) setDiff(result.diff)
        else setDiffError(result.error || t('failedToPreview'))
      } catch (error) {
        if (loadIdRef.current !== loadId) return
        setDiffError(getUserErrorMessage(error, t('failedToPreview')))
      }
    }
    if (loadIdRef.current === loadId) setServerLoading(false)
  }, [t])

  useEffect(() => {
    if (template) load(template)
  }, [template, load])

  // pz-bughunt round 18 (the narrower server-switch races flagged in round
  // 17): `server` (and the diff/running snapshot computed from it) is
  // captured once in load(), when the dialog opens for a template --
  // there was no activeServerChanged listener here at all, so switching
  // the active server elsewhere while this dialog stayed open left it
  // showing a diff computed against, and a "must be stopped" verdict
  // resolved for, a server that may no longer even be the one the operator
  // is looking at. handleApply's own templatesApi.apply(..., server.id,
  // ...) call sends that captured id EXPLICITLY (unlike the implicit-
  // active-server class this round's other fixes target), so it can't
  // silently land on the wrong server -- but continuing to act on a
  // preview/running-status snapshot that's gone stale is still a real
  // correctness risk (e.g. `running` never re-confirms, so a server
  // started elsewhere after load() could still show as safe to overwrite).
  // Simplest, safest fix, consistent with every other dialog this round:
  // close it outright the instant the active server changes, exactly like
  // Backups.tsx's restore/delete dialogs and Mods.tsx's restart-settings
  // dialog already do.
  useEffect(() => {
    if (!socket || !template) return
    const handleActiveServerChanged = () => onClose()
    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, template, onClose])

  const handleApply = async () => {
    if (!template || !server) return
    // Overwrites the live server config with no undo -- but unlike a
    // delete, it's fully reversible (apply a different template, or the
    // same server config again) and only reaches players at the NEXT
    // restart, not instantly. Affects-others-but-reversible tier:
    // warning-amber, matching Mods.tsx's "Apply preset" confirm rather
    // than either destructive-red or no confirmation at all.
    const ok = await confirm({
      title: t('applyConfirmTitle', { name: template.meta.name }),
      description: t('applyConfirmDescription', { count: diff?.summary.totalChanges ?? 0 }),
      confirmLabel: t('applyConfirmButton'),
      variant: 'warning',
    })
    if (!ok) return
    setApplying(true)
    setApplyError(null)
    try {
      const result = await templatesApi.apply(template.meta.id, server.id, {
        applyIni: scopeIni,
        applySandbox: scopeSandbox,
      })
      if (!result.success) throw new Error(result.error || t('failedToApply'))
      setApplyResult(result)
      toast({ title: t('toastAppliedTitle'), description: t('toastAppliedDesc', { name: template.meta.name }), variant: 'success' as const })
      onApplied()
    } catch (error) {
      setApplyError(getUserErrorMessage(error, t('failedToApply')))
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open={!!template} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{template?.meta.name}</DialogTitle>
          <DialogDescription>{template?.meta.description}</DialogDescription>
        </DialogHeader>

        {serverLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : !server ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t('noActiveServerTitle')}</AlertTitle>
            <AlertDescription>{t('noActiveServerDesc')}</AlertDescription>
          </Alert>
        ) : server.isRemote ? (
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t('remoteServerTitle')}</AlertTitle>
            <AlertDescription>{t('remoteServerDesc')}</AlertDescription>
          </Alert>
        ) : diffError ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t('previewFailedTitle')}</AlertTitle>
            <AlertDescription>{diffError}</AlertDescription>
          </Alert>
        ) : diff && template ? (
          <>
            <TemplateDiffList diff={diff} mods={template.mods} />
            <TemplateApplyPanel
              running={running}
              scopeIni={scopeIni}
              scopeSandbox={scopeSandbox}
              onScopeIniChange={setScopeIni}
              onScopeSandboxChange={setScopeSandbox}
              applying={applying}
              applyError={applyError}
              applyResult={applyResult}
              canManage={canManage}
              canApply={diff.summary.totalChanges > 0}
              onApply={handleApply}
              onClose={onClose}
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
