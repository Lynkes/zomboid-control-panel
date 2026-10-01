import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NAME_RULE_REASONS, type NameRuleReason } from '@/types/files'
import { validateName } from './nameRules'
import { describeFilesError, errorCodeOf, errorParamsOf, splitExtension } from './filesUi'

function isNameRuleReason(value: unknown): value is NameRuleReason {
  return typeof value === 'string' && (NAME_RULE_REASONS as readonly string[]).includes(value)
}

// On a phone every Server Files dialog takes the whole screen (spec §A14.2).
export const MOBILE_FULL_SCREEN = 'max-sm:h-[100dvh] max-sm:max-h-[100dvh] max-sm:w-screen max-sm:max-w-none max-sm:rounded-none'

interface NameDialogProps {
  open: boolean
  title: string
  label: string
  description?: string
  initialValue: string
  submitLabel: string
  /** Rename: the unchanged name can't be submitted. */
  requireChange?: boolean
  onCancel: () => void
  /** Throws to keep the dialog open with the error shown under the field. */
  onSubmit: (name: string) => Promise<void>
}

// One dialog for every "type a name" step: new file, new folder, rename,
// duplicate and restore-as. The name is checked with the same rules the
// server uses (nameRules.ts) while typing, and a refusal from the server
// stays in the dialog so the operator can fix it without starting over.
export function NameDialog({
  open,
  title,
  label,
  description,
  initialValue,
  submitLabel,
  requireChange = false,
  onCancel,
  onSubmit,
}: NameDialogProps) {
  const { t } = useTranslation('files')
  const [value, setValue] = useState(initialValue)
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setValue(initialValue)
    setTouched(false)
    setBusy(false)
    setServerError(null)
  }, [open, initialValue])

  const validation = validateName(value, { isNew: true })
  const ruleError = !validation.ok && (touched || value !== '') ? t(`nameRules.${validation.reason}`) : null
  const unchanged = requireChange && value === initialValue
  const canSubmit = validation.ok && !unchanged && !busy

  const submit = async () => {
    setTouched(true)
    if (!canSubmit) return
    setBusy(true)
    setServerError(null)
    try {
      await onSubmit(value)
    } catch (error) {
      const code = errorCodeOf(error)
      const reason = errorParamsOf(error).reason
      if ((code === 'FM_INVALID_NAME' || code === 'FM_INVALID_PATH') && isNameRuleReason(reason)) {
        setServerError(t(`nameRules.${reason}`))
      } else {
        setServerError(describeFilesError(error))
      }
    } finally {
      setBusy(false)
    }
  }

  const errorText = ruleError ?? serverError

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel() }}>
      <DialogContent
        className={MOBILE_FULL_SCREEN}
        onOpenAutoFocus={(event) => {
          // Focus the field with the base name selected, so typing replaces
          // "config" and keeps ".ini".
          event.preventDefault()
          const input = inputRef.current
          if (!input) return
          input.focus()
          const { base } = splitExtension(initialValue)
          input.setSelectionRange(0, initialValue ? base.length : 0)
        }}
      >
        <DialogHeader>
          {/* The title quotes the file name ("Rename {name}"); DialogTitle
              wraps it anywhere, so a long unbroken name wraps instead of
              widening the dialog. */}
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Label htmlFor="files-name-input">{label}</Label>
          <Input
            id="files-name-input"
            ref={inputRef}
            dir="ltr"
            value={value}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setValue(event.target.value)
              setServerError(null)
            }}
            onBlur={() => setTouched(true)}
            aria-invalid={errorText ? true : undefined}
            aria-describedby={errorText ? 'files-name-error' : undefined}
            className="min-h-11 font-mono sm:min-h-9"
          />
          {errorText && (
            <p id="files-name-error" role="alert" className="mt-1 text-xs text-destructive [overflow-wrap:anywhere]">{errorText}</p>
          )}
          <DialogFooter className="gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
              {t('actions.cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
