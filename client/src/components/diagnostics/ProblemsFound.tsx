import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AlertCircle, CheckCircle, ChevronDown, ChevronRight, ListChecks, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { debugApi, modsApi, serverApi, serversApi, type ServerProblem, type ServerProblemsResult } from '@/lib/api'
import { useAuth } from '@/contexts/AuthContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { SectionCard } from '@/components/ui/section-card'
import { StatStrip } from '@/components/ui/stat-strip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/EmptyState'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { reportClientWarning } from '@/lib/client-errors'
import { useDateFormat } from '@/lib/dateFormat'
import { useHealthText } from '@/components/mods/healthText'
import { FixAllDialog } from './FixAllDialog'
import {
  buildFixAllPreview,
  groupFindings,
  isActionFix,
  isLinkFix,
  resolveHealthFix,
  undoFixAll,
  type ActionFix,
  type FixAllPreview,
  type FixAllUndo,
} from './problemFixes'
import { problemModName, useProblemText } from './useProblemText'

const SEVERITY_BADGE = { critical: 'destructive', warning: 'warning', info: 'secondary' } as const
const noName = () => undefined

/**
 * "Problems found", first on the Diagnostics page: the active server's
 * latest game log and the panel's own errors as findings (GET
 * /debug/problems), grouped by where they come from, each with what
 * happened, why, the mod, how often, when, its log lines and its fixes.
 */
export function ProblemsFound() {
  const { t } = useTranslation('problems')
  const { can } = useAuth()
  const confirm = useConfirm()
  const { toast } = useToast()
  const { formatDateTime } = useDateFormat()
  const text = useProblemText()
  const healthText = useHealthText({ modName: noName, itemTitle: noName })
  const [data, setData] = useState<ServerProblemsResult | null>(null)
  const [scanning, setScanning] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyFix, setBusyFix] = useState<string | null>(null)
  // Findings fixed in this visit: the log keeps them until the server's next start.
  const [fixed, setFixed] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [preparing, setPreparing] = useState(false)
  const [preview, setPreview] = useState<FixAllPreview | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const scan = useCallback(async (manual: boolean) => {
    setScanning(true)
    try {
      const next = await debugApi.getProblems()
      if (!alive.current) return
      setData(next && Array.isArray(next.findings) ? next : null)
      setError(null)
      if (manual) {
        const n = Array.isArray(next?.findings) ? next.findings.length : 0
        toast({ title: t('scanDone'), description: n > 0 ? t('scanDoneCount', { n }) : t('empty.title') })
      }
    } catch (err) {
      if (!alive.current) return
      reportClientWarning('Problems found: the scan failed.', err)
      setError(getUserErrorMessage(err, t('scanFailedFallback')))
    } finally {
      if (alive.current) setScanning(false)
    }
  }, [t, toast])

  useEffect(() => { void scan(false) }, [scan])

  const findings = useMemo(() => data?.findings ?? [], [data])
  const open = useMemo(() => findings.filter((f) => !fixed.has(f.id)), [findings, fixed])
  const groups = useMemo(() => groupFindings(findings), [findings])
  const hasSafeFix = open.some((f) => f.fixes.some((fix) => isActionFix(fix) && fix.safe && can(fix.capability)))

  const markFixed = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    setFixed((prev) => new Set([...prev, ...ids]))
  }, [])

  const offerUndo = useCallback((title: string, description: string, undo: FixAllUndo, findingId: string) => {
    const action = (
      <ToastAction
        altText={t('undo')}
        onClick={() => {
          void undoFixAll(undo, {
            restore: (snapshotId) => modsApi.autofixRestore(snapshotId),
            setMaxMemory: (serverId, gb) => serversApi.update(serverId, { maxMemory: gb }),
          }).then(() => {
            setFixed((prev) => {
              const next = new Set(prev)
              next.delete(findingId)
              return next
            })
            toast({ title: t('undoneToast') })
          }).catch((err) => toast({ title: t('fixAll.undoFailed', { message: getUserErrorMessage(err, t('fixAll.failedFallback')) }), variant: 'destructive' }))
        }}
      >
        {t('undo')}
      </ToastAction>
    )
    toast({ title, description, action })
  }, [t, toast])

  const runFix = useCallback(async (finding: ServerProblem, fix: ActionFix) => {
    const key = `${finding.id}:${fix.id}`
    const mod = problemModName(finding) ?? String(fix.params.modId ?? '')
    try {
      if (fix.action === 'disableMod') {
        const ok = await confirm({
          title: t('confirm.title'),
          description: t('confirm.disableMod', { mod }),
          confirmLabel: text.fixLabel(fix, finding),
          destructive: true,
        })
        if (!ok) return
        setBusyFix(key)
        const { snapshotId } = await modsApi.autofixSnapshot()
        await modsApi.toggleModId(String(fix.params.modId), false)
        markFixed([finding.id])
        offerUndo(t('toast.modDisabled', { mod }), t('toast.nextRestart'), { snapshotId, memory: [] }, finding.id)
      } else if (fix.action === 'modsHealthFix') {
        setBusyFix(key)
        const resolved = resolveHealthFix(fix, await modsApi.getModHealth())
        if (!resolved) {
          markFixed([finding.id])
          toast({ title: t('toast.healthGone') })
          return
        }
        if (!resolved.safe) {
          const ok = await confirm({
            title: t('confirm.title'),
            description: t('confirm.healthFix', { label: healthText.fixLabel(resolved.fix) }),
            confirmLabel: healthText.fixLabel(resolved.fix),
            destructive: true,
          })
          if (!ok) return
        }
        const { snapshotId } = await modsApi.autofixSnapshot()
        await modsApi.applyModHealthFix(resolved.issue.id, resolved.fix.action, resolved.fix.params)
        markFixed([finding.id])
        offerUndo(t('toast.applied'), healthText.fixLabel(resolved.fix), { snapshotId, memory: [] }, finding.id)
      } else if (fix.action === 'raiseMemory') {
        setBusyFix(key)
        const serverId = fix.params.serverId as string | number
        await serversApi.update(serverId, { maxMemory: Number(fix.params.nextGb) })
        markFixed([finding.id])
        offerUndo(
          t('toast.memory', { next: fix.params.nextGb }),
          t('toast.nextStart'),
          { snapshotId: null, memory: [{ serverId, previousGb: Number(fix.params.currentGb) }] },
          finding.id,
        )
      } else {
        const restart = fix.action === 'restartServer'
        const ok = await confirm({
          title: t('confirm.title'),
          description: restart ? t('confirm.restart') : t('confirm.start'),
          confirmLabel: text.fixLabel(fix, finding),
          variant: 'warning',
        })
        if (!ok) return
        setBusyFix(key)
        if (restart) await serverApi.restart()
        else await serverApi.start()
        toast({ title: restart ? t('toast.restarting') : t('toast.starting') })
      }
    } catch (err) {
      reportClientWarning('Problems found: a fix failed.', err)
      toast({ title: t('toast.fixFailed', { message: getUserErrorMessage(err, t('fixAll.failedFallback')) }), variant: 'destructive' })
    } finally {
      if (alive.current) setBusyFix(null)
    }
  }, [confirm, healthText, markFixed, offerUndo, t, text, toast])

  const openFixAll = useCallback(async () => {
    setPreparing(true)
    try {
      const needsHealth = open.some((f) => f.fixes.some((fix) => isActionFix(fix) && fix.action === 'modsHealthFix'))
      const health = needsHealth && can('mods.manage') ? await modsApi.getModHealth() : null
      setPreview(buildFixAllPreview(open, health, can))
    } catch (err) {
      reportClientWarning('Problems found: Fix all could not gather the fixes.', err)
      toast({ title: t('toast.fixFailed', { message: getUserErrorMessage(err, t('fixAll.failedFallback')) }), variant: 'destructive' })
    } finally {
      setPreparing(false)
    }
  }, [open, can, t, toast])

  const toggleSamples = (id: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const counts = data?.counts ?? { critical: 0, warning: 0, info: 0, total: 0 }
  const log = data?.checked?.gameLog

  const row = (f: ServerProblem) => {
    const mod = problemModName(f)
    const isFixed = fixed.has(f.id)
    const actions = f.fixes.filter(isActionFix)
    const allowed = actions.filter((fix) => can(fix.capability))
    const links = f.fixes.filter(isLinkFix)
    const showSamples = expanded.has(f.id)
    const seen = f.lastSeen ? formatDateTime(f.lastSeen) : null
    return (
      <li key={f.id} className="space-y-2 rounded-lg border border-border/60 bg-muted/25 p-3" data-testid="problem-row">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={SEVERITY_BADGE[f.severity]} className="text-[10px]">{t(`severity.${f.severity}`)}</Badge>
              <h4 className="min-w-0 break-words text-sm font-medium text-foreground" dir="auto">{text.title(f)}</h4>
            </div>
            <p className="text-xs text-muted-foreground">{text.why(f)}</p>
          </div>
          <div className="shrink-0 text-end text-xs tabular-nums text-muted-foreground">
            <p>{t('times', { n: f.count })}</p>
            {seen && <p>{f.timesFromLog ? t('lastSeen', { time: seen }) : t('lastSeenLog', { time: seen })}</p>}
          </div>
        </div>
        {(mod || f.workshopId) && (
          <p className="text-xs text-muted-foreground" dir="auto">
            {mod && t('modLine', { mod })}
            {mod && f.workshopId && ' · '}
            {f.workshopId && <span>{t('workshopLine')} <span className="font-mono">{f.workshopId}</span></span>}
          </p>
        )}
        {f.message && <p className="break-words font-mono text-xs text-foreground/80" dir="ltr">{f.message}</p>}
        {f.samples.length > 0 && (
          <div>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              aria-expanded={showSamples}
              onClick={() => toggleSamples(f.id)}
            >
              {showSamples ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
              {showSamples ? t('hideLines') : t('showLines', { n: f.samples.length })}
            </button>
            {showSamples && (
              <div className="mt-2 space-y-2">
                {f.samples.map((sample, i) => (
                  <pre key={i} dir="ltr" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-background/60 p-3 font-mono text-xs text-foreground/80">{sample}</pre>
                ))}
              </div>
            )}
          </div>
        )}
        {isFixed ? (
          <p className="flex items-center gap-1.5 text-xs text-foreground" role="status">
            <CheckCircle className="h-3.5 w-3.5 text-success" aria-hidden="true" />
            {t('fixedNote')}
          </p>
        ) : (allowed.length > 0 || links.length > 0) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {allowed.map((fix) => {
              const key = `${f.id}:${fix.id}`
              return (
                <Button key={fix.id} size="sm" variant="outline" disabled={busyFix !== null} onClick={() => void runFix(f, fix)}>
                  {busyFix === key && <Loader2 className="animate-spin" aria-hidden="true" />}
                  {text.fixLabel(fix, f)}
                </Button>
              )
            })}
            {links.map((fix) => (
              <Button key={fix.id} size="sm" variant="ghost" asChild>
                <Link to={fix.to}>{text.fixLabel(fix, f)}</Link>
              </Button>
            ))}
          </div>
        )}
        {!isFixed && allowed.length < actions.length && (
          <p className="text-xs text-muted-foreground">{t('noPermission')}</p>
        )}
      </li>
    )
  }

  const checkedDescription = log?.found
    ? t('empty.checked', {
        lines: data?.checked.gameLogLines ?? 0,
        file: log.file,
        time: log.modified ? formatDateTime(log.modified) : '?',
        panel: data?.checked.panelErrors ?? 0,
        mods: data?.checked.mods ?? 0,
      })
    : t('empty.noLog', { panel: data?.checked?.panelErrors ?? 0 })

  return (
    <SectionCard
      title={t('title')}
      description={t('description')}
      icon={ListChecks}
      status={data ? <span className="text-xs text-muted-foreground">{t('scannedAt', { time: formatDateTime(data.scannedAt) })}</span> : undefined}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={() => void scan(true)} disabled={scanning} aria-label={t('rescan')}>
            {scanning ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            <span className="hidden sm:inline">{t('rescan')}</span>
          </Button>
          {hasSafeFix && (
            <Button variant="outline" size="sm" onClick={() => void openFixAll()} disabled={preparing || scanning}>
              {preparing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
              {t('fixAll.button')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            <span className="min-w-0 break-words text-foreground">{t('scanFailed', { message: error })}</span>
          </div>
        )}
        {!data && scanning && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('scanning')}
          </p>
        )}
        {data && findings.length === 0 && (
          <EmptyState compact type="noData" icon={<CheckCircle className="h-10 w-10 text-success" aria-hidden="true" />} title={t('empty.title')} description={checkedDescription} />
        )}
        {data && findings.length > 0 && (
          <>
            <StatStrip
              items={[
                { id: 'critical', label: t('severity.critical'), value: counts.critical, tone: counts.critical > 0 ? 'danger' : 'default' },
                { id: 'warning', label: t('severity.warning'), value: counts.warning, tone: counts.warning > 0 ? 'warning' : 'default' },
                { id: 'info', label: t('severity.info'), value: counts.info },
              ]}
            />
            <p className="text-xs text-muted-foreground">{checkedDescription}{log?.partial ? ` ${t('partialLog')}` : ''}</p>
            {groups.map((group) => (
              <section key={group.category} aria-labelledby={`problems-${group.category}`} className="space-y-2">
                <h3 id={`problems-${group.category}`} className="flex items-baseline gap-2 text-sm font-medium text-foreground">
                  {t(`category.${group.category}`)}
                  <span className="text-xs font-normal tabular-nums text-muted-foreground">{group.findings.length}</span>
                </h3>
                <ul className="space-y-2">{group.findings.map(row)}</ul>
              </section>
            ))}
          </>
        )}
      </div>
      {preview && (
        <FixAllDialog
          preview={preview}
          onClose={() => setPreview(null)}
          onChanged={(ids) => {
            if (ids.length > 0) markFixed(ids)
            else setFixed(new Set())
          }}
        />
      )}
    </SectionCard>
  )
}
