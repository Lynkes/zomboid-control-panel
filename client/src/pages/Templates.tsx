import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutTemplate, Plus, Upload, Loader2 } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/contexts/ConfirmContext'
import { templatesApi, SimTemplate } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { TemplateCard } from '@/components/templates/TemplateCard'
import { TemplatePreviewDialog } from '@/components/templates/TemplatePreviewDialog'
import { CreateTemplateDialog } from '@/components/templates/CreateTemplateDialog'
import { ImportTemplateDialog } from '@/components/templates/ImportTemplateDialog'
import { useAuth } from '@/contexts/AuthContext'

export default function Templates() {
  const { t } = useTranslation('templates')
  const { toast } = useToast()
  const confirm = useConfirm()
  const { can, authEnabled } = useAuth()
  // Was `user?.role === 'admin'` -- a hardcoded role literal where the
  // server checks a capability (requirePermission("templates.manage") on
  // POST/import/apply/delete in routes/templates.js). A default Technician
  // role holds templates.manage and the server honors it, but that check
  // hid every manage control from them anyway. can() already fails OPEN
  // when capabilities are unknown -- see AuthContext's own doc comment --
  // so this is strictly more permissive for anyone this could have wrongly
  // blocked, never less.
  const canManage = !authEnabled || can('templates.manage')

  const [templates, setTemplates] = useState<SimTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [previewTemplate, setPreviewTemplate] = useState<SimTemplate | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const fetchTemplates = useCallback(async () => {
    try {
      const { templates: list } = await templatesApi.list()
      setTemplates(list)
      setLoadError(null)
    } catch (error) {
      setLoadError(getUserErrorMessage(error, t('toasts.loadFailedFallback')))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  const handleExport = async (template: SimTemplate) => {
    try {
      const slug = template.meta.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      await templatesApi.downloadExport(template.meta.id, slug || template.meta.id)
    } catch (error) {
      toast({
        title: t('toasts.exportFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.exportFailedFallback')),
        variant: 'destructive',
      })
    }
  }

  const handleDelete = async (template: SimTemplate) => {
    const ok = await confirm({
      title: t('toasts.deleteTemplateTitle'),
      description: t('toasts.deleteTemplateDesc', { name: template.meta.name }),
      destructive: true,
    })
    if (!ok) return
    try {
      const result = await templatesApi.delete(template.meta.id)
      if (!result.success) throw new Error(result.error || t('toasts.deleteFailedFallback'))
      toast({ title: t('toasts.templateDeletedTitle'), variant: 'success' as const })
      fetchTemplates()
    } catch (error) {
      toast({
        title: t('toasts.deleteFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.deleteFailedFallback')),
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        icon={<LayoutTemplate className="h-6 w-6" />}
        tone="config"
        actions={canManage ? (
          <>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" />
              {t('pageHeader.import')}
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              {t('pageHeader.saveCurrentConfig')}
            </Button>
          </>
        ) : undefined}
      />

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : loadError ? (
        <EmptyState
          type="noData"
          title={t('emptyState.loadErrorTitle')}
          description={loadError}
          action={{ label: t('emptyState.retry'), onClick: fetchTemplates }}
        />
      ) : templates.length === 0 ? (
        <EmptyState
          type="empty"
          title={t('emptyState.noTemplatesTitle')}
          description={t('emptyState.noTemplatesDesc')}
          action={canManage ? { label: t('pageHeader.saveCurrentConfig'), onClick: () => setCreateOpen(true) } : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <TemplateCard
              key={template.meta.id}
              template={template}
              onPreview={setPreviewTemplate}
              onExport={handleExport}
              onDelete={handleDelete}
              canManage={canManage}
            />
          ))}
        </div>
      )}

      <TemplatePreviewDialog
        template={previewTemplate}
        canManage={canManage}
        onClose={() => setPreviewTemplate(null)}
        onApplied={() => setPreviewTemplate(null)}
      />
      {canManage && (
        <>
          <CreateTemplateDialog
            open={createOpen}
            onClose={() => setCreateOpen(false)}
            onCreated={() => {
              setCreateOpen(false)
              fetchTemplates()
            }}
          />
          <ImportTemplateDialog
            open={importOpen}
            onClose={() => setImportOpen(false)}
            onImported={() => {
              setImportOpen(false)
              fetchTemplates()
            }}
          />
        </>
      )}
    </div>
  )
}
