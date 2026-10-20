import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Bookmark as BookmarkIcon, FolderOpen, Lock, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatBytes } from '@/lib/formatBytes'
import { cn } from '@/lib/utils'
import type { Bookmark, ProfileFiles, RootDescriptor, RootId } from '@/types/files'
import { unavailableText } from './filesUi'

// The left rail of Server Files (spec §A14.2): which server, which of its
// folders, shortcuts into them, and that folder's Trash. The rows look like
// the kit's SubNav (DESIGN.md): a tint, medium weight and a 2px start bar on
// the one that is open, styled from aria-current. On a phone the rail
// collapses into one Select (RootSelect) above the list, which holds the
// shortcuts and Trash too.

function sortedRoots(profile: ProfileFiles): RootDescriptor[] {
  const order: RootId[] = ['data', 'config', 'install', 'launch']
  return [...profile.roots].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
}

function visibleBookmarks(profile: ProfileFiles, roots: RootDescriptor[]): Bookmark[] {
  return profile.bookmarks.filter((bookmark) => roots.some((root) => root.id === bookmark.rootId && root.available))
}

const railItem = (active: boolean) =>
  cn(
    'group relative flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-start text-sm transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70',
    active ? 'bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground',
  )

function ActiveBar({ active }: { active: boolean }) {
  if (!active) return null
  return <span className="absolute start-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-primary" aria-hidden="true" />
}

function railIcon(active: boolean, extra?: string) {
  return cn('mt-0.5 h-4 w-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground', extra)
}

interface ServerPickerProps {
  profiles: ProfileFiles[]
  value: string | null
  onChange: (profileId: string) => void
}

/** Only rendered with more than one profile. */
export function ServerPicker({ profiles, value, onChange }: ServerPickerProps) {
  const { t } = useTranslation('files')
  if (profiles.length <= 1) return null
  return (
    <div className="space-y-1.5">
      <Label htmlFor="files-server-picker" className="label-micro">
        {t('page.serverPicker')}
      </Label>
      <Select value={value ?? undefined} onValueChange={onChange}>
        <SelectTrigger id="files-server-picker" className="min-h-11 sm:min-h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {profiles.map((profile) => (
            <SelectItem key={profile.id} value={profile.id}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{profile.name}</span>
                {profile.isActive && <Badge variant="success" className="px-1.5 py-0 text-[10px]">{t('page.activeBadge')}</Badge>}
                {profile.remote && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{t('roots.backend.sftp')}</Badge>}
                {!profile.remote && profile.roots.some((root) => root.backend === 'docker') && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{t('roots.backend.docker')}</Badge>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

const TRASH_VALUE = '__trash__'
const BOOKMARK_PREFIX = '__bookmark__:'

interface RootSelectProps {
  profile: ProfileFiles
  value: RootId | null
  trashOpen: boolean
  onChange: (rootId: RootId) => void
  onOpenBookmark: (bookmark: Bookmark) => void
  onOpenTrash: () => void
}

/** The phone layout's folder chooser: the folders, then the shortcuts, then this folder's Trash. */
export function RootSelect({ profile, value, trashOpen, onChange, onOpenBookmark, onOpenTrash }: RootSelectProps) {
  const { t } = useTranslation('files')
  const roots = sortedRoots(profile)
  const bookmarks = visibleBookmarks(profile, roots)
  const selected = roots.find((root) => root.id === value) ?? null

  const choose = (next: string) => {
    if (next === TRASH_VALUE) {
      if (!trashOpen) onOpenTrash()
      return
    }
    if (next.startsWith(BOOKMARK_PREFIX)) {
      const bookmark = bookmarks[Number(next.slice(BOOKMARK_PREFIX.length))]
      if (bookmark) onOpenBookmark(bookmark)
      return
    }
    onChange(next as RootId)
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="files-root-select" className="label-micro">
        {t('roots.heading')}
      </Label>
      <Select value={trashOpen && selected?.available ? TRASH_VALUE : value ?? undefined} onValueChange={choose}>
        <SelectTrigger id="files-root-select" className="min-h-11">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {roots.map((root) => (
              <SelectItem key={root.id} value={root.id} className="min-h-11">
                <span className="flex items-center gap-2">
                  {t(`roots.labels.${root.id}`)}
                  {!root.available && <Lock className="h-3 w-3 text-muted-foreground" aria-hidden="true" />}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
          {bookmarks.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel className="label-micro">{t('roots.bookmarks.heading')}</SelectLabel>
                {bookmarks.map((bookmark, index) => (
                  <SelectItem key={`${bookmark.rootId}:${bookmark.path}`} value={`${BOOKMARK_PREFIX}${index}`} className="min-h-11">
                    <span className="flex items-center gap-2">
                      <BookmarkIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                      {t(`roots.bookmarks.${bookmark.kind}`)}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          )}
          {selected?.available && (
            <>
              <SelectSeparator />
              <SelectItem value={TRASH_VALUE} className="min-h-11">
                <span className="flex items-center gap-2">
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  {t('roots.trash', { count: selected.trashItemCount ?? 0 })}
                </span>
              </SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  )
}

interface RootListProps {
  profile: ProfileFiles
  selectedRoot: RootId | null
  trashOpen: boolean
  onSelectRoot: (rootId: RootId) => void
  onOpenBookmark: (bookmark: Bookmark) => void
  onOpenTrash: () => void
}

function RailGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1', className)}>
      <p className="label-micro px-2.5">{label}</p>
      <ul className="space-y-px">{children}</ul>
    </div>
  )
}

/** The desktop rail: folders (path and free space under each name), shortcuts, Trash. */
export function RootList({ profile, selectedRoot, trashOpen, onSelectRoot, onOpenBookmark, onOpenTrash }: RootListProps) {
  const { t, i18n } = useTranslation('files')
  const roots = sortedRoots(profile)
  const selected = roots.find((root) => root.id === selectedRoot) ?? null
  const bookmarks = visibleBookmarks(profile, roots)

  return (
    <nav aria-label={t('roots.heading')} className="space-y-5">
      <RailGroup label={t('roots.heading')}>
        {roots.map((root) => {
          const active = root.id === selectedRoot && !trashOpen
          const facts = root.available
            ? [
                t(`roots.backend.${root.backend}`),
                root.freeBytes !== null && root.totalBytes !== null
                  ? t('roots.space', { free: formatBytes(root.freeBytes, i18n.language), total: formatBytes(root.totalBytes, i18n.language) })
                  : null,
              ].filter(Boolean).join(' · ')
            : null
          return (
            <li key={root.id}>
              <button type="button" onClick={() => onSelectRoot(root.id)} aria-current={active ? 'true' : undefined} className={railItem(active)}>
                <ActiveBar active={active} />
                {root.available ? (
                  <FolderOpen className={railIcon(active)} aria-hidden="true" />
                ) : (
                  <Lock className={railIcon(false)} aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{t(`roots.labels.${root.id}`)}</span>
                    {root.available && root.writable === false && (
                      <span title={root.readOnlyReason ? t(`roots.readOnlyReasons.${root.readOnlyReason}`) : undefined} className="inline-flex shrink-0">
                        <Lock className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                        <span className="sr-only">{t('roots.readOnly')}</span>
                      </span>
                    )}
                    {root.warnings.map((warning) => (
                      <span key={warning} title={t(`roots.warnings.${warning}`)} className="inline-flex shrink-0">
                        <AlertTriangle className="h-3 w-3 text-warning" aria-hidden="true" />
                        <span className="sr-only">{t(`roots.warnings.${warning}`)}</span>
                      </span>
                    ))}
                  </span>
                  {root.displayPath && (
                    <bdi dir="ltr" className="block truncate font-mono text-xs font-normal text-muted-foreground" title={root.displayPath}>
                      {root.displayPath}
                    </bdi>
                  )}
                  {facts && <span className="block truncate text-xs font-normal text-muted-foreground">{facts}</span>}
                  {!root.available && root.unavailableReason && (
                    <span className="line-clamp-3 block text-xs font-normal text-muted-foreground">
                      {unavailableText(root.unavailableReason, root.unavailableDetail)}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </RailGroup>

      {bookmarks.length > 0 && (
        <RailGroup label={t('roots.bookmarks.heading')}>
          {bookmarks.map((bookmark) => (
            <li key={`${bookmark.rootId}:${bookmark.path}`}>
              <button type="button" onClick={() => onOpenBookmark(bookmark)} title={bookmark.path} className={railItem(false)}>
                <BookmarkIcon className={railIcon(false)} aria-hidden="true" />
                <span className="min-w-0 truncate">{t(`roots.bookmarks.${bookmark.kind}`)}</span>
              </button>
            </li>
          ))}
        </RailGroup>
      )}

      {selected?.available && (
        <ul className="border-t border-border/50 pt-3">
          <li>
            <button type="button" onClick={onOpenTrash} aria-current={trashOpen ? 'true' : undefined} className={railItem(trashOpen)}>
              <ActiveBar active={trashOpen} />
              <Trash2 className={railIcon(trashOpen)} aria-hidden="true" />
              <span className="min-w-0 truncate">{t('roots.trash', { count: selected.trashItemCount ?? 0 })}</span>
            </button>
          </li>
        </ul>
      )}
    </nav>
  )
}
