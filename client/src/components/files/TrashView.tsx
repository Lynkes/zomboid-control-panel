import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Loader2, RotateCcw, Trash2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/EmptyState'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/contexts/ConfirmContext'
import { baseName, filesApi, waitForJob } from '@/lib/filesApi'
import { formatBytes } from '@/lib/formatBytes'
import { isolateLtrForRtl } from '@/lib/paramTranslation'
import type { ConfirmToken, JobResponse, RootDescriptor, TrashItem } from '@/types/files'
import type { RunConfirmed } from './FileEditorDialog'
import { NameDialog } from './NameDialog'
import { describeFilesError, describeResultError, errorCodeOf, formatFileDate, rootIsWritable } from './filesUi'

interface TrashViewProps {
  profileId: string
  root: RootDescriptor
  isDesktop: boolean
  runConfirmed: RunConfirmed
  onBack: () => void
  /** Something was restored or removed: refresh the listing and the count. */
  onChanged: () => void
}

type JobLine = { state: 'running'; done: number; total: number | null } | { state: 'done' } | { state: 'failed'; error: string }

function withPermanent(tokens: ConfirmToken[]): ConfirmToken[] {
  // 'permanent' always; any extra token the server asked for (serverRunning)
  // rides along.
  return ['permanent', ...tokens.filter((token) => token !== 'permanent')]
}

// The per-root Trash (spec §A14.3): what was deleted, replaced or saved over,
// by whom and when, and when the panel will remove it. Restore puts an item
// back where it was (or under another name if that's taken); deleting from
// here is permanent and typed-confirmed like any other permanent delete.
export function TrashView({ profileId, root, isDesktop, runConfirmed, onBack, onChanged }: TrashViewProps) {
  const { t, i18n } = useTranslation('files')
  const { toast } = useToast()
  const confirm = useConfirm()
  const [items, setItems] = useState<TrashItem[] | null>(null)
  const [totalBytes, setTotalBytes] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [job, setJob] = useState<JobLine | null>(null)
  const [restoreAs, setRestoreAs] = useState<TrashItem | null>(null)
  const writable = rootIsWritable(root)

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null)
    try {
      const result = await filesApi.trashList(profileId, { root: root.id }, signal)
      if (signal?.aborted) return
      setItems([...result.items].sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt)))
      setTotalBytes(result.totalBytes)
    } catch (err) {
      if (signal?.aborted) return
      setItems([])
      setError(describeFilesError(err))
    }
  }, [profileId, root.id])

  useEffect(() => {
    const controller = new AbortController()
    setItems(null)
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const restore = async (item: TrashItem, name?: string) => {
    setBusyId(item.trashId)
    try {
      // Restoring is a write like any other: into the install folder, or a
      // file that runs as code, the server asks for a confirmation first.
      const confirmed = await runConfirmed((tokens) =>
        filesApi.trashRestore(profileId, { root: root.id, trashId: item.trashId, restoreAs: name, confirm: tokens }),
      )
      if (!confirmed.ok) return
      const result = confirmed.value
      toast({ title: t('trash.restored', { path: isolateLtrForRtl(result.entry.path) }) })
      setRestoreAs(null)
      await load()
      onChanged()
    } catch (err) {
      if (!name && errorCodeOf(err) === 'FM_EXISTS') {
        setRestoreAs(item)
        return
      }
      if (name) throw err
      toast({ variant: 'destructive', title: describeFilesError(err) })
    } finally {
      setBusyId(null)
    }
  }

  const runPurge = async (body: { trashIds?: string[]; all?: true; typedConfirmation: string }) => {
    const result = await runConfirmed((tokens) =>
      filesApi.trashPurge(profileId, { root: root.id, ...body, confirm: withPermanent(tokens) }),
    )
    if (!result.ok) return
    setJob({ state: 'running', done: 0, total: null })
    const final: JobResponse = await waitForJob(result.value.jobId, (progress) => {
      if (progress.state === 'running') setJob({ state: 'running', done: progress.progress.done, total: progress.progress.total })
    })
    if (final.state === 'done') setJob({ state: 'done' })
    else setJob({ state: 'failed', error: describeResultError(final.error) })
    await load()
    onChanged()
  }

  const deleteOne = async (item: TrashItem) => {
    const name = baseName(item.originalPath)
    const ok = await confirm({
      title: t('confirm.title'),
      description: t('confirm.deletePermanent', { count: 1, name: isolateLtrForRtl(name), size: formatBytes(item.bytes, i18n.language) }),
      confirmLabel: t('actions.deletePermanently'),
      cancelLabel: t('actions.cancel'),
      destructive: true,
      requireTypedConfirmation: { value: name, label: t('confirm.typeName', { value: name }) },
    })
    if (!ok) return
    setBusyId(item.trashId)
    try {
      await runPurge({ trashIds: [item.trashId], typedConfirmation: name })
    } catch (err) {
      toast({ variant: 'destructive', title: describeFilesError(err) })
    } finally {
      setBusyId(null)
    }
  }

  const emptyTrash = async () => {
    if (!items || items.length === 0) return
    const count = String(items.length)
    const ok = await confirm({
      title: t('confirm.title'),
      description: t('confirm.emptyTrash', { count: items.length }),
      confirmLabel: t('actions.emptyTrash'),
      cancelLabel: t('actions.cancel'),
      destructive: true,
      requireTypedConfirmation: { value: count, label: t('confirm.typeName', { value: count }) },
    })
    if (!ok) return
    setBusyId('*')
    try {
      await runPurge({ all: true, typedConfirmation: count })
    } catch (err) {
      toast({ variant: 'destructive', title: describeFilesError(err) })
    } finally {
      setBusyId(null)
    }
  }

  const jobText = job === null ? null
    : job.state === 'running'
      ? job.total !== null ? t('jobs.deleting', { done: job.done, total: job.total }) : t('jobs.deletingUnknown', { done: job.done })
      : job.state === 'done' ? t('jobs.done') : t('jobs.failed', { error: job.error })

  const actions = (item: TrashItem) => (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {writable && (
        <Button variant="outline" size="sm" onClick={() => void restore(item)} disabled={busyId !== null}>
          {busyId === item.trashId ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
          {t('actions.restore')}
        </Button>
      )}
      {writable && (
        <Button
          variant="ghost"
          size="iconDense"
          onClick={() => void deleteOne(item)}
          disabled={busyId !== null}
          aria-label={`${t('actions.deletePermanently')}: ${item.originalPath}`}
          className="text-destructive hover:text-destructive"
        >
          <XCircle aria-hidden="true" />
        </Button>
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ms-2">
          <ArrowLeft className="rtl:-scale-x-100" aria-hidden="true" />
          {t(`roots.labels.${root.id}`)}
        </Button>
        <h2 className="me-auto text-sm font-medium">{t('trash.title')}</h2>
        {items && items.length > 0 && (
          <span className="text-xs text-muted-foreground">{formatBytes(totalBytes, i18n.language)}</span>
        )}
        {writable && items && items.length > 0 && (
          <Button variant="destructive" size="sm" onClick={() => void emptyTrash()} disabled={busyId !== null}>
            {busyId === '*' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
            {t('actions.emptyTrash')}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('trash.description')}</p>
      {jobText && <p aria-live="polite" className="text-sm text-muted-foreground">{jobText}</p>}

      {items === null ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      ) : error ? (
        <EmptyState type="noData" compact title={error} action={{ label: t('actions.retry'), onClick: () => void load() }} />
      ) : items.length === 0 ? (
        <EmptyState type="empty" compact title={t('trash.empty')} />
      ) : isDesktop ? (
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 text-start font-medium">{t('trash.columns.originalPath')}</th>
                <th scope="col" className="px-3 py-2 text-start font-medium">{t('trash.columns.deletedBy')}</th>
                <th scope="col" className="px-3 py-2 text-start font-medium">{t('trash.columns.deletedAt')}</th>
                <th scope="col" className="px-3 py-2 text-end font-medium">{t('trash.columns.size')}</th>
                <th scope="col" className="px-3 py-2 text-start font-medium">{t('trash.columns.reason')}</th>
                <th scope="col" className="px-3 py-2"><span className="sr-only">{t('list.columns.actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.trashId} className="border-t border-border/40 align-top">
                  <td className="max-w-[18rem] px-3 py-2">
                    <bdi dir="ltr" className="block truncate font-mono text-xs" title={item.originalPath}>{item.originalPath}</bdi>
                    <span className="text-xs text-muted-foreground">{t('trash.expires', { date: formatFileDate(item.expiresAt, i18n.language) })}</span>
                  </td>
                  <td className="px-3 py-2">{item.deletedBy.username ? <bdi dir="ltr">{item.deletedBy.username}</bdi> : '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatFileDate(item.deletedAt, i18n.language)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-end tabular-nums">{formatBytes(item.bytes, i18n.language)}</td>
                  <td className="px-3 py-2">{t(`trash.reasons.${item.reason}`)}</td>
                  <td className="px-3 py-2">{actions(item)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.trashId} className="space-y-1 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm">
              <bdi dir="ltr" className="block break-all font-mono text-xs">{item.originalPath}</bdi>
              <p className="text-xs text-muted-foreground">
                {[t(`trash.reasons.${item.reason}`), formatBytes(item.bytes, i18n.language), formatFileDate(item.deletedAt, i18n.language), item.deletedBy.username]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <p className="text-xs text-muted-foreground">{t('trash.expires', { date: formatFileDate(item.expiresAt, i18n.language) })}</p>
              {actions(item)}
            </li>
          ))}
        </ul>
      )}

      {restoreAs && (
        <NameDialog
          open
          title={t('dialogs.restoreAs.title')}
          description={t('dialogs.restoreAs.description', { name: isolateLtrForRtl(baseName(restoreAs.originalPath)) })}
          label={t('dialogs.restoreAs.nameLabel')}
          initialValue={baseName(restoreAs.originalPath)}
          submitLabel={t('actions.restore')}
          requireChange
          onCancel={() => setRestoreAs(null)}
          onSubmit={(name) => restore(restoreAs, name)}
        />
      )}
    </div>
  )
}
