import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { SimTemplateApplyResult } from '@/lib/api'

// The apply controls come in pieces so TemplatePreviewDialog can lay them out
// around its scrolling diff (2026-09 community report: with the whole dialog
// scrolling, Cancel/Apply Template sat below the fold even for a four-row
// diff at 1280x620, and pinning every piece under the diff left a landscape
// phone a 43px strip of diff):
//  - TemplateApplyWarning: why Apply is disabled; first thing in the body,
//    so it's seen on open rather than after scrolling a long diff;
//  - TemplateApplyScope: what Apply writes; last thing in the body, after
//    the changes it scopes;
//  - TemplateApplyOutcome: the failure or success of the last Apply, pinned
//    right above the buttons so the click shows its result;
//  - TemplateApplyFooter: Cancel / Apply Template, pinned.
// Each renders nothing for a viewer; once the template has been applied only
// the outcome is left, as with the single panel this used to be.

export function TemplateApplyWarning({ running, canManage, applied }: { running: boolean | null; canManage: boolean; applied: boolean }) {
  const { t } = useTranslation('templateApplyPanel')
  if (!canManage || applied || running === false) return null

  return (
    <Alert variant="warning">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{running ? t('serverRunning') : t('serverStateUnavailable')}</AlertTitle>
      <AlertDescription>
        {running
          ? t('stopBeforeApplying')
          : t('confirmStoppedRetry')}
      </AlertDescription>
    </Alert>
  )
}

interface TemplateApplyScopeProps {
  scopeIni: boolean
  scopeSandbox: boolean
  onScopeIniChange: (v: boolean) => void
  onScopeSandboxChange: (v: boolean) => void
  canManage: boolean
  applied: boolean
}

export function TemplateApplyScope({
  scopeIni,
  scopeSandbox,
  onScopeIniChange,
  onScopeSandboxChange,
  canManage,
  applied,
}: TemplateApplyScopeProps) {
  const { t } = useTranslation('templateApplyPanel')
  if (!canManage || applied) return null

  return (
    <div className="flex flex-wrap items-center gap-5 border-t border-border/50 pt-3">
      <div className="flex items-center gap-2">
        <Checkbox id="scope-sandbox" checked={scopeSandbox} onCheckedChange={(v) => onScopeSandboxChange(v === true)} />
        <Label htmlFor="scope-sandbox" className="text-sm font-normal">{t('applySandboxChanges')}</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="scope-ini" checked={scopeIni} onCheckedChange={(v) => onScopeIniChange(v === true)} />
        <Label htmlFor="scope-ini" className="text-sm font-normal">{t('applyIniChanges')}</Label>
      </div>
    </div>
  )
}

interface TemplateApplyOutcomeProps {
  applyError: string | null
  applyResult: SimTemplateApplyResult | null
  canManage: boolean
}

export function TemplateApplyOutcome({ applyError, applyResult, canManage }: TemplateApplyOutcomeProps) {
  const { t } = useTranslation('templateApplyPanel')
  if (!canManage) return null

  if (applyResult) {
    return (
      <Alert variant="success">
        <CheckCircle2 className="h-4 w-4" />
        <AlertTitle>{t('appliedTitle')}</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>
            {applyResult.ini ? t('iniKeysUpdated', { count: applyResult.ini.appliedKeys.length }) : ''}
            {applyResult.sandbox && 'applied' in applyResult.sandbox
              ? t('sandboxSettingsUpdated', { count: applyResult.sandbox.applied.length })
              : ''}
            {applyResult.backups.length > 0 && t('backupFilesCreated', { count: applyResult.backups.length })}
          </p>
          <p className="font-medium">{t('effectNextRestart')}</p>
        </AlertDescription>
      </Alert>
    )
  }

  if (!applyError) return null
  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{t('applyFailedTitle')}</AlertTitle>
      <AlertDescription className="[overflow-wrap:anywhere]">{applyError}</AlertDescription>
    </Alert>
  )
}

interface TemplateApplyFooterProps {
  running: boolean | null
  scopeIni: boolean
  scopeSandbox: boolean
  applying: boolean
  applied: boolean
  canManage: boolean
  canApply: boolean
  onApply: () => void
  onClose: () => void
}

export function TemplateApplyFooter({
  running,
  scopeIni,
  scopeSandbox,
  applying,
  applied,
  canManage,
  canApply,
  onApply,
  onClose,
}: TemplateApplyFooterProps) {
  const { t } = useTranslation('templateApplyPanel')
  if (!canManage || applied) return null

  return (
    <DialogFooter className="gap-2 sm:space-x-0">
      <Button variant="outline" onClick={onClose} disabled={applying}>
        {t('cancel')}
      </Button>
      <Button onClick={onApply} disabled={applying || running !== false || !canApply || (!scopeIni && !scopeSandbox)}>
        {applying && <Loader2 className="h-4 w-4 animate-spin" />}
        {t('applyTemplate')}
      </Button>
    </DialogFooter>
  )
}
