import { useTranslation } from 'react-i18next'
import { Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/DisabledReason'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useUnsavedChangesGuard } from '@/contexts/UnsavedChangesContext'
import { usePageShortcut } from '@/hooks/useKeyboardShortcuts'
import { cn } from '@/lib/utils'

export interface SaveBarProps {
  dirty: boolean
  saving: boolean
  onSave: () => void
  /** Puts the form back to what was saved. Without it, no Discard button. */
  onDiscard?: () => void
  /** How many fields changed, when the page knows. */
  changeCount?: number
  /** Why Save can't run yet ("Fix the 2 invalid values first"). */
  disabledReason?: string
  /** The page's own Save wording, so its tests keep their accessible name. */
  saveLabel?: string
  className?: string
}

/**
 * The one save affordance of a form: a bar that sticks to the bottom of the
 * page while there are unsaved edits ("Unsaved changes · Discard · Save"),
 * with Ctrl/Cmd+S. It registers the unsaved-changes guard itself, so a page
 * that renders it gets the leave-page prompt for free. Render it as the
 * page's last child so `sticky` holds for the whole page.
 */
export function SaveBar({ dirty, saving, onSave, onDiscard, changeCount, disabledReason, saveLabel, className }: SaveBarProps) {
  const { t } = useTranslation('shell')
  useUnsavedChangesGuard(dirty)
  const canSave = dirty && !saving && !disabledReason

  usePageShortcut('s', () => {
    if (canSave) onSave()
  }, { ctrl: true })

  if (!dirty && !saving) return null

  const message = changeCount && changeCount > 0
    ? t('saveBar.changeCount', { count: changeCount })
    : t('saveBar.unsaved')

  return (
    <div className={cn('pointer-events-none sticky bottom-4 z-30 mt-6 flex justify-center', className)}>
      <div className="pointer-events-auto flex w-full max-w-2xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warning/40 bg-card px-4 py-2.5 shadow-[0_10px_30px_-12px_hsl(0_0%_0%/0.7)]">
        <p role="status" className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-foreground">
          <span className="h-2 w-2 shrink-0 rounded-full bg-warning" aria-hidden="true" />
          <span className="truncate">{saving ? t('saveBar.saving') : message}</span>
        </p>
        <div className="ms-auto flex items-center gap-2">
          {onDiscard && (
            <Button type="button" variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
              {t('saveBar.discard')}
            </Button>
          )}
          <TooltipProvider delayDuration={150}>
            <DisabledReason reason={dirty && !saving ? disabledReason : undefined}>
              <Button
                type="button"
                variant="command"
                size="sm"
                onClick={onSave}
                disabled={!canSave}
                aria-keyshortcuts="Control+S Meta+S"
              >
                {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
                {saveLabel ?? t('saveBar.save')}
              </Button>
            </DisabledReason>
          </TooltipProvider>
        </div>
      </div>
    </div>
  )
}
