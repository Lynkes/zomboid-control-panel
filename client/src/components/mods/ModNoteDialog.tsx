import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Trash2 } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { ModNote } from '@/lib/api'
import { useDateFormat } from '@/lib/dateFormat'
import { getUserErrorMessage } from '@/lib/errorMessage'

/** The server's limit (MOD_NOTE_LIMITS.textMax). */
export const MOD_NOTE_MAX = 1000

export interface ModNoteDialogProps {
  /** The mod's display name, for the description. */
  name: string
  note: ModNote | undefined
  /** False without mods.manage: the note is shown, not edited. */
  canEdit: boolean
  /** Saves the text; an empty text deletes the note. A rejection is shown in the dialog. */
  onSave: (text: string) => Promise<void>
  onClose: () => void
}

/**
 * Add, edit or delete the note on one Workshop item. Every admin of the panel
 * sees the same notes. Mount it only while open: the field starts from `note`.
 */
export function ModNoteDialog({ name, note, canEdit, onSave, onClose }: ModNoteDialogProps) {
  const { t } = useTranslation('mods')
  const { formatDate } = useDateFormat()
  const [text, setText] = useState(note?.text ?? '')
  const [saving, setSaving] = useState<'save' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const trimmed = text.trim()
  const changed = trimmed !== (note?.text ?? '').trim()

  const run = async (kind: 'save' | 'delete', value: string) => {
    setSaving(kind)
    setError(null)
    try {
      await onSave(value)
    } catch (err) {
      setError(getUserErrorMessage(err, t('notes.saveFailedFallback')))
      setSaving(null)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{note ? t('notes.editTitle') : t('notes.addTitle')}</DialogTitle>
          <DialogDescription>{t('notes.dialogDesc', { name })}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-2">
          <Label htmlFor="mod-note-text">{t('notes.label')}</Label>
          <Textarea
            id="mod-note-text"
            value={text}
            onChange={(event) => setText(event.target.value.slice(0, MOD_NOTE_MAX))}
            placeholder={t('notes.placeholder')}
            maxLength={MOD_NOTE_MAX}
            readOnly={!canEdit}
            autoFocus={canEdit}
            className="min-h-32"
            aria-describedby="mod-note-meta"
          />
          <div id="mod-note-meta" className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {note?.updatedAt
                ? note.updatedBy
                  ? t('notes.lastEdited', { name: note.updatedBy, date: formatDate(note.updatedAt) })
                  : t('notes.lastEditedNoName', { date: formatDate(note.updatedAt) })
                : t('notes.sharedHint')}
            </span>
            <span className="tabular-nums">{t('notes.counter', { count: text.length, max: MOD_NOTE_MAX })}</span>
          </div>
          {error && (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="gap-2">
          {canEdit && note && (
            <Button variant="ghost" className="me-auto text-destructive hover:text-destructive" onClick={() => void run('delete', '')} disabled={saving !== null}>
              {saving === 'delete' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
              {t('notes.delete')}
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={saving !== null}>
            {canEdit ? t('notes.cancel') : t('notes.close')}
          </Button>
          {canEdit && (
            <Button onClick={() => void run('save', trimmed)} disabled={saving !== null || !changed || (!trimmed && !note)}>
              {saving === 'save' && <Loader2 className="animate-spin" aria-hidden="true" />}
              {t('notes.save')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
