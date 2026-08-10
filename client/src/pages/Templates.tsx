import { useCallback, useEffect, useState } from 'react'
import { LayoutTemplate, Plus, Upload, Loader2 } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/contexts/ConfirmContext'
import { templatesApi, SimTemplate } from '@/lib/api'
import { TemplateCard } from '@/components/templates/TemplateCard'
import { TemplatePreviewDialog } from '@/components/templates/TemplatePreviewDialog'
import { CreateTemplateDialog } from '@/components/templates/CreateTemplateDialog'
import { ImportTemplateDialog } from '@/components/templates/ImportTemplateDialog'
import { useAuth } from '@/contexts/AuthContext'

export default function Templates() {
  const { toast } = useToast()
  const confirm = useConfirm()
  const { user, authEnabled } = useAuth()
  const canManage = !authEnabled || user?.role === 'admin'

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
      setLoadError(error instanceof Error ? error.message : 'Failed to load templates.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  const handleExport = async (template: SimTemplate) => {
    try {
      const slug = template.meta.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      await templatesApi.downloadExport(template.meta.id, slug || template.meta.id)
    } catch (error) {
      toast({
        title: 'Export Failed',
        description: error instanceof Error ? error.message : 'Failed to export template',
        variant: 'destructive',
      })
    }
  }

  const handleDelete = async (template: SimTemplate) => {
    const ok = await confirm({
      title: 'Delete Template',
      description: `Delete "${template.meta.name}"? This can't be undone.`,
      destructive: true,
    })
    if (!ok) return
    try {
      const result = await templatesApi.delete(template.meta.id)
      if (!result.success) throw new Error(result.error || 'Failed to delete template')
      toast({ title: 'Template Deleted', variant: 'success' as const })
      fetchTemplates()
    } catch (error) {
      toast({
        title: 'Delete Failed',
        description: error instanceof Error ? error.message : 'Failed to delete template',
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title="Simulation Templates"
        description="Apply a curated ruleset to your server, or save your own configuration to reuse later."
        icon={<LayoutTemplate className="h-6 w-6" />}
        tone="config"
        actions={canManage ? (
          <>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" />
              Import
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Save Current Config
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
          title="Couldn't load templates"
          description={loadError}
          action={{ label: 'Retry', onClick: fetchTemplates }}
        />
      ) : templates.length === 0 ? (
        <EmptyState
          type="empty"
          title="No templates yet"
          description="Save your current server configuration as a template, or import one from a file."
          action={{ label: 'Save Current Config', onClick: () => setCreateOpen(true) }}
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
