import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Download,
  ListOrdered,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react'
import { DisabledReason } from '@/components/DisabledReason'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/components/ui/section-card'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/contexts/ConfirmContext'
import { modsApi, type ModGroup, type ModGroupSuggestion } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import {
  buildGroupDocument,
  downloadJsonFile,
  groupExportFileName,
  parseGroupDocument,
} from '@/lib/modGroups'
import type { GroupConflictSummary } from '@/lib/modGroupTools'
import { GroupDot } from './GroupDots'
import { GroupSuggestions } from './GroupSuggestions'
import { useGroupSuggestions } from './useGroupSuggestions'
import { ModGroupDialog, type ModGroupDialogValues } from './ModGroupDialog'
import { saveGroupValues } from './groupActions'
import { useApplyGroupOrder } from './useApplyGroupOrder'
import { useModGroupsStore, type ModGroupsStore } from './useModGroupsStore'

// How many mod IDs a group row names before it says "+N more".
const LISTED_IDS = 3

type Editor = { group: ModGroup | null; initialModIds?: readonly string[]; initialName?: string; fromSuggestion?: boolean }

/** A request from the Load order tab: create a group from the mods picked there. */
export interface CreateGroupRequest {
  /** The picked mods, in load order. */
  modIds: readonly string[]
  /** Changes with every request, so asking twice with the same mods opens the dialog twice. */
  nonce: number
}

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
  /** Opens the create dialog with these members when it changes ("Create group from selection"). */
  createRequest?: CreateGroupRequest | null
  /** Called once a group created from `createRequest` was saved. */
  onCreatedFromRequest?: () => void
  /** The page's groups store; without one the panel loads its own. */
  store?: ModGroupsStore
  /** Mod ID to its `require=` entries, for the dialog's "Auto-order members". */
  requires?: ReadonlyMap<string, readonly string[]>
  /** File conflicts touching each group (from the cached conflict scan). */
  conflictsByGroup?: ReadonlyMap<string, GroupConflictSummary>
  /** Opens the Conflicts view filtered to a group's mods. */
  onShowConflicts?: (group: ModGroup, summary: GroupConflictSummary) => void
}

/**
 * "Mod groups" on the Mod Manager's Load order tab: named, ordered lists of
 * mods that must load in one fixed order, shared by every admin of the panel.
 * The server keeps them in order whenever the load order is saved (while
 * "Keep group order" is on) and can apply them on demand (Apply group order).
 * Create / edit lives in ModGroupDialog; suggested groups sit under the list.
 */
export function ModGroupsPanel({
  canManage,
  serverModIds,
  modNames,
  savedModIds,
  orderDirty,
  orderSaving,
  onOrderApplied,
  createRequest,
  onCreatedFromRequest,
  store: sharedStore,
  requires,
  conflictsByGroup,
  onShowConflicts,
}: ModGroupsPanelProps) {
  const { t } = useTranslation('modGroups')
  const { toast } = useToast()
  const confirm = useConfirm()
  const ownStore = useModGroupsStore({ enabled: !sharedStore, savedModIds })
  const store = sharedStore ?? ownStore
  const { groups, enforce, loadState, status, placements } = store
  const [editor, setEditor] = useState<Editor | null>(null)
  const [savingEnforce, setSavingEnforce] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const aliveRef = useRef(true)
  const suggestions = useGroupSuggestions(canManage && loadState === 'ready')

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const handledRequestNonce = useRef<number | null>(null)
  useEffect(() => {
    if (!createRequest || handledRequestNonce.current === createRequest.nonce) return
    handledRequestNonce.current = createRequest.nonce
    if (!canManage) return
    setEditor({ group: null, initialModIds: createRequest.modIds })
  }, [createRequest, canManage])

  const groupsById = store.groupsById
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

  const saveGroup = async (values: ModGroupDialogValues) => {
    const editing = editor?.group ?? null
    await saveGroupValues(values, editing, store)
    if (editing) {
      toast({ title: t('toast.updatedTitle'), description: t('toast.updatedDesc', { name: values.name }) })
    } else {
      toast({ title: t('toast.createdTitle'), description: t('toast.createdDesc', { name: values.name }) })
      if (editor?.initialModIds && !editor.fromSuggestion) onCreatedFromRequest?.()
      if (editor?.fromSuggestion) void suggestions.reload()
    }
    setEditor(null)
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
      store.setPlacement(group.id, null)
      toast({ title: t('delete.doneTitle'), description: t('delete.doneDesc', { name: group.name }) })
    } catch (error) {
      toast({
        title: t('delete.failedTitle'),
        description: getUserErrorMessage(error, t('delete.failedFallback')),
        variant: 'destructive',
      })
    }
    await store.reload()
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
      await store.reload()
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
    store.setEnforce(next)
    setSavingEnforce(true)
    try {
      const result = await modsApi.setGroupsEnforce(next)
      if (aliveRef.current) store.setEnforce(result?.enforce ?? next)
    } catch (error) {
      if (aliveRef.current) store.setEnforce(previous)
      toast({
        title: t('enforce.failedTitle'),
        description: getUserErrorMessage(error, t('enforce.failedFallback')),
        variant: 'destructive',
      })
    } finally {
      if (aliveRef.current) setSavingEnforce(false)
    }
  }

  const { apply: handleApply, applying } = useApplyGroupOrder({
    groupsById,
    modNames,
    onApplied: onOrderApplied,
    onChecked: store.reloadStatus,
  })

  const handleDismissSuggestion = async (suggestion: ModGroupSuggestion) => {
    try {
      await suggestions.dismiss(suggestion.key)
    } catch (error) {
      toast({
        title: t('suggestions.dismissFailedTitle'),
        description: getUserErrorMessage(error, t('suggestions.dismissFailedFallback')),
        variant: 'destructive',
      })
      void suggestions.reload()
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
    <SectionCard
      id="mod-groups"
      title={
        <span className="inline-flex items-center gap-2">
          {t('panel.title')}
          {hasGroups && <span className="text-xs font-normal tabular-nums text-muted-foreground">{groups.length}</span>}
        </span>
      }
      icon={ListOrdered}
      density="compact"
      collapsible
      storageKey="zcp:mods:groupsPanelOpen"
      status={outOfOrder ? <Badge variant="warning" className="px-2 py-0 text-[11px]">{t('panel.outOfOrder')}</Badge> : undefined}
      actions={
        loadState !== 'error' ? (
          <>
            {hasGroups && (
              <DisabledReason reason={applyReason}>
                <Button variant="outline" size="sm" onClick={handleApply} disabled={applyReason !== null || applying}>
                  {applying ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Wand2 aria-hidden="true" />}
                  {/* Icon-only on a phone: the three actions fit one line next to the title. */}
                  <span className="sr-only sm:not-sr-only">{t('panel.applyOrder')}</span>
                </Button>
              </DisabledReason>
            )}
            <DisabledReason reason={permissionReason}>
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={!canManage || importing}>
                {importing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Upload aria-hidden="true" />}
                <span className="sr-only sm:not-sr-only">{t('panel.import')}</span>
              </Button>
            </DisabledReason>
            {hasGroups && (
              <DisabledReason reason={permissionReason}>
                <Button size="sm" onClick={() => setEditor({ group: null })} disabled={!canManage}>
                  <Plus aria-hidden="true" />
                  {t('panel.newGroup')}
                </Button>
              </DisabledReason>
            )}
          </>
        ) : undefined
      }
    >
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

      {loadState === 'loading' && (
        <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('panel.loading')}
        </div>
      )}

      {loadState === 'error' && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span role="alert">{t('panel.loadFailed')}</span>
          <Button variant="outline" size="sm" onClick={() => void store.reload()}>
            <RefreshCw aria-hidden="true" />
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
              <Plus aria-hidden="true" />
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

          <ul className="max-h-72 divide-y divide-border/50 overflow-y-auto rounded-md border border-border/60 bg-muted/30">
            {groups.map((group) => {
              const entry = statusById.get(group.id)
              const present = entry?.present ?? group.modIds.filter((id) => serverSet.has(id)).length
              const total = entry?.total ?? group.modIds.length
              const missing = entry?.missing ?? group.modIds.filter((id) => !serverSet.has(id))
              const conflicts = conflictsByGroup?.get(group.id)
              const placement = placements[group.id]
              return (
                <li key={group.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
                  <div className="min-w-0 flex-1 basis-56 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <GroupDot color={group.color} />
                      <span className="truncate text-sm font-medium">{group.name}</span>
                      {entry && (
                        <Badge variant={entry.inOrder ? 'success' : 'warning'} className="px-2 py-0 text-[11px]">
                          {entry.inOrder ? t('panel.inOrder') : t('panel.outOfOrder')}
                        </Badge>
                      )}
                      {group.keepTogether && (
                        <Badge variant="outline" className="px-2 py-0 text-[11px] font-normal">{t('panel.keepsTogether')}</Badge>
                      )}
                      {placement && (
                        <Badge variant="outline" className="px-2 py-0 text-[11px] font-normal">
                          {placement === 'first' ? t('panel.loadsFirst') : t('panel.loadsLast')}
                        </Badge>
                      )}
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {t('panel.members', { present, total })}
                      </span>
                      {conflicts && (
                        onShowConflicts ? (
                          <button
                            type="button"
                            onClick={() => onShowConflicts(group, conflicts)}
                            className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-warning/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                            aria-label={t('panel.conflictsBadgeAria', { count: conflicts.internal + conflicts.external, name: group.name })}
                          >
                            <ShieldAlert className="h-3 w-3 text-warning" aria-hidden="true" />
                            {t('panel.conflictsBadge', { count: conflicts.internal + conflicts.external })}
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium">
                            <ShieldAlert className="h-3 w-3 text-warning" aria-hidden="true" />
                            {t('panel.conflictsBadge', { count: conflicts.internal + conflicts.external })}
                          </span>
                        )
                      )}
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
                        className="px-2"
                        aria-label={t('panel.editAria', { name: group.name })}
                        onClick={() => setEditor({ group })}
                        disabled={!canManage}
                      >
                        <Pencil aria-hidden="true" />
                        <span className="hidden sm:inline">{t('panel.edit')}</span>
                      </Button>
                    </DisabledReason>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="px-2"
                      aria-label={t('panel.exportAria', { name: group.name })}
                      onClick={() => handleExport(group)}
                    >
                      <Download aria-hidden="true" />
                      <span className="hidden sm:inline">{t('panel.export')}</span>
                    </Button>
                    <DisabledReason reason={permissionReason}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2 hover:text-destructive"
                        aria-label={t('panel.deleteAria', { name: group.name })}
                        onClick={() => void handleDelete(group)}
                        disabled={!canManage}
                      >
                        <Trash2 aria-hidden="true" />
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
        <GroupSuggestions
          suggestions={suggestions.suggestions}
          modNames={modNames}
          canManage={canManage}
          onCreate={(suggestion) => setEditor({ group: null, initialModIds: suggestion.modIds, initialName: suggestion.name, fromSuggestion: true })}
          onDismiss={(suggestion) => void handleDismissSuggestion(suggestion)}
          storageKey="zcp:mods:suggestionsOpen:order"
        />
      )}

      {loadState === 'ready' && (
        <div className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/30 p-3">
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
            <p id="mod-groups-enforce-desc" className="text-xs text-muted-foreground">{t('panel.enforceDesc')}</p>
          </div>
        </div>
      )}

      {editor && (
        <ModGroupDialog
          group={editor.group}
          initialModIds={editor.initialModIds}
          initialName={editor.initialName}
          placement={editor.group ? placements[editor.group.id] ?? null : null}
          serverModIds={serverModIds}
          modNames={modNames}
          requires={requires}
          onClose={() => setEditor(null)}
          onSubmit={saveGroup}
        />
      )}
    </SectionCard>
  )
}
