import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ArrowRight, Plus, Upload, Loader2, RotateCcw } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/ui/button'
import { SectionCard } from '@/components/ui/section-card'
import { Skeleton } from '@/components/ui/skeleton'
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

  // A hidden built-in never appears in `templates` above -- deleteTemplate()
  // (templateService.js) doesn't remove its data, it filters it out of
  // listTemplates(). Without this, hiding one was a one-way trip: no route
  // returned it, so nothing in the app could ever show it again.
  // GET /templates/hidden is gated on templates.manage server-side, so
  // there's nowhere to call it from for a viewer -- skip the request rather
  // than let it 403 silently.
  const [hiddenTemplates, setHiddenTemplates] = useState<SimTemplate[]>([])
  const [restoringId, setRestoringId] = useState<string | null>(null)

  const [previewTemplate, setPreviewTemplate] = useState<SimTemplate | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const fetchTemplates = useCallback(async () => {
    try {
      const { templates: list } = await templatesApi.list()
      setTemplates(Array.isArray(list) ? list : [])
      setLoadError(null)
    } catch (error) {
      setLoadError(getUserErrorMessage(error, t('toasts.loadFailedFallback')))
    } finally {
      setLoading(false)
    }
  }, [t])

  const fetchHiddenTemplates = useCallback(async () => {
    if (!canManage) {
      setHiddenTemplates([])
      return
    }
    try {
      const { templates: list } = await templatesApi.listHidden()
      setHiddenTemplates(Array.isArray(list) ? list : [])
    } catch {
      // Non-fatal: the main list above already loaded and is the primary
      // view. Leave the hidden section empty rather than surface a second
      // load-error state for a secondary, opt-in section.
      setHiddenTemplates([])
    }
  }, [canManage])

  useEffect(() => {
    fetchTemplates()
    fetchHiddenTemplates()
  }, [fetchTemplates, fetchHiddenTemplates])

  const handleRestore = async (template: SimTemplate) => {
    setRestoringId(template.meta.id)
    try {
      const result = await templatesApi.unhide(template.meta.id)
      if (!result.success) throw new Error(result.error || t('toasts.restoreFailedFallback'))
      toast({ title: t('toasts.templateRestoredTitle'), variant: 'success' as const })
      fetchTemplates()
      fetchHiddenTemplates()
    } catch (error) {
      toast({
        title: t('toasts.restoreFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.restoreFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setRestoringId(null)
    }
  }

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
    // Built-in templates aren't deleted server-side -- deleteTemplate()
    // (templateService.js) just adds the id to a hidden-ids setting, no
    // data loss. "This can't be undone" is false for that case, and there's
    // no restore control anywhere in the app to make it true, so the confirm
    // copy has to say what actually happens instead of the destructive
    // boilerplate the custom-template path still legitimately needs.
    const ok = await confirm(
      template.isBuiltin
        ? {
            title: t('toasts.hideBuiltinTemplateTitle'),
            description: t('toasts.hideBuiltinTemplateDesc', { name: template.meta.name }),
            confirmLabel: t('toasts.hideBuiltinTemplateConfirm'),
            destructive: false,
          }
        : {
            title: t('toasts.deleteTemplateTitle'),
            description: t('toasts.deleteTemplateDesc', { name: template.meta.name }),
            destructive: true,
          }
    )
    if (!ok) return
    try {
      const result = await templatesApi.delete(template.meta.id)
      if (!result.success) throw new Error(result.error || t('toasts.deleteFailedFallback'))
      toast({ title: template.isBuiltin ? t('toasts.templateHiddenTitle') : t('toasts.templateDeletedTitle'), variant: 'success' as const })
      fetchTemplates()
      // Hiding a built-in moves it into the "hidden templates" section; without
      // this refetch that section stayed stale (no Restore button) until reload.
      fetchHiddenTemplates()
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
        // Templates and config snapshots are easy to confuse: name where the
        // other one lives.
        meta={
          <Link
            to="/server-config?open=snapshots"
            className="inline-flex items-center gap-1 rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            {t('pageHeader.snapshotsLink')}
            <ArrowRight className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden="true" />
          </Link>
        }
        actions={canManage ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)} aria-label={t('pageHeader.import')}>
              <Upload className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t('pageHeader.import')}</span>
            </Button>
            <Button variant="command" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('pageHeader.saveCurrentConfig')}
            </Button>
          </>
        ) : undefined}
      />

      {loading ? (
        // The header stays; only the list waits (a skeleton of the cards).
        <div role="status" aria-busy="true" aria-label={t('loading')} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-3 rounded-xl border border-border/60 bg-card p-5">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <div className="flex gap-1.5 pt-1">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-12 rounded-full" />
              </div>
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
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

      {canManage && hiddenTemplates.length > 0 && (
        <SectionCard
          title={t('hiddenSection.toggle', { n: hiddenTemplates.length })}
          description={t('hiddenSection.description')}
          density="compact"
          collapsible
          defaultOpen={false}
        >
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {hiddenTemplates.map((template) => (
              <li
                key={template.meta.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/25 px-3 py-2"
              >
                <span className="truncate text-sm text-muted-foreground">{template.meta.name}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleRestore(template)}
                  disabled={restoringId === template.meta.id}
                  aria-label={t('hiddenSection.restoreAria', { name: template.meta.name })}
                >
                  {restoringId === template.meta.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  )}
                  {t('hiddenSection.restoreButton')}
                </Button>
              </li>
            ))}
          </ul>
        </SectionCard>
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
