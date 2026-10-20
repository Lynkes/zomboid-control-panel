import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, AlertTriangle, ChevronRight, HeartPulse, Info, Loader2, RefreshCw, ShieldCheck, Wrench } from 'lucide-react'
import { ApiError, type ModHealth, type ModHealthFix, type ModHealthFixResult, type ModHealthIssue, type ModHealthSeverity } from '@/lib/api'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useToast } from '@/components/ui/use-toast'
import { SectionCard } from '@/components/ui/section-card'
import { StatStrip } from '@/components/ui/stat-strip'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { DisabledReason } from '@/components/DisabledReason'
import { EmptyState } from '@/components/EmptyState'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useDateFormat } from '@/lib/dateFormat'
import { cn } from '@/lib/utils'
import { SteamStatusLine } from './SteamStatusLine'
import { canonicalFixParams, isDestructiveFix, plannedSafeFixes, useHealthText } from './healthText'
import type { ModHealthStore } from './useModHealth'

export interface HealthViewProps {
  store: ModHealthStore
  canManage: boolean
  /** Non-null: every fix button is disabled with this reason (e.g. unsaved load order). */
  blockedReason?: string | null
  modName: (modId: string) => string | undefined
  itemTitle: (workshopId: string) => string | undefined
  onShowMod: (modId: string) => void
  onShowWorkshopItem: (workshopId: string) => void
  /** After a fix wrote the server ini: the page reloads its config and plan. */
  onFixed: (result: ModHealthFixResult) => void
  /** Steam refresh (insights refresh=1, then health reload); optional. */
  onRefreshSteam?: () => void
  steamRefreshing?: boolean
  /** The page's "Fix everything" button: the view's primary when given. */
  fixEverything?: ReactNode
}

const SEVERITIES: ModHealthSeverity[] = ['critical', 'warning', 'info']

const SEVERITY_ICON = {
  critical: { Icon: AlertCircle, className: 'text-destructive' },
  warning: { Icon: AlertTriangle, className: 'text-warning' },
  info: { Icon: Info, className: 'text-muted-foreground' },
} as const

/**
 * The Health view of the Mods page: everything the panel found wrong with
 * the active server's mod list, worst first, each problem in plain words
 * with the fixes the server offers for it. A fix that removes something asks
 * first; "Fix all safe issues" applies the fixes that only add, one by one.
 */
export function HealthView({
  store,
  canManage,
  blockedReason = null,
  modName,
  itemTitle,
  onShowMod,
  onShowWorkshopItem,
  onFixed,
  onRefreshSteam,
  steamRefreshing = false,
  fixEverything,
}: HealthViewProps) {
  const { t } = useTranslation('modHealth')
  const { formatDateTime } = useDateFormat()
  const { toast } = useToast()
  const confirm = useConfirm()
  const text = useHealthText({ modName, itemTitle })
  const { health, loadState } = store
  const [busyIssue, setBusyIssue] = useState<string | null>(null)
  const [fixAll, setFixAll] = useState<{ current: number; total: number; label: string } | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)

  const busy = busyIssue !== null || fixAll !== null
  const fixReason = !canManage ? t('noPermission') : blockedReason
  const grouped = useMemo(() => {
    const map: Record<ModHealthSeverity, ModHealthIssue[]> = { critical: [], warning: [], info: [] }
    for (const issue of health?.issues ?? []) map[issue.severity]?.push(issue)
    return map
  }, [health])
  const safePlan = useMemo(() => plannedSafeFixes(health, text.fixLabel), [health, text.fixLabel])

  const applyOne = async (issue: ModHealthIssue, fix: ModHealthFix) => {
    if (busy || fixReason) return
    const label = text.fixLabel(fix)
    if (isDestructiveFix(fix)) {
      const ok = await confirm({
        title: t('confirm.title'),
        description: t(`confirm.${fix.action}`),
        items: text.removedTargets(fix),
        confirmLabel: t('confirm.remove'),
        destructive: true,
      })
      if (!ok) return
    }
    setBusyIssue(issue.id)
    try {
      // A backupWarning on the answer is toasted by api.ts's handleResponse.
      const result = await store.applyFix(issue, fix)
      onFixed(result)
      toast(result.applied
        ? { title: t('toast.fixedTitle'), description: label }
        : { title: t('toast.unchangedTitle'), description: t('toast.unchangedDesc') })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'MODS_HEALTH_ISSUE_GONE') {
        toast({ title: t('toast.goneTitle'), description: t('toast.goneDesc') })
        void store.reload()
      } else {
        toast({ title: t('toast.failedTitle'), description: getUserErrorMessage(error, t('toast.failedFallback')), variant: 'destructive' })
      }
    } finally {
      setBusyIssue(null)
    }
  }

  const applyAllSafe = async () => {
    if (busy || fixReason || safePlan.length === 0) return
    const ok = await confirm({
      title: t('fixAll.confirmTitle', { count: safePlan.length }),
      description: t('fixAll.confirmDesc'),
      items: safePlan.map((entry) => entry.label),
      confirmLabel: t('fixAll.confirmLabel'),
      destructive: false,
    })
    if (!ok) return
    let latest: ModHealth | null = health
    let applied = 0
    let skipped = 0
    let lastResult: ModHealthFixResult | null = null
    try {
      for (let i = 0; i < safePlan.length; i++) {
        const { issueId, fix, label } = safePlan[i]
        setFixAll({ current: i + 1, total: safePlan.length, label })
        // An earlier fix may have solved or changed this problem.
        const issue = latest?.issues.find((entry) => entry.id === issueId)
        const current = issue?.fixes.find((entry) => entry.action === fix.action && canonicalFixParams(entry.params) === canonicalFixParams(fix.params))
        if (!issue || !current) {
          skipped++
          continue
        }
        try {
          const result = await store.applyFix(issue, current)
          lastResult = result
          latest = result.health ?? latest
          if (result.applied) applied++
          else skipped++
        } catch (error) {
          if (error instanceof ApiError && error.code === 'MODS_HEALTH_ISSUE_GONE') {
            skipped++
            continue
          }
          toast({
            title: t('fixAll.stoppedTitle'),
            description: t('fixAll.stoppedDesc', { label, message: getUserErrorMessage(error, t('toast.failedFallback')) }),
            variant: 'destructive',
          })
          return
        }
      }
      toast({
        title: t('fixAll.doneTitle'),
        description: [t('fixAll.doneDesc', { count: applied }), skipped > 0 ? t('fixAll.skipped', { count: skipped }) : null].filter(Boolean).join(' '),
      })
    } finally {
      setFixAll(null)
      if (lastResult) onFixed(lastResult)
    }
  }

  const fixAllButton = (
    <DisabledReason reason={fixReason ?? (safePlan.length === 0 && health ? t('fixAll.noneReason') : null)}>
      <Button
        variant={fixEverything ? 'outline' : 'command'}
        size="sm"
        onClick={() => void applyAllSafe()}
        disabled={busy || !!fixReason || safePlan.length === 0}
      >
        {fixAll ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Wrench aria-hidden="true" />}
        {t('fixAll.button')}
        {safePlan.length > 0 && <span className="tabular-nums opacity-80">{safePlan.length}</span>}
      </Button>
    </DisabledReason>
  )

  const actions = (
    <>
      <Button
        variant="ghost"
        size="iconDense"
        onClick={() => void store.reload()}
        disabled={loadState === 'loading' || busy}
        aria-label={t('recheck')}
      >
        <RefreshCw className={cn(loadState === 'loading' && 'animate-spin')} aria-hidden="true" />
      </Button>
      {health && health.issues.length > 0 && fixAllButton}
      {fixEverything}
    </>
  )

  const renderIds = (issue: ModHealthIssue) => {
    if (issue.modIds.length === 0 && issue.workshopIds.length === 0) return null
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {issue.modIds.map((id) => (
          <button
            key={`m:${id}`}
            type="button"
            onClick={() => onShowMod(id)}
            aria-label={t('showMod', { name: text.mod(id) })}
            className="inline-flex min-h-7 max-w-full items-center gap-1 rounded border border-border/60 bg-muted/30 px-1.5 text-foreground hover:border-primary/40 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            <span className="truncate font-mono text-[11px]">{id}</span>
            {modName(id) && modName(id) !== id && <span className="truncate text-muted-foreground">{modName(id)}</span>}
          </button>
        ))}
        {issue.workshopIds.map((id) => (
          <button
            key={`w:${id}`}
            type="button"
            onClick={() => onShowWorkshopItem(id)}
            aria-label={t('showItem', { name: text.item(id) })}
            className="inline-flex min-h-7 max-w-full items-center gap-1 rounded border border-border/60 bg-muted/30 px-1.5 text-foreground hover:border-primary/40 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">WS</span>
            <span className="font-mono text-[11px] tabular-nums">{id}</span>
            {itemTitle(id) && <span className="truncate text-muted-foreground">{itemTitle(id)}</span>}
          </button>
        ))}
      </div>
    )
  }

  const renderIssue = (issue: ModHealthIssue) => {
    const { Icon, className } = SEVERITY_ICON[issue.severity]
    const lines = text.body(issue)
    const working = busyIssue === issue.id
    return (
      <li key={issue.id} className="space-y-2 rounded-lg border border-border/60 bg-muted/25 p-3" data-health-issue={issue.kind}>
        <div className="flex items-start gap-2">
          <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', className)} aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-1">
            <h4 className="text-sm font-medium text-foreground">{text.title(issue)}</h4>
            {lines.map((line, index) => (
              <p key={index} className="break-words text-xs leading-5 text-muted-foreground">{line}</p>
            ))}
          </div>
        </div>
        <div className="space-y-2 ps-6">
          {renderIds(issue)}
          {issue.fixes.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {issue.fixes.map((fix, index) => {
                const destructive = isDestructiveFix(fix)
                return (
                  <DisabledReason key={`${fix.action}:${index}`} reason={fixReason}>
                    <Button
                      variant={destructive ? 'destructive' : 'outline'}
                      size="sm"
                      onClick={() => void applyOne(issue, fix)}
                      disabled={busy || !!fixReason}
                      className="h-auto min-h-11 max-w-full whitespace-normal py-1.5 text-start sm:min-h-8"
                    >
                      {working ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Wrench aria-hidden="true" />}
                      <span className="min-w-0 break-words">{text.fixLabel(fix)}</span>
                    </Button>
                  </DisabledReason>
                )
              })}
            </div>
          )}
        </div>
      </li>
    )
  }

  let content
  if (!health && (loadState === 'loading' || loadState === 'idle')) {
    content = (
      <div className="space-y-3" aria-busy="true" aria-label={t('loading')}>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  } else if (!health) {
    content = (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3" role="alert">
        <AlertCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium text-foreground">{t('loadFailed')}</p>
          <p className="break-words text-xs text-muted-foreground">{getUserErrorMessage(store.error, t('loadFailed'))}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void store.reload()}>{t('retry')}</Button>
      </div>
    )
  } else {
    content = (
      <>
        <StatStrip
          items={[
            { id: 'critical', label: t('stats.critical'), value: health.counts.critical, icon: AlertCircle, tone: health.counts.critical > 0 ? 'danger' : 'default' },
            { id: 'warning', label: t('stats.warning'), value: health.counts.warning, icon: AlertTriangle, tone: health.counts.warning > 0 ? 'warning' : 'default' },
            { id: 'info', label: t('stats.info'), value: health.counts.info, icon: Info },
          ]}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{t('checkedAt', { time: formatDateTime(health.checkedAt) })}</span>
          <SteamStatusLine status={health.steamStatus} onRefresh={onRefreshSteam} refreshing={steamRefreshing} />
        </div>
        {loadState === 'error' && (
          <p className="text-xs text-destructive" role="status">{t('reloadFailed')}</p>
        )}
        {fixAll && (
          <div className="space-y-1.5 rounded-lg border border-border/60 bg-muted/25 p-3" role="status" aria-live="polite">
            <p className="flex items-center gap-2 text-xs text-foreground">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
              <span className="min-w-0 break-words">{t('fixAll.progress', { current: fixAll.current, total: fixAll.total, label: fixAll.label })}</span>
            </p>
            <Progress value={(fixAll.current / fixAll.total) * 100} aria-hidden="true" className="h-1.5" />
          </div>
        )}
        {health.issues.length === 0 ? (
          <EmptyState
            type="empty"
            compact
            icon={<ShieldCheck className="h-10 w-10 text-success" aria-hidden="true" />}
            title={t('emptyTitle')}
            description={t('emptyDesc')}
          />
        ) : (
          SEVERITIES.filter((severity) => grouped[severity].length > 0).map((severity) => {
            const issues = grouped[severity]
            const collapsible = severity === 'info'
            const open = !collapsible || infoOpen
            const headingId = `mod-health-${severity}`
            return (
              <section key={severity} aria-labelledby={headingId} className="space-y-2 border-t border-border/40 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  {collapsible ? (
                    <h3 id={headingId} className="text-sm font-medium text-foreground">
                      <button
                        type="button"
                        onClick={() => setInfoOpen(!infoOpen)}
                        aria-expanded={open}
                        className="-mx-1 flex min-h-8 items-center gap-1.5 rounded-md px-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                      >
                        <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform rtl:-scale-x-100', open && 'rotate-90 rtl:-rotate-90')} aria-hidden="true" />
                        {t(`severity.${severity}`)}
                      </button>
                    </h3>
                  ) : (
                    <h3 id={headingId} className="text-sm font-medium text-foreground">{t(`severity.${severity}`)}</h3>
                  )}
                  <span className="text-xs tabular-nums text-muted-foreground">{t('issueCount', { count: issues.length })}</span>
                </div>
                {open && <ul className="space-y-2">{issues.map(renderIssue)}</ul>}
              </section>
            )
          })
        )}
      </>
    )
  }

  return (
    <SectionCard title={t('title')} description={t('description')} icon={HeartPulse} actions={actions}>
      {content}
    </SectionCard>
  )
}
