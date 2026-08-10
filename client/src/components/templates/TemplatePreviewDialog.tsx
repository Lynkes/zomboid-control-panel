import { useEffect, useState, useCallback } from 'react'
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
import {
  templatesApi,
  serversApi,
  serverApi,
  SimTemplate,
  SimTemplateDiff,
  SimTemplateApplyResult,
  ServerInstance,
} from '@/lib/api'
import { TemplateDiffList } from './TemplateDiffList'
import { TemplateApplyPanel } from './TemplateApplyPanel'

interface TemplatePreviewDialogProps {
  template: SimTemplate | null
  canManage: boolean
  onClose: () => void
  onApplied: () => void
}

export function TemplatePreviewDialog({ template, canManage, onClose, onApplied }: TemplatePreviewDialogProps) {
  const { toast } = useToast()
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

  const load = useCallback(async (t: SimTemplate) => {
    setServerLoading(true)
    setDiff(null)
    setDiffError(null)
    setApplyResult(null)
    setApplyError(null)
    setScopeIni(true)
    setScopeSandbox(true)
    setRunning(null)

    const { server: active } = await serversApi.getResolvedActive().catch(() => ({ server: null }))
    setServer(active)
    if (active && !active.isRemote) {
      serverApi.getStatus()
        .then((status) => setRunning(!!(status as { running?: boolean })?.running))
        .catch(() => setRunning(null))
    }

    if (active && !active.isRemote) {
      try {
        const result = await templatesApi.preview(t.meta.id, active.id)
        if (result.success && result.diff) setDiff(result.diff)
        else setDiffError(result.error || 'Failed to preview template')
      } catch (error) {
        setDiffError(error instanceof Error ? error.message : 'Failed to preview template')
      }
    }
    setServerLoading(false)
  }, [])

  useEffect(() => {
    if (template) load(template)
  }, [template, load])

  const handleApply = async () => {
    if (!template || !server) return
    setApplying(true)
    setApplyError(null)
    try {
      const result = await templatesApi.apply(template.meta.id, server.id, {
        applyIni: scopeIni,
        applySandbox: scopeSandbox,
      })
      if (!result.success) throw new Error(result.error || 'Failed to apply template')
      setApplyResult(result)
      toast({ title: 'Template Applied', description: `"${template.meta.name}" was applied.`, variant: 'success' as const })
      onApplied()
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : 'Failed to apply template')
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
            <AlertTitle>No Active Server</AlertTitle>
            <AlertDescription>Set up a server before previewing or applying templates.</AlertDescription>
          </Alert>
        ) : server.isRemote ? (
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Remote Server</AlertTitle>
            <AlertDescription>Applying templates to remote servers isn't supported yet.</AlertDescription>
          </Alert>
        ) : diffError ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Preview Failed</AlertTitle>
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
