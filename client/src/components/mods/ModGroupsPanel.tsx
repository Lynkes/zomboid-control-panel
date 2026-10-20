import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ChevronRight,
  Download,
  ListOrdered,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react'
import { DisabledReason } from '@/components/DisabledReason'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/contexts/ConfirmContext'
import { modsApi, type ModGroup, type ModGroupInput, type ModGroupsStatus } from '@/lib/api'
import { reportClientWarning } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useLocalStorageState } from '@/lib/modsShared'
import {
  buildGroupDocument,
  downloadJsonFile,
  groupExportFileName,
  parseGroupDocument,
} from '@/lib/modGroups'
import { ModGroupDialog } from './ModGroupDialog'

// How many mod IDs a group row (or the Apply confirmation) names before it
// says "+N more".
const LISTED_IDS = 3
const LISTED_MOVES = 12

type Editor = { group: ModGroup | null }

export interface ModGroupsPanelProps {
  /** mods.manage. Without it the panel only lists and exports. */
  canManage: boolean
  /** The mods enabled on the active server, in the order the Load order tab shows them. */
  serverModIds: readonly string[]
  /** Mod ID to display name, for the member list. */
  modNames: Readonly<Record<string, string>>
  /**
   * The Mods= order saved in the server INI. The groups' in-order status is
   * read again whenever it changes (a save, an Apply, a mod toggled elsewhere).
   */
  savedModIds: readonly string[] | undefined
  /** Unsaved changes in the Load order list: Apply works on the saved order, so it waits. */
  orderDirty: boolean
  /** The Load order list is being saved. */
  orderSaving: boolean
  /** Called after Apply wrote a new order, so the page reloads the list. */
  onOrderApplied: () => void | Promise<void>
}

/**
 * "Mod groups" on the Mod Manager's Load order tab: named, ordered lists of
 * mods that must load in one fixed order, shared by every admin of the panel.
 * The server keeps them in order whenever the load order is saved (while
 * "Keep group order" is on) and can apply them on demand (Apply group order).
 * Create / edit lives in ModGroupDialog.
 */
export function ModGroupsPanel({
  canManage,
  serverModIds,
  modNames,
  savedModIds,
  orderDirty,
  orderSaving,
  onOrderApplied,
}: ModGroupsPanelProps) {
  const { t } = useTranslation('modGroups')
  const { toast } = useToast()
  const confirm = useConfirm()
  const [open, setOpen] = useLocalStorageState('zcp:mods:groupsPanelOpen', true)
  const [groups, setGroups] = useState<ModGroup[]>([])
  const [enforce, setEnforce] = useState(false)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [status, setStatus] = useState<ModGroupsStatus | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [applying, setApplying] = useState(false)
  const [savingEnforce, setSavingEnforce] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const applyingRef = useRef(false)
  const aliveRef = useRef(true)
  const groupsSeq = useRef(0)
  const statusSeq = useRef(0)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const loadGroups = useCallback(async () => {
    const seq = ++groupsSeq.current
    try {
      const data = await modsApi.getGroups()
      if (!aliveRef.current || seq !== groupsSeq.current) return
      setGroups(Array.isArray(data?.groups) ? data.groups : [])
      setEnforce(data?.enforce === true)
      setLoadState('ready')
    } catch (error) {
      if (!aliveRef.current || seq !== groupsSeq.current) return
      reportClientWarning('Failed to load mod groups.', error)
      setLoadState('error')
    }
  }, [])

  const loadStatus = useCallback(async () => {
    const seq = ++statusSeq.current
    try {
      const data = await modsApi.getGroupsStatus()
      if (!aliveRef.current || seq !== statusSeq.current) return
      setStatus(data && Array.isArray(data.groups) ? data : null)
    } catch (error) {
      if (!aliveRef.current || seq !== statusSeq.current) return
      // The list still works without the in-order badges.
      reportClientWarning('Failed to load the mod groups status.', error)
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void loadGroups()
  }, [loadGroups])

  // Read again whenever the saved load order changes: a save, an Apply, a mod
  // added or removed on another tab, a switch of the active server.
  const savedOrderKey = useMemo(() => (savedModIds ? savedModIds.join('\n') : ''), [savedModIds])
  useEffect(() => {
    void loadStatus()
  }, [loadStatus, savedOrderKey])

  const groupsById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const statusById = useMemo(
    () => new Map((status?.groups ?? []).map((entry) => [entry.id, entry])),
    [status],
  )
  const serverSet = useMemo(() => new Set(serverModIds), [serverModIds])

  /** A status.conflicts / apply.conflicts entry: a group's name when it is a group ID, else as the server sent it. */
  const conflictText = (conflicts: readonly string[]) =>
    conflicts.map((entry) => groupsById.get(entry)?.name ?? entry).join(', ')

  const describeIds = (ids: readonly string[]) =>
    ids.length > LISTED_IDS
      ? `${ids.slice(0, LISTED_IDS).join(', ')} ${t('panel.andMore', { n: ids.length - LISTED_IDS })}`
      : ids.join(', ')

  const refreshAll = async () => {
    await Promise.all([loadGroups(), loadStatus()])
  }

  const saveGroup = async (values: ModGroupInput) => {
    const editing = editor?.group ?? null
    if (editing) {
      await modsApi.updateGroup(editing.id, values)
      toast({ title: t('toast.updatedTitle'), description: t('toast.updatedDesc', { name: values.name }) })
    } else {
      await modsApi.createGroup(values)
      toast({ title: t('toast.createdTitle'), description: t('toast.createdDesc', { name: values.name }) })
    }
    setEditor(null)
    await refreshAll()
  }

  const handleDelete = async (group: ModGroup) => {
    const ok = await confirm({
      title: t('delete.title', { name: group.name }),
      description: t('delete.description'),
      confirmLabel: t('delete.confirm'),
    })
    if (!ok) return
    try {
      await modsApi.deleteGroup(group.id)
      toast({ title: t('delete.doneTitle'), description: t('delete.doneDesc', { name: group.name }) })
    } catch (error) {
      toast({
        title: t('delete.failedTitle'),
        description: getUserErrorMessage(error, t('delete.failedFallback')),
        variant: 'destructive',
      })
    }
    await refreshAll()
  }

  const handleExport = (group: ModGroup) => {
    const fileName = groupExportFileName(group.name)
    try {
      downloadJsonFile(fileName, buildGroupDocument(group))
      toast({ title: t('export.doneTitle'), description: t('export.doneDesc', { file: fileName }) })
    } catch (error) {
      toast({
        title: t('export.failedTitle'),
        description: getUserErrorMessage(error, t('export.failedFallback')),
        variant: 'destructive',
      })
    }
  }

  const handleImportFile = async (file: File) => {
    let text: string
    try {
      text = await file.text()
    } catch (error) {
      toast({
        title: t('import.failedTitle'),
        description: getUserErrorMessage(error, t('import.readFailed')),
        variant: 'destructive',
      })
      return
    }
    // Checked here so a wrong file never becomes a request. The server checks
    // it again and owns the limits.
    const parsed = parseGroupDocument(text)
    if (!parsed.ok) {
      const reasons = {
        tooLarge: t('import.tooLarge'),
        notJson: t('import.notJson'),
        wrongKind: t('import.wrongKind'),
        unsupportedSchema: t('import.unsupportedSchema'),
        invalid: t('import.invalid'),
      }
      toast({ title: t('import.invalidTitle'), description: reasons[parsed.problem], variant: 'destructive' })
      return
    }
    setImporting(true)
    try {
      const { group } = await modsApi.importGroup(parsed.document)
      toast({ title: t('import.doneTitle'), description: t('import.doneDesc', { name: group?.name ?? parsed.document.name }) })
      await refreshAll()
    } catch (error) {
      toast({
        title: t('import.failedTitle'),
        description: getUserErrorMessage(error, t('import.failedFallback')),
        variant: 'destructive',
      })
    } finally {
      if (aliveRef.current) setImporting(false)
    }
  }

  const handleEnforce = async (next: boolean) => {
    const previous = enforce
    setEnforce(next)
    setSavingEnforce(true)
    try {
      const result = await modsApi.setGroupsEnforce(next)
      if (aliveRef.current) setEnforce(result?.enforce ?? next)
    } catch (error) {
      if (aliveRef.current) setEnforce(previous)
      toast({
        title: t('enforce.failedTitle'),
        description: getUserErrorMessage(error, t('enforce.failedFallback')),
        variant: 'destructive',
      })
    } finally {
      if (aliveRef.current) setSavingEnforce(false)
    }
  }

  // Apply works on the whole set of groups at once (they can overlap, so one
  // group cannot be put in order without looking at the rest): ask the server
  // what would move, show that, and write it only after a yes.
  const handleApply = async () => {
    if (applyingRef.current) return
    applyingRef.current = true
    setApplying(true)
    try {
      const preview = await modsApi.applyGroups(true)
      if (!preview.changed || preview.moved.length === 0) {
        toast({
          title: t('apply.alreadyTitle'),
          description: preview.conflicts.length > 0
            ? t('apply.conflictsNote', { items: conflictText(preview.conflicts) })
            : t('apply.alreadyDesc'),
        })
        await loadStatus()
        return
      }
      const moves = preview.moved.map((id) => (modNames[id] ? `${id} (${modNames[id]})` : id))
      const shown = moves.slice(0, LISTED_MOVES)
      if (moves.length > shown.length) shown.push(t('panel.andMore', { n: moves.length - shown.length }))
      const note = preview.conflicts.length > 0 ? `\n\n${t('apply.conflictsNote', { items: conflictText(preview.conflicts) })}` : ''
      const ok = await confirm({
        title: t('apply.confirmTitle'),
        description: t('apply.confirmDesc', { count: preview.moved.length }) + note,
        items: shown,
        confirmLabel: t('apply.confirm'),
        destructive: false,
      })
      if (!ok) return
      const result = await modsApi.applyGroups(false)
      if (!result.written) {
        toast({ title: t('apply.failedTitle'), description: t('apply.notWritten'), variant: 'destructive' })
        return
      }
      toast({ title: t('apply.appliedTitle'), description: t('apply.appliedDesc') })
      await onOrderApplied()
    } catch (error) {
      toast({
        title: t('apply.failedTitle'),
        description: getUserErrorMessage(error, t('apply.failedFallback')),
        variant: 'destructive',
      })
    } finally {
      applyingRef.current = false
      if (aliveRef.current) setApplying(false)
    }
  }

  const permissionReason = canManage ? null : t('panel.noPermission')
  const allInOrder = status ? status.inOrder : false
  const applyReason = !canManage
    ? t('panel.noPermission')
    : orderDirty
      ? t('panel.applyDisabledDirty')
      : orderSaving
        ? t('panel.applyDisabledBusy')
        : allInOrder
          ? t('panel.applyDisabledInOrder')
          : null
  const outOfOrder = status !== null && !status.inOrder
  const hasGroups = groups.length > 0

  return (
    <section aria-labelledby="mod-groups-title" className="rounded-lg border border-border/70 bg-secondary shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          id="mod-groups-title"
          aria-expanded={open}
          aria-controls="mod-groups-body"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 items-center gap-2 rounded text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
        >
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 rtl:-scale-x-100 ${open ? 'rotate-90 rtl:-rotate-90' : ''}`}
            aria-hidden="true"
          />
          <ListOrdered className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {t('panel.title')}
          {hasGroups && <span className="text-xs font-normal tabular-nums text-muted-foreground">{groups.length}</span>}
          {!open && outOfOrder && <Badge variant="warning" className="px-2 py-0 text-[11px]">{t('panel.outOfOrder')}</Badge>}
        </button>

        {open && loadState !== 'error' && (
          <div className="flex flex-wrap items-center gap-2">
            {hasGroups && (
              <DisabledReason reason={applyReason}>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={handleApply}
                  disabled={applyReason !== null || applying}
                >
                  {applying ? <Loader2 className="me-1 h-3 w-3 animate-spin" /> : <Wand2 className="me-1 h-3 w-3" />}
                  {t('panel.applyOrder')}
                </Button>
              </DisabledReason>
            )}
            <DisabledReason reason={permissionReason}>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => fileInputRef.current?.click()}
                disabled={!canManage || importing}
              >
                {importing ? <Loader2 className="me-1 h-3 w-3 animate-spin" /> : <Upload className="me-1 h-3 w-3" />}
                {t('panel.import')}
              </Button>
            </DisabledReason>
            {hasGroups && (
              <DisabledReason reason={permissionReason}>
                <Button size="sm" className="h-8 text-xs" onClick={() => setEditor({ group: null })} disabled={!canManage}>
                  <Plus className="me-1 h-3 w-3" />
                  {t('panel.newGroup')}
                </Button>
              </DisabledReason>
            )}
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Cleared so choosing the same file again (after fixing it) still fires.
          e.target.value = ''
          if (file) void handleImportFile(file)
        }}
      />

      {open && (
        <div id="mod-groups-body" className="space-y-3 border-t border-border/60 px-3 py-3">
          {loadState === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('panel.loading')}
            </div>
          )}

          {loadState === 'error' && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span role="alert">{t('panel.loadFailed')}</span>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => { setLoadState('loading'); void refreshAll() }}
              >
                <RefreshCw className="me-1 h-3 w-3" />
                {t('panel.retry')}
              </Button>
            </div>
          )}

          {loadState === 'ready' && !hasGroups && (
            <div className="space-y-3 py-3 text-center">
              <ListOrdered className="mx-auto h-8 w-8 text-muted-foreground opacity-30" aria-hidden="true" />
              <div className="mx-auto max-w-xl space-y-1">
                <p className="text-sm font-medium text-foreground/80">{t('panel.emptyTitle')}</p>
                <p className="text-xs text-muted-foreground">{t('panel.emptyDesc')}</p>
              </div>
              <DisabledReason reason={permissionReason}>
                <Button size="sm" onClick={() => setEditor({ group: null })} disabled={!canManage}>
                  <Plus className="me-1 h-4 w-4" />
                  {t('panel.newGroup')}
                </Button>
              </DisabledReason>
            </div>
          )}

          {loadState === 'ready' && hasGroups && (
            <>
              <p className="text-xs text-muted-foreground">{t('panel.intro')}</p>

              {status && status.conflicts.length > 0 && (
                <Alert variant="warning">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="[overflow-wrap:anywhere]">
                    {t('panel.conflicts', { items: conflictText(status.conflicts) })}
                  </AlertDescription>
                </Alert>
              )}

              <ul className="max-h-64 divide-y divide-border/50 overflow-y-auto rounded-md border border-border/60 bg-muted/30">
                {groups.map((group) => {
                  const entry = statusById.get(group.id)
                  const present = entry?.present ?? group.modIds.filter((id) => serverSet.has(id)).length
                  const total = entry?.total ?? group.modIds.length
                  const missing = entry?.missing ?? group.modIds.filter((id) => !serverSet.has(id))
                  return (
                    <li key={group.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
                      <div className="min-w-0 flex-1 basis-56 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="truncate text-sm font-medium">{group.name}</span>
                          {entry && (
                            <Badge variant={entry.inOrder ? 'success' : 'warning'} className="px-2 py-0 text-[11px]">
                              {entry.inOrder ? t('panel.inOrder') : t('panel.outOfOrder')}
                            </Badge>
                          )}
                          <span className="text-[11px] tabular-nums text-muted-foreground">
                            {t('panel.members', { present, total })}
                          </span>
                        </div>
                        {group.description && (
                          <p className="truncate text-xs text-muted-foreground">{group.description}</p>
                        )}
                        {missing.length > 0 && (
                          <p className="truncate font-mono text-[11px] text-muted-foreground/80">
                            {t('panel.notOnServerList', { ids: describeIds(missing) })}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center">
                        <DisabledReason reason={permissionReason}>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 px-2 text-xs"
                            aria-label={t('panel.editAria', { name: group.name })}
                            onClick={() => setEditor({ group })}
                            disabled={!canManage}
                          >
                            <Pencil className="h-3.5 w-3.5 sm:me-1" aria-hidden="true" />
                            <span className="hidden sm:inline">{t('panel.edit')}</span>
                          </Button>
                        </DisabledReason>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-xs"
                          aria-label={t('panel.exportAria', { name: group.name })}
                          onClick={() => handleExport(group)}
                        >
                          <Download className="h-3.5 w-3.5 sm:me-1" aria-hidden="true" />
                          <span className="hidden sm:inline">{t('panel.export')}</span>
                        </Button>
                        <DisabledReason reason={permissionReason}>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 px-2 text-xs hover:text-destructive"
                            aria-label={t('panel.deleteAria', { name: group.name })}
                            onClick={() => void handleDelete(group)}
                            disabled={!canManage}
                          >
                            <Trash2 className="h-3.5 w-3.5 sm:me-1" aria-hidden="true" />
                            <span className="hidden sm:inline">{t('panel.delete')}</span>
                          </Button>
                        </DisabledReason>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          )}

          {loadState === 'ready' && (
            <div className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/30 p-2.5">
              <Switch
                id="mod-groups-enforce"
                checked={enforce}
                onCheckedChange={(next) => void handleEnforce(next)}
                disabled={!canManage || savingEnforce}
                aria-describedby="mod-groups-enforce-desc"
                className="mt-0.5"
              />
              <div className="min-w-0 space-y-0.5">
                <Label htmlFor="mod-groups-enforce" className="text-xs font-medium">{t('panel.enforceLabel')}</Label>
                <p id="mod-groups-enforce-desc" className="text-[11px] text-muted-foreground">{t('panel.enforceDesc')}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {editor && (
        <ModGroupDialog
          group={editor.group}
          serverModIds={serverModIds}
          modNames={modNames}
          onClose={() => setEditor(null)}
          onSubmit={saveGroup}
        />
      )}
    </section>
  )
}
