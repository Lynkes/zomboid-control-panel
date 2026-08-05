/**
 * WorkshopCollectionPanel
 * ───────────────────────
 * Daily-driver UI for reconciling locally-tracked mods with the Steam
 * Workshop collection. Lives in the Mod Manager as its own tab.
 *
 * Design intent (PZ control-room aesthetic):
 *  - Stat tiles up top tell the whole story at a glance
 *  - Drift becomes loud when present, calm when zero
 *  - One unified table with filter pills + search + bulk actions
 *  - Per-row buttons for surgical fixes
 *
 * Source of truth: `GET /api/mods/collection/diff` returns a denormalised
 * `items[]` already merged from tracked-mods + Steam collection, with
 * status, name (resolved via Steam title API) and credential state.
 *
 * The component intentionally does NOT manage settings — it links the
 * user to Settings → Workshop Collection Sync when configuration is
 * missing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  Bookmark,
  BookmarkPlus,
  Check,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Library,
  Loader2,
  Minus,
  Plus,
  Server,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { modsApi } from '@/lib/api'
import { cn } from '@/lib/utils'

type DiffResponse = Awaited<ReturnType<typeof modsApi.collectionDiff>>
type DiffItem = DiffResponse['items'][number]

type FilterKey =
  | 'all'
  | 'missing'
  | 'not-on-server'
  | 'tracked-only'
  | 'synced'
  | 'tracked'
  | 'collection'
  | 'server'
type RowAction = 'add' | 'remove' | 'track' | 'untrack' | 'add-server' | 'remove-server' | 'purge'

// Friendly relative-time string for the "last refreshed" badge.
function formatAgo(date: Date | null): string {
  if (!date) return 'never'
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return date.toLocaleTimeString()
}

function parseSteamCookieBlob(raw: string): { sessionid?: string; steamLoginSecure?: string; error?: string } {
  const text = raw.replace(/\r/g, '')
  const sessionMatch = text.match(/(?:^|[;\s'"])sessionid\s*[=:\t]\s*([A-Za-z0-9_%-]+)/i)
  const loginMatch = text.match(/(?:^|[;\s'"])steamLoginSecure\s*[=:\t]\s*([A-Za-z0-9_%|+/=.-]+)/i)
  if (!sessionMatch || !loginMatch) {
    return { error: 'Paste both sessionid and steamLoginSecure.' }
  }
  try {
    return {
      sessionid: decodeURIComponent(sessionMatch[1]),
      steamLoginSecure: decodeURIComponent(loginMatch[1]),
    }
  } catch {
    return { sessionid: sessionMatch[1], steamLoginSecure: loginMatch[1] }
  }
}

export function WorkshopCollectionPanel() {
  const { toast } = useToast()
  const [diff, setDiff] = useState<DiffResponse | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffCheckedAt, setDiffCheckedAt] = useState<Date | null>(null)
  const [bulkBusy, setBulkBusy] = useState<RowAction | null>(null)
  const [purgeTarget, setPurgeTarget] = useState<DiffItem | null>(null)
  const [cookieDialogOpen, setCookieDialogOpen] = useState(false)
  const [cookiePaste, setCookiePaste] = useState('')
  const [cookieSaving, setCookieSaving] = useState(false)
  const [cookieError, setCookieError] = useState<string | null>(null)

  const [filter, setFilter] = useState<FilterKey>('missing')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rowBusy, setRowBusy] = useState<Record<string, RowAction | null>>({})

  const refreshSeqRef = useRef(0)
  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current
    setDiffLoading(true)
    setDiffError(null)
    try {
      const r = await modsApi.collectionDiff()
      if (seq !== refreshSeqRef.current) return
      setDiff(r)
      setDiffCheckedAt(new Date())
      if (!r.ok && r.error) setDiffError(r.error)
    } catch (err: any) {
      if (seq !== refreshSeqRef.current) return
      setDiffError(err?.message || 'Failed to read collection')
    } finally {
      if (seq === refreshSeqRef.current) setDiffLoading(false)
    }
  }, [])

  // Load on mount.
  useEffect(() => {
    refresh()
  }, [refresh])

  const collectionId = diff?.collectionId || ''
  const credsConfigured = !!diff?.hasCredentials
  const tokenExpired = !!diff?.tokenExpired
  const autoSync = !!diff?.autoSync
  const items: DiffItem[] = useMemo(() => (diff?.ok && diff.items) ? diff.items : [], [diff])

  // Counts per filter category — drive both the pill labels and the
  // stat tiles so they always agree.
  const counts = useMemo(() => {
    let synced = 0, toAdd = 0, collectionOnly = 0, trackedOnly = 0, tracked = 0, inColl = 0, onServer = 0
    for (const it of items) {
      if (it.status === 'synced') synced++
      else if (it.status === 'to-add') toAdd++
      else if (it.status === 'collection-only') collectionOnly++
      else if (it.status === 'tracked-only') trackedOnly++
      if (it.inTracked) tracked++
      if (it.inCollection) inColl++
      if (it.inServer) onServer++
    }
    return {
      synced, toAdd, collectionOnly, trackedOnly, tracked, inColl, onServer,
      total: items.length,
      // Everything the collection and the server disagree about.
      mismatch: toAdd + collectionOnly + trackedOnly,
    }
  }, [items])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((it) => {
      if (filter === 'missing' && it.status !== 'to-add') return false
      if (filter === 'not-on-server' && it.status !== 'collection-only') return false
      if (filter === 'tracked-only' && it.status !== 'tracked-only') return false
      if (filter === 'synced' && it.status !== 'synced') return false
      if (filter === 'tracked' && !it.inTracked) return false
      if (filter === 'collection' && !it.inCollection) return false
      if (filter === 'server' && !it.inServer) return false
      if (q) {
        if (!it.workshopId.includes(q) && !(it.name || '').toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [items, filter, search])

  // Selection helpers — selection is intentionally scoped to the
  // currently-visible (filtered) rows. Switching filter clears nothing,
  // but bulk actions only fire on rows still on screen and matching the
  // action's prerequisites.
  const visibleIds = useMemo(() => filtered.map((i) => i.workshopId), [filtered])
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
  const someVisibleSelected = visibleIds.some((id) => selected.has(id))
  const selectedItems = useMemo(
    () => filtered.filter((item) => selected.has(item.workshopId)),
    [filtered, selected],
  )
  const canBulkTrack = selectedItems.some((item) => !item.inTracked)
  const canBulkUntrack = selectedItems.some((item) => item.inTracked)
  const canBulkRemoveServer = selectedItems.some((item) => item.inServer)

  const toggleSelectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id))
      else visibleIds.forEach((id) => next.add(id))
      return next
    })
  }
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const clearSelection = () => setSelected(new Set())

  const saveCookies = async () => {
    const parsed = parseSteamCookieBlob(cookiePaste)
    if (!parsed.sessionid || !parsed.steamLoginSecure) {
      setCookieError(parsed.error || 'Paste both Steam cookies.')
      return
    }
    setCookieSaving(true)
    setCookieError(null)
    try {
      await modsApi.collectionSaveCookies(parsed.sessionid, parsed.steamLoginSecure)
      setCookiePaste('')
      setCookieDialogOpen(false)
      toast({ title: 'Steam cookies saved' })
      await refresh()
    } catch (err: any) {
      setCookieError(err?.message || 'Could not save Steam cookies.')
    } finally {
      setCookieSaving(false)
    }
  }

  // ── Mutations ────────────────────────────────────────────────────────
  const runRowAction = async (workshopId: string, action: RowAction) => {
    setRowBusy((prev) => ({ ...prev, [workshopId]: action }))
    try {
      if (action === 'add') {
        if (!credsConfigured) throw new Error('Add Steam cookies in Settings first.')
        if (tokenExpired) throw new Error('Steam session expired — paste fresh cookies in Settings.')
        await modsApi.collectionAddItem(workshopId)
      } else if (action === 'remove') {
        if (!credsConfigured) throw new Error('Add Steam cookies in Settings first.')
        if (tokenExpired) throw new Error('Steam session expired — paste fresh cookies in Settings.')
        await modsApi.collectionRemoveItem(workshopId)
      } else if (action === 'track') {
        await modsApi.trackMod(workshopId)
      } else if (action === 'untrack') {
        await modsApi.collectionUntrack(workshopId)
      } else if (action === 'add-server') {
        await modsApi.addToIni(workshopId)
        if (!items.find((item) => item.workshopId === workshopId)?.inTracked) {
          await modsApi.trackMod(workshopId)
        }
        toast({
          title: 'Added to server configuration',
          description: 'Project Zomboid will download and load this mod on the next server restart.',
        })
      } else if (action === 'remove-server') {
        await modsApi.batchRemove([workshopId])
        toast({
          title: 'Removed from server configuration',
          description: autoSync ? 'It will also be removed from Steam collection.' : 'Steam collection was left unchanged because auto-sync is off.',
        })
      } else if (action === 'purge') {
        const item = items.find((it) => it.workshopId === workshopId)
        const r = await modsApi.purgeMod(workshopId, item?.name)
        const done = [
          r.collection.attempted
            ? r.collection.ok
              ? 'removed from the collection'
              : `collection not updated (${r.collection.error || 'Steam rejected the change'})`
            : null,
          'removed from the server config',
          r.deletedFromDisk ? 'deleted from disk' : 'no files on disk',
          'untracked and ignored',
        ].filter(Boolean)
        toast({
          title: `Removed ${r.name || workshopId} everywhere`,
          description: `${done.join(', ')}. Restart the server to apply.`,
        })
      }
      await refresh()
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'Action failed', description: err?.message || 'Steam rejected the change' })
    } finally {
      setRowBusy((prev) => {
        const next = { ...prev }
        delete next[workshopId]
        return next
      })
    }
  }

  // Bulk actions iterate sequentially so we don't slam Steam with parallel
  // writes (their endpoints rate-limit cookie-auth pretty aggressively).
  // Each row's success / failure is surfaced at the end as a single toast.
  const runBulk = async (action: RowAction) => {
    if (bulkBusy) return
    // Filter selection to rows where the action makes sense.
    const targets = filtered.filter((it) => {
      if (!selected.has(it.workshopId)) return false
      if (action === 'add') return !it.inCollection
      if (action === 'remove') return it.inCollection
      if (action === 'track') return !it.inTracked
      if (action === 'untrack') return it.inTracked
      if (action === 'remove-server') return it.inServer
      return false
    })
    if (targets.length === 0) {
      toast({ title: 'Nothing to do', description: 'None of the selected rows need this action.' })
      return
    }
    if ((action === 'add' || action === 'remove') && !credsConfigured) {
      toast({ variant: 'destructive', title: 'Steam cookies required', description: 'Open Settings → Workshop Collection Sync to add them.' })
      return
    }
    if ((action === 'add' || action === 'remove') && tokenExpired) {
      toast({ variant: 'destructive', title: 'Steam session expired', description: 'Your Steam cookies have expired. Paste fresh ones in Settings → Workshop Collection Sync.' })
      return
    }
    if (action === 'remove-server') {
      setBulkBusy(action)
      targets.forEach((item) => setRowBusy((prev) => ({ ...prev, [item.workshopId]: action })))
      try {
        await modsApi.batchRemove(targets.map((item) => item.workshopId))
        toast({
          title: 'Removed from server configuration',
          description: autoSync
            ? `${targets.length} mod${targets.length !== 1 ? 's' : ''} removed; Steam collection will follow.`
            : `${targets.length} mod${targets.length !== 1 ? 's' : ''} removed. Steam collection was left unchanged because auto-sync is off.`,
        })
      } catch (err: any) {
        toast({ variant: 'destructive', title: 'Server removal failed', description: err?.message || 'Unable to update the server configuration.' })
      } finally {
        setBulkBusy(null)
        setRowBusy({})
        await refresh()
        clearSelection()
      }
      return
    }
    setBulkBusy(action)
    let ok = 0
    const errors: Array<{ id: string; error: string }> = []
    for (const it of targets) {
      setRowBusy((prev) => ({ ...prev, [it.workshopId]: action }))
      try {
        if (action === 'add') await modsApi.collectionAddItem(it.workshopId)
        else if (action === 'remove') await modsApi.collectionRemoveItem(it.workshopId)
        else if (action === 'track') await modsApi.trackMod(it.workshopId)
        else if (action === 'untrack') await modsApi.collectionUntrack(it.workshopId)
        ok++
      } catch (err: any) {
        errors.push({ id: it.workshopId, error: err?.message || 'failed' })
      } finally {
        setRowBusy((prev) => {
          const next = { ...prev }
          delete next[it.workshopId]
          return next
        })
      }
    }
    setBulkBusy(null)
    await refresh()
    clearSelection()
    if (errors.length === 0) {
      toast({ title: 'Bulk action complete', description: `${ok} mod${ok !== 1 ? 's' : ''} updated.` })
    } else {
      toast({
        variant: 'destructive',
        title: `Bulk action: ${errors.length} failure${errors.length !== 1 ? 's' : ''}`,
        description: `${ok} succeeded, ${errors.length} failed. First error: ${errors[0].error}`,
      })
    }
  }

  // ── Render guards ────────────────────────────────────────────────────
  const noCollectionConfigured = diff !== null && !collectionId

  // Configuration empty-state: shown when the panel is loaded but the
  // user hasn't set a collection ID yet. Points them at the Settings card.
  if (noCollectionConfigured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Library className="w-4 h-4 text-primary" />
            Workshop Collection
          </CardTitle>
          <CardDescription>
            Mirror your tracked mods into a Steam Workshop collection.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center text-center py-10 gap-4 border border-dashed border-border/50 rounded-lg bg-muted/10">
            <div className="w-12 h-12 rounded-full bg-muted/40 flex items-center justify-center">
              <Library className="w-6 h-6 text-muted-foreground" />
            </div>
            <div className="space-y-1 max-w-md">
              <h3 className="text-sm font-semibold text-foreground">No collection configured</h3>
              <p className="text-xs text-muted-foreground">
                Add your Steam Workshop collection ID and paste your Steam session cookies, then come back here to manage the sync.
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link to="/settings#settings-workshop-collection">
                <SettingsIcon className="w-3.5 h-3.5 mr-2" />
                Open Settings
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const inSync = diff?.ok && counts.mismatch === 0
  const syncedRatio = counts.total > 0 ? (counts.synced / counts.total) * 100 : 0

  return (
    <Card className={cn(
      'overflow-hidden transition-colors',
      counts.mismatch > 0 ? 'border-warning/40' : ''
    )}>
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5 min-w-0">
            <CardTitle className="flex items-center gap-2 flex-wrap">
              <Library className="w-4 h-4 text-primary shrink-0" />
              <span>Workshop Collection</span>
              {diff?.title && (
                <a
                  href={collectionId ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${collectionId}` : '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-normal text-muted-foreground hover:text-primary inline-flex items-center gap-1 max-w-[280px] truncate"
                  title={diff.title}
                >
                  · {diff.title}
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              )}
            </CardTitle>
            <CardDescription className="flex items-center gap-3 flex-wrap text-xs">
              <span className="font-mono">{collectionId || '—'}</span>
              <span className="text-muted-foreground/60">·</span>
              <span>Auto-sync <strong className={autoSync ? 'text-success' : 'text-muted-foreground'}>{autoSync ? 'on' : 'off'}</strong></span>
              <span className="text-muted-foreground/60">·</span>
              <span>Refreshed {formatAgo(diffCheckedAt)}</span>
              {!credsConfigured && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <span className="inline-flex items-center gap-1 text-warning">
                    <AlertTriangle className="w-3 h-3" />
                    No Steam cookies — read-only
                  </span>
                </>
              )}
              {credsConfigured && tokenExpired && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <span className="inline-flex items-center gap-1 text-destructive">
                    <AlertTriangle className="w-3 h-3" />
                    Steam session expired — paste fresh cookies in{' '}
                    <Link to="/settings" className="underline underline-offset-2">Settings</Link>
                  </span>
                </>
              )}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setCookieError(null)
                setCookieDialogOpen(true)
              }}
              className="h-8 w-8 text-muted-foreground"
              title="Paste Steam cookies"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span className="sr-only">Paste Steam cookies</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={refresh}
              disabled={diffLoading}
              className="h-8 px-2 text-xs"
              title="Re-read Steam collection contents"
            >
              <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', diffLoading && 'animate-spin')} />
              Refresh
            </Button>
            <Button asChild variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground">
              <Link to="/settings#settings-workshop-collection">
                <SettingsIcon className="w-3.5 h-3.5 mr-1.5" />
                Configure
              </Link>
            </Button>
          </div>
        </div>
      </CardHeader>

      <Dialog open={cookieDialogOpen} onOpenChange={setCookieDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Steam cookies</DialogTitle>
          </DialogHeader>
          <Textarea
            value={cookiePaste}
            onChange={(event) => setCookiePaste(event.target.value)}
            placeholder="sessionid=...; steamLoginSecure=..."
            className="min-h-28 font-mono text-xs"
            autoFocus
          />
          {cookieError && <p className="text-xs text-destructive">{cookieError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCookieDialogOpen(false)} disabled={cookieSaving}>Cancel</Button>
            <Button onClick={saveCookies} disabled={cookieSaving || !cookiePaste.trim()}>
              {cookieSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CardContent className="space-y-4">
        {/* Error banner */}
        {diffError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1">{diffError}</div>
          </div>
        )}

        {/* Sync summary — one calm read of the state, details tucked away. */}
        <div className={cn(
          'rounded-lg border px-3 py-3',
          inSync ? 'border-success/30 bg-success/[0.04]' : 'border-warning/35 bg-warning/[0.045]'
        )}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              {inSync ? <CheckCircle2 className="h-5 w-5 shrink-0 text-success" /> : <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />}
              <div className="min-w-0">
                <p className={cn('text-sm font-semibold', inSync ? 'text-success' : 'text-warning')}>
                  {inSync ? 'Collection matches the server' : `${counts.mismatch} difference${counts.mismatch !== 1 ? 's' : ''} to review`}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {counts.toAdd} on the server but not in the collection; {counts.collectionOnly} in the collection but not on the server
                  {counts.trackedOnly > 0 ? `; ${counts.trackedOnly} tracked but in neither` : ''}.
                </p>
              </div>
            </div>
            <div className="min-w-[12rem] space-y-1.5">
              <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                <span>{Math.round(syncedRatio)}%</span>
                {!inSync && <span>{counts.mismatch} to review</span>}
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-border/40">
                <div className={cn('h-full rounded-full transition-all duration-500 ease-out', inSync ? 'bg-success' : 'bg-warning')} style={{ width: `${syncedRatio}%` }} />
              </div>
            </div>
          </div>
          <details className="group/collection-details mt-2 border-t border-border/25 pt-2">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
              <span className="transition-transform group-open/collection-details:rotate-90"><Plus className="h-3 w-3" /></span>
              Show collection counts
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile label="On the server" value={counts.onServer} icon={<Server className="w-3.5 h-3.5" />} accent="primary" onClick={() => setFilter('server')} />
              <StatTile label="In Steam collection" value={counts.inColl} icon={<Library className="w-3.5 h-3.5" />} accent="primary" onClick={() => setFilter('collection')} />
              <StatTile label="Missing from collection" value={counts.toAdd} icon={<Plus className="w-3.5 h-3.5" />} accent={counts.toAdd > 0 ? 'warning' : 'muted'} onClick={counts.toAdd > 0 ? () => setFilter('missing') : undefined} />
              <StatTile label="Not on the server" value={counts.collectionOnly} icon={<Library className="w-3.5 h-3.5" />} accent={counts.collectionOnly > 0 ? 'primary' : 'muted'} onClick={counts.collectionOnly > 0 ? () => setFilter('not-on-server') : undefined} />
            </div>
          </details>
        </div>

        {/* Toolbar: filter pills + search + bulk actions */}
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-border/55 bg-muted/30 p-0.5 text-[11px] font-medium">
            {([
              ['missing', 'Missing from collection', counts.toAdd],
              ['not-on-server', 'Not on server', counts.collectionOnly],
              ...(counts.trackedOnly > 0
                ? [['tracked-only', 'Tracked only', counts.trackedOnly] as [FilterKey, string, number]]
                : []),
              ['synced', 'In sync', counts.synced],
              ['all', 'All', counts.total],
            ] as Array<[FilterKey, string, number]>).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={cn(
                  'shrink-0 px-2 py-1 rounded-sm transition-colors',
                  filter === key
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                )}
              >
                {label} <span className="opacity-70">({count})</span>
              </button>
            ))}
          </div>

          <div className="relative w-full lg:w-64">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by name or ID…"
              className="h-8 w-full pl-7 pr-7 text-xs"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <XCircle className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Bulk action bar — only renders when something's selected, so
            the toolbar stays calm in the common case */}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 flex-wrap rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs animate-in fade-in slide-in-from-top-1">
            <span className="font-medium text-foreground">
              {selected.size} selected
            </span>
            <span className="text-muted-foreground/60">·</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-success hover:text-success hover:bg-success/10"
              onClick={() => runBulk('add')}
              disabled={!!bulkBusy || !credsConfigured || tokenExpired}
            >
              {bulkBusy === 'add' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Plus className="w-3 h-3 mr-1" />}
              Add to collection
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => runBulk('remove')}
              disabled={!!bulkBusy || !credsConfigured || tokenExpired}
            >
              {bulkBusy === 'remove' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Minus className="w-3 h-3 mr-1" />}
              Remove from collection
            </Button>
            <span className="text-muted-foreground/40">|</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={() => runBulk('track')}
              disabled={!!bulkBusy || !canBulkTrack}
            >
              {bulkBusy === 'track' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <BookmarkPlus className="w-3 h-3 mr-1" />}
              Track locally
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-muted-foreground"
              onClick={() => runBulk('untrack')}
              disabled={!!bulkBusy || !canBulkUntrack}
            >
              {bulkBusy === 'untrack' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Bookmark className="w-3 h-3 mr-1" />}
              Untrack
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => runBulk('remove-server')}
              disabled={!!bulkBusy || !canBulkRemoveServer}
              title="Remove selected mods from the server after they were removed from Steam"
            >
              {bulkBusy === 'remove-server' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Minus className="w-3 h-3 mr-1" />}
              Remove from server
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] ml-auto"
              onClick={clearSelection}
            >
              <X className="w-3 h-3 mr-1" />
              Clear
            </Button>
          </div>
        )}

        {/* Table */}
        <div className="rounded-md border border-border/60 overflow-hidden">
          <div className="max-h-[520px] overflow-auto">
            {diffLoading && !diff ? (
              <div className="px-3 py-10 text-center text-xs text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                Reading collection from Steam…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-10 text-center text-xs text-muted-foreground space-y-2">
                {inSync && filter === 'missing' ? (
                  <>
                    <CheckCircle2 className="w-6 h-6 text-success mx-auto" />
                    <div className="font-medium text-foreground">Everything's in sync</div>
                    <div>The Steam collection matches the mods on the server exactly.</div>
                  </>
                ) : search ? (
                  <div>No mods match your search.</div>
                ) : (
                  <div>Nothing in this filter.</div>
                )}
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur z-10">
                  <tr className="text-left text-muted-foreground border-b border-border/50">
                    <th className="font-medium px-3 py-2 w-[36px]">
                      <Checkbox
                        checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                        onCheckedChange={toggleSelectAllVisible}
                        aria-label="Select all visible"
                      />
                    </th>
                    <th className="font-medium px-3 py-2 w-[150px]">Status</th>
                    <th className="font-medium px-3 py-2">Mod</th>
                    <th className="font-medium px-3 py-2 w-[320px] text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((it) => (
                    <Row
                      key={it.workshopId}
                      item={it}
                      selected={selected.has(it.workshopId)}
                      onToggleSelect={() => toggleOne(it.workshopId)}
                      busy={rowBusy[it.workshopId] || null}
                      credsConfigured={credsConfigured}
                      tokenExpired={tokenExpired}
                      onAction={(action) => {
                        if (action === 'purge') {
                          setPurgeTarget(it)
                          return
                        }
                        runRowAction(it.workshopId, action)
                      }}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-t border-border/40 bg-muted/20 text-[10px] text-muted-foreground">
            <span>
              {filtered.length} of {counts.total} shown
              {selected.size > 0 && ` · ${selected.size} selected`}
            </span>
            <span className="hidden md:inline">
              Click a mod name to open it on Steam · per-row actions apply immediately
            </span>
          </div>
        </div>
        <AlertDialog open={!!purgeTarget} onOpenChange={(open) => !open && setPurgeTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Remove {purgeTarget?.name || purgeTarget?.workshopId} everywhere?
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p>This removes the mod from all four places at once:</p>
                  <ul className="list-disc pl-5 space-y-0.5">
                    <li>the Steam collection</li>
                    <li>
                      the server config (<code>WorkshopItems</code>, <code>Mods</code>, <code>Map</code>)
                    </li>
                    <li>the downloaded files on disk</li>
                    <li>the panel's tracked list</li>
                  </ul>
                  <p>
                    It is then added to the ignore list so a later scan can't quietly bring it back.
                    Restart the server to apply.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  const target = purgeTarget
                  setPurgeTarget(null)
                  if (target) runRowAction(target.workshopId, 'purge')
                }}
              >
                Remove everywhere
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Subcomponents
// ─────────────────────────────────────────────────────────────────────────

type StatAccent = 'primary' | 'warning' | 'destructive' | 'muted'

function StatTile({
  label,
  value,
  icon,
  accent,
  onClick,
}: {
  label: string
  value: number
  icon: React.ReactNode
  accent: StatAccent
  onClick?: () => void
}) {
  const accentCls: Record<StatAccent, string> = {
    primary: 'border-primary/30 bg-primary/5 text-primary',
    warning: 'border-warning/40 bg-warning/5 text-warning',
    destructive: 'border-destructive/40 bg-destructive/5 text-destructive',
    muted: 'border-border/50 bg-muted/10 text-muted-foreground',
  }
  const interactive = !!onClick
  const Tag: any = interactive ? 'button' : 'div'
  return (
    <Tag
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'group rounded-md border px-3 py-2.5 text-left transition-colors',
        accentCls[accent],
        interactive && 'hover:bg-current/10 cursor-pointer'
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide opacity-80">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="text-2xl font-semibold tabular-nums mt-1 text-foreground">
        {value}
      </div>
    </Tag>
  )
}

function Row({
  item,
  selected,
  onToggleSelect,
  busy,
  credsConfigured,
  tokenExpired,
  onAction,
}: {
  item: DiffItem
  selected: boolean
  onToggleSelect: () => void
  busy: RowAction | null
  credsConfigured: boolean
  tokenExpired: boolean
  onAction: (action: RowAction) => void
}) {
  const statusMeta =
    item.status === 'synced'
      ? { label: 'In sync', cls: 'text-success border-success/40 bg-success/10', icon: <Check className="w-3 h-3" /> }
      : item.status === 'to-add'
        ? { label: 'Missing from collection', cls: 'text-warning border-warning/40 bg-warning/10', icon: <Plus className="w-3 h-3" /> }
        : item.status === 'collection-only'
          ? { label: 'Not on server', cls: 'text-primary border-primary/40 bg-primary/10', icon: <Library className="w-3 h-3" /> }
          : { label: 'Tracked only', cls: 'text-muted-foreground border-border bg-muted/40', icon: <Bookmark className="w-3 h-3" /> }

  return (
    <tr className={cn(
      'border-b border-border/30 last:border-b-0 hover:bg-muted/30 transition-colors',
      selected && 'bg-primary/5'
    )}>
      <td className="px-3 py-2 align-top">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          aria-label={`Select ${item.name || item.workshopId}`}
        />
      </td>
      <td className="px-3 py-2 align-top">
        <span className={cn('inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium', statusMeta.cls)}>
          {statusMeta.icon}
          {statusMeta.label}
        </span>
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-col min-w-0">
          <a
            href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${item.workshopId}`}
            target="_blank"
            rel="noreferrer"
            className="truncate text-foreground hover:text-primary hover:underline underline-offset-2 font-medium inline-flex items-center gap-1"
            title={item.name || item.workshopId}
          >
            {item.name || <span className="font-mono text-muted-foreground">{item.workshopId}</span>}
            <ExternalLink className="w-2.5 h-2.5 opacity-50 shrink-0" />
          </a>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/80 font-mono">
            <span>{item.workshopId}</span>
            <span>·</span>
            <span className={item.inTracked ? '' : 'opacity-50'}>{item.inTracked ? 'tracked' : 'not tracked'}</span>
            <span>·</span>
            <span className={item.inCollection ? '' : 'opacity-50'}>{item.inCollection ? 'in collection' : 'not in collection'}</span>
            <span>·</span>
            <span className={item.inServer ? '' : 'opacity-50'}>{item.inServer ? 'on server' : 'not on server'}</span>
          </div>
        </div>
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex items-center justify-end gap-1">
          {item.inServer ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => onAction('remove-server')}
              disabled={!!busy}
              title="Remove this mod from the server configuration"
            >
              {busy === 'remove-server' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Server className="w-3 h-3" />}
              <span className="ml-1 hidden sm:inline">Remove from server</span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-success hover:text-success hover:bg-success/10"
              onClick={() => onAction('add-server')}
              disabled={!!busy}
              title="Add this Workshop mod to the server configuration"
            >
              {busy === 'add-server' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Server className="w-3 h-3" />}
              <span className="ml-1 hidden sm:inline">Add to server</span>
            </Button>
          )}
          {item.inCollection ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => onAction('remove')}
              disabled={!!busy || !credsConfigured || tokenExpired}
              title={tokenExpired ? 'Steam session expired' : !credsConfigured ? 'Need Steam cookies' : 'Remove from Steam collection'}
            >
              {busy === 'remove' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Minus className="w-3 h-3" />}
              <span className="ml-1 hidden sm:inline">Remove</span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-success hover:text-success hover:bg-success/10"
              onClick={() => onAction('add')}
              disabled={!!busy || !credsConfigured || tokenExpired}
              title={tokenExpired ? 'Steam session expired' : !credsConfigured ? 'Need Steam cookies' : 'Add to Steam collection'}
            >
              {busy === 'add' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
              <span className="ml-1 hidden sm:inline">Add</span>
            </Button>
          )}
          {item.inTracked ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              onClick={() => onAction('untrack')}
              disabled={!!busy}
              title="Untrack locally"
            >
              {busy === 'untrack' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Bookmark className="w-3 h-3" />}
              <span className="ml-1 hidden sm:inline">Untrack</span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10"
              onClick={() => onAction('track')}
              disabled={!!busy}
              title="Track locally"
            >
              {busy === 'track' ? <Loader2 className="w-3 h-3 animate-spin" /> : <BookmarkPlus className="w-3 h-3" />}
              <span className="ml-1 hidden sm:inline">Track</span>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={!!busy} title="More">
                <span className="text-base leading-none">⋯</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide">{item.workshopId}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a
                  href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${item.workshopId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="cursor-pointer"
                >
                  <ExternalLink className="w-3.5 h-3.5 mr-2" />
                  Open on Steam
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => { navigator.clipboard.writeText(item.workshopId).catch(() => {}) }}
              >
                <Library className="w-3.5 h-3.5 mr-2" />
                Copy workshop ID
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => onAction('purge')}
              >
                <Trash2 className="w-3.5 h-3.5 mr-2" />
                Remove everywhere
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  )
}
