import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { StickyNote } from 'lucide-react'
import type { ModGroup, ModNote } from '@/lib/api'
import { groupDotClass } from '@/lib/modGroupTools'
import { cn } from '@/lib/utils'

/**
 * A row's group membership: one colour dot per group (three at most, then
 * "+n"). The names are in the hover title and, for screen readers, in the
 * text. A plain title, not a Radix Tooltip: this renders once per row of a
 * 600-mod list.
 */
export const GroupDots = memo(function GroupDots({ groups, max = 3, className }: { groups: readonly ModGroup[]; max?: number; className?: string }) {
  const { t } = useTranslation('modGroups')
  if (groups.length === 0) return null
  const label = t('dots.inGroups', { names: groups.map((group) => group.name).join(', ') })
  const extra = groups.length - max
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-0.5', className)} title={label} data-group-dots="">
      {groups.slice(0, max).map((group) => (
        <span key={group.id} className={cn('h-2 w-2 rounded-full', groupDotClass(group.color))} aria-hidden="true" />
      ))}
      {extra > 0 && <span className="ms-0.5 text-[10px] tabular-nums text-muted-foreground" aria-hidden="true">+{extra}</span>}
      <span className="sr-only">{label}</span>
    </span>
  )
})

/** One group's dot, for a header or a menu item. */
export function GroupDot({ color, className }: { color: string | null | undefined; className?: string }) {
  return <span className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', groupDotClass(color), className)} aria-hidden="true" />
}

/** The note icon on a row that has one: hover shows the note, a click opens it. */
export const NoteIndicator = memo(function NoteIndicator({ note, onOpen }: { note: ModNote | undefined; onOpen?: () => void }) {
  const { t } = useTranslation('mods')
  if (!note?.text) return null
  const preview = note.text.length > 240 ? `${note.text.slice(0, 240)}…` : note.text
  const label = t('notes.indicatorAria', { text: preview })
  const icon = <StickyNote className="h-3.5 w-3.5" aria-hidden="true" />
  if (!onOpen) {
    return (
      <span className="inline-flex shrink-0 text-info" title={preview} role="img" aria-label={label}>
        {icon}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onOpen()
      }}
      title={preview}
      aria-label={label}
      className="inline-flex shrink-0 rounded p-0.5 text-info transition-colors hover:bg-info/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {icon}
    </button>
  )
})
