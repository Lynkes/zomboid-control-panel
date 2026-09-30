import { useTranslation } from 'react-i18next'
import { AlertTriangle, Bookmark as BookmarkIcon, FolderCog, FolderOpen, Lock, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { HelpTip } from '@/components/HelpTip'
import { formatBytes } from '@/lib/formatBytes'
import { cn } from '@/lib/utils'
import { isolateLtrForRtl } from '@/lib/paramTranslation'
import type { Bookmark, ProfileFiles, RootDescriptor, RootId } from '@/types/files'

// The left column of Server Files (spec §A14.2): which server, which of its
// folders, shortcuts into them, and that folder's Trash. On a phone the
// folders collapse into one Select (RootSelect) above the list.

function sortedRoots(profile: ProfileFiles): RootDescriptor[] {
  const order: RootId[] = ['data', 'config', 'install', 'launch']
  return [...profile.roots].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
}

function BackendBadge({ root }: { root: RootDescriptor }) {
  const { t } = useTranslation('files')
  return (
    <Badge variant="secondary" className="shrink-0 px-2 py-0 text-[10px] font-medium">
      {t(`roots.backend.${root.backend}`)}
    </Badge>
  )
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
      <Label htmlFor="files-server-picker" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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

interface RootSelectProps {
  profile: ProfileFiles
  value: RootId | null
  onChange: (rootId: RootId) => void
}

/** The phone layout's folder chooser. */
export function RootSelect({ profile, value, onChange }: RootSelectProps) {
  const { t } = useTranslation('files')
  return (
    <div className="space-y-1.5">
      <Label htmlFor="files-root-select" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t('roots.heading')}
      </Label>
      <Select value={value ?? undefined} onValueChange={(next) => onChange(next as RootId)}>
        <SelectTrigger id="files-root-select" className="min-h-11">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {sortedRoots(profile).map((root) => (
            <SelectItem key={root.id} value={root.id}>
              <span className="flex items-center gap-2">
                {t(`roots.labels.${root.id}`)}
                {!root.available && <Lock className="h-3 w-3 text-muted-foreground" aria-hidden="true" />}
              </span>
            </SelectItem>
          ))}
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
  onSetRemoteFolders: () => void
  /** Hide the folder cards (the phone layout shows RootSelect instead). */
  compact?: boolean
}

export function RootList({
  profile,
  selectedRoot,
  trashOpen,
  onSelectRoot,
  onOpenBookmark,
  onOpenTrash,
  onSetRemoteFolders,
  compact = false,
}: RootListProps) {
  const { t, i18n } = useTranslation('files')
  const roots = sortedRoots(profile)
  const selected = roots.find((root) => root.id === selectedRoot) ?? null
  const bookmarks = profile.bookmarks.filter((bookmark) => roots.some((root) => root.id === bookmark.rootId && root.available))

  return (
    <div className="space-y-4">
      {!compact && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('roots.heading')}</p>
          <ul className="space-y-2">
            {roots.map((root) => {
              const isSelected = root.id === selectedRoot
              return (
                <li key={root.id}>
                  <button
                    type="button"
                    onClick={() => onSelectRoot(root.id)}
                    aria-current={isSelected && !trashOpen ? 'true' : undefined}
                    className={cn(
                      'w-full rounded-lg border p-3 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isSelected && !trashOpen
                        ? 'border-primary/50 bg-primary/10'
                        : 'border-border/60 bg-muted/25 hover:bg-muted/50',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <FolderOpen className={cn('h-4 w-4 shrink-0', root.available ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{t(`roots.labels.${root.id}`)}</span>
                      <BackendBadge root={root} />
                    </span>
                    {root.displayPath && (
                      <span className="mt-1 block truncate text-xs text-muted-foreground" title={root.displayPath}>
                        <bdi dir="ltr" className="font-mono">{root.displayPath}</bdi>
                      </span>
                    )}
                    {root.available ? (
                      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {root.freeBytes !== null && root.totalBytes !== null && (
                          <span className="text-xs text-muted-foreground">
                            {t('roots.space', { free: formatBytes(root.freeBytes, i18n.language), total: formatBytes(root.totalBytes, i18n.language) })}
                          </span>
                        )}
                        {root.writable === false && (
                          <Badge variant="outline" className="px-1.5 py-0 text-[10px]" title={root.readOnlyReason ? t(`roots.readOnlyReasons.${root.readOnlyReason}`) : undefined}>
                            <Lock className="me-1 h-3 w-3" aria-hidden="true" />
                            {t('roots.readOnly')}
                          </Badge>
                        )}
                        {root.warnings.map((warning) => (
                          <Badge key={warning} variant="outline" className="border-warning/50 px-1.5 py-0 text-[10px] text-warning" title={t(`roots.warnings.${warning}`)}>
                            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                            <span className="sr-only">{t(`roots.warnings.${warning}`)}</span>
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      root.unavailableReason && (
                        <span className="mt-1.5 block text-xs text-muted-foreground">
                          {t(`roots.unavailable.${root.unavailableReason}`, { detail: root.unavailableDetail ?? '' })}
                        </span>
                      )
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {profile.remote && (
        <p className="text-xs text-muted-foreground">
          {t('page.sftpConnected', {
            host: isolateLtrForRtl(profile.remote.host),
            port: profile.remote.port,
            user: isolateLtrForRtl(profile.remote.username),
          })}
        </p>
      )}

      {profile.remote && (
        <Button variant="outline" size="sm" className="w-full" onClick={onSetRemoteFolders}>
          <FolderCog aria-hidden="true" />
          {t('roots.setRemoteFolders')}
        </Button>
      )}

      {bookmarks.length > 0 && (
        <div className="space-y-2 border-t border-border/40 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('roots.bookmarks.heading')}</p>
          <ul className="flex flex-wrap gap-2 md:flex-col md:gap-1">
            {bookmarks.map((bookmark) => (
              <li key={`${bookmark.rootId}:${bookmark.path}`}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2 px-2 font-normal"
                  onClick={() => onOpenBookmark(bookmark)}
                  title={bookmark.path}
                >
                  <BookmarkIcon className="text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{t(`roots.bookmarks.${bookmark.kind}`)}</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {selected?.available && (
        <div className="border-t border-border/40 pt-3">
          <Button
            variant={trashOpen ? 'secondary' : 'ghost'}
            size="sm"
            className="w-full justify-start gap-2 px-2"
            onClick={onOpenTrash}
            aria-pressed={trashOpen}
          >
            <Trash2 className="text-muted-foreground" aria-hidden="true" />
            {t('roots.trash', { count: selected.trashItemCount ?? 0 })}
          </Button>
          {selected.writable === false && selected.readOnlyReason && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="h-3 w-3" aria-hidden="true" />
              {t('roots.readOnly')}
              <HelpTip label={t('roots.readOnly')}>{t(`roots.readOnlyReasons.${selected.readOnlyReason}`)}</HelpTip>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
