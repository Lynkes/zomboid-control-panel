import { useTranslation } from 'react-i18next'
import { Lock, Eye, Download, EyeOff, Trash2, Package } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RowActions, type RowActionItem } from '@/components/ui/row-actions'
import { SimTemplate } from '@/lib/api'
import { formatDifficultyLabel } from '@/lib/templateLabels'

interface TemplateCardProps {
  template: SimTemplate
  onPreview: (template: SimTemplate) => void
  onExport: (template: SimTemplate) => void
  onDelete: (template: SimTemplate) => void
  canManage: boolean
}

export function TemplateCard({ template, onPreview, onExport, onDelete, canManage }: TemplateCardProps) {
  const { t } = useTranslation('templateCard')
  const changeCount = Object.keys(template.serverIni || {}).length +
    Object.values(template.sandboxVars || {}).reduce((n, s) => n + Object.keys(s || {}).length, 0)

  // One visible action (preview, where Apply lives) and the rest in "…".
  // Deleting a built-in only hides it (it can be restored), so it says so
  // and isn't styled as destructive.
  const actions: RowActionItem[] = [
    { label: t('exportTitle'), icon: Download, onSelect: () => onExport(template) },
    ...(canManage
      ? [
          template.isBuiltin
            ? { label: t('hideTitle'), icon: EyeOff, onSelect: () => onDelete(template) }
            : { label: t('deleteTitle'), icon: Trash2, onSelect: () => onDelete(template), destructive: true },
        ]
      : []),
  ]

  return (
    <Card className="flex flex-col">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">{template.meta.name}</CardTitle>
          <Badge variant={template.isBuiltin ? 'secondary' : 'outline'} className="shrink-0 gap-1">
            {template.isBuiltin && <Lock className="h-3 w-3" aria-hidden="true" />}
            {template.isBuiltin ? t('builtin') : t('custom')}
          </Badge>
        </div>
        <CardDescription className="line-clamp-3 min-w-0">{template.meta.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="default">{formatDifficultyLabel(template.difficulty?.level)}</Badge>
          {template.meta.tags.map((tag) => (
            <Badge key={tag} variant="outline">{tag}</Badge>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('settingsOverridden', { count: changeCount })}
          {template.mods.length > 0 && (
            <span className="ms-1 inline-flex items-center gap-1">
              <Package className="h-3 w-3" aria-hidden="true" />
              {t('modsCount', { count: template.mods.length })}
            </span>
          )}
        </p>
        <RowActions
          className="mt-auto pt-2"
          ariaLabel={t('actionsAria', { name: template.meta.name })}
          primary={
            <Button size="sm" variant="outline" onClick={() => onPreview(template)} className="flex-1">
              <Eye className="h-4 w-4" aria-hidden="true" />
              {t(canManage ? 'preview' : 'previewOnly')}
            </Button>
          }
          items={actions}
        />
      </CardContent>
    </Card>
  )
}
