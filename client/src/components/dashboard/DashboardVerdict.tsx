import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Loader2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { DisabledReason } from '@/components/DisabledReason'
import { cn } from '@/lib/utils'

/* -------------------------------------------------------------------------- */
/*  Verdict                                                                   */
/* -------------------------------------------------------------------------- */

export type VerdictLevel = 'calm' | 'warning' | 'critical'

export interface VerdictAction {
  label: string
  to?: string
  onClick?: () => void
  disabled?: boolean
  busy?: boolean
  /** Why the action is disabled right now -- shown via DisabledReason. Only
   * meaningful together with `disabled: true` (e.g. a missing capability). */
  reason?: string
}

export interface Verdict {
  level: VerdictLevel
  /**
   * Terse statement of what is wrong. Omitted entirely when nothing is wrong,
   * because a panel that announces its own health is just noise you learn to
   * skip past.
   */
  headline?: string
  /**
   * Inline explainer for a term inside the headline a first-time user can't
   * be expected to know (e.g. a HelpTip on "RCON"). Kept separate from
   * `headline` itself, which stays a plain string -- it also feeds the
   * status dot's `title` attribute and its sr-only echo up in Dashboard.tsx,
   * neither of which can hold JSX.
   */
  headlineHelp?: ReactNode
  /** Raw technical text, only where the operator genuinely needs it. */
  detail?: string
  action?: VerdictAction
}

export interface PresencePlayer {
  name: string
  /** Human readable join age, omitted when the join event is not known. */
  since?: string
}

function VerdictActionButton({ action }: { action: VerdictAction }) {
  if (action.to) {
    return (
      <Link
        to={action.to}
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}
      >
        {action.label}
        <ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden="true" />
      </Link>
    )
  }
  return (
    <DisabledReason reason={action.reason ?? null}>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={action.onClick}
        disabled={action.disabled || action.busy}
      >
        {action.busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        {action.label}
      </Button>
    </DisabledReason>
  )
}

/**
 * Freshness signal. The dot ticks once per successful status update, which is
 * what separates "healthy" from "the panel lost the link and is showing you
 * numbers from four minutes ago".
 */
function Freshness({ lastUpdated, stale }: { lastUpdated: Date | null; stale: boolean }) {
  const { t } = useTranslation('dashboardVerdict')
  const label = (() => {
    if (!lastUpdated) return t('noUpdateYet')
    const secs = Math.max(0, Math.round((Date.now() - lastUpdated.getTime()) / 1000))
    if (secs < 10) return t('updatedJustNow')
    if (secs < 60) return t('updatedSecondsAgo', { count: secs })
    const mins = Math.floor(secs / 60)
    if (mins < 60) return t('updatedMinutesAgo', { count: mins })
    return t('updatedHoursAgo', { count: Math.floor(mins / 60) })
  })()

  return (
    <p className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
      <span className="relative inline-flex h-1.5 w-1.5" aria-hidden="true">
        {!stale && (
          <span
            key={lastUpdated ? lastUpdated.getTime() : 'none'}
            className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/70 motion-reduce:hidden"
            style={{ animationIterationCount: 1, animationDuration: '900ms' }}
          />
        )}
        <span
          className={cn(
            'relative inline-flex h-1.5 w-1.5 rounded-full',
            stale ? 'bg-warning/70' : 'bg-success/80',
          )}
        />
      </span>
      {stale ? t('staleLink', { label }) : label}
    </p>
  )
}

export function VerdictBand({
  verdict,
  players,
  showPresence,
  lastUpdated,
  stale,
}: {
  verdict: Verdict
  players: PresencePlayer[]
  showPresence: boolean
  lastUpdated: Date | null
  stale: boolean
}) {
  const { t } = useTranslation('dashboardVerdict')
  // With nothing wrong and nobody online the band is just the freshness line,
  // so it should not reserve the space of a full section.
  const hasBody = Boolean(verdict.headline || verdict.action) || (showPresence && players.length > 0)
  return (
    <section
      aria-label={t('verdictAria')}
      role={verdict.level === 'critical' ? 'alert' : 'status'}
      className={cn(
        'px-1',
        hasBody ? 'border-b pb-3 pt-1' : 'pb-1',
        verdict.level === 'critical'
          ? 'border-destructive/25'
          : verdict.level === 'warning'
            ? 'border-warning/25'
            : 'border-border/40',
      )}
    >
      {(verdict.headline || verdict.action) && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="min-w-0 flex-1">
            {verdict.headline && (
              <h2
                className={cn(
                  'max-w-[46ch] text-base font-semibold leading-snug',
                  verdict.level === 'critical'
                    ? 'text-destructive'
                    : verdict.level === 'warning'
                      ? 'text-warning'
                      : 'text-foreground',
                )}
              >
                {verdict.headline}
                {verdict.headlineHelp}
              </h2>
            )}
            {verdict.detail && (
              <p className="mt-1 max-w-[70ch] text-sm leading-5 text-muted-foreground">
                {verdict.detail}
              </p>
            )}
          </div>
          {verdict.action && (
            <div className="shrink-0">
              <VerdictActionButton action={verdict.action} />
            </div>
          )}
        </div>
      )}

      {showPresence && players.length > 0 && (
          <ul className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
            {players.slice(0, 10).map(player => (
              <li key={player.name} className="min-w-0">
                {/* Straight to this player's card on Players (?player=). */}
                <Link
                  to={`/players?player=${encodeURIComponent(player.name)}`}
                  className="group flex items-baseline gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                >
                  <span className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-success" aria-hidden="true" />
                  <span
                    className="truncate text-sm font-medium text-foreground transition-colors group-hover:text-primary"
                    dir="auto"
                    title={player.name}
                  >
                    {player.name}
                  </span>
                  {player.since && (
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{player.since}</span>
                  )}
                </Link>
              </li>
            ))}
            {players.length > 10 && (
              <li className="text-xs tabular-nums text-muted-foreground">
                {t('andMore', { count: players.length - 10 })}
              </li>
            )}
          </ul>
      )}

      <div className={hasBody ? 'mt-2' : ''}>
        <Freshness lastUpdated={lastUpdated} stale={stale} />
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Work list                                                                 */
/* -------------------------------------------------------------------------- */

export interface WorkItem {
  id: string
  to: string
  icon: LucideIcon
  label: string
  /** Live state for this destination, rendered right aligned. */
  state?: string
  tone?: 'default' | 'good' | 'warning' | 'bad'
}

const WORK_STATE_TONE: Record<'default' | 'good' | 'warning' | 'bad', string> = {
  default: 'text-muted-foreground',
  good: 'text-success/80',
  warning: 'text-warning',
  bad: 'text-destructive',
}

/**
 * Destinations carrying their own state, so the numbers sit on the thing you
 * act on instead of in a separate read-only panel. Rows run edge to edge
 * inside a flush SectionCard.
 */
export function WorkList({ items }: { items: WorkItem[] }) {
  const { t } = useTranslation('dashboardVerdict')
  return (
    <nav aria-label={t('workListAria')} className="divide-y divide-border/40">
      {items.map(({ id, to, icon: Icon, label, state, tone }) => (
        <Link
          key={id}
          to={to}
          className="group flex min-h-11 items-center gap-3 px-4 py-2 transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
          <span className="shrink-0 text-sm text-foreground">{label}</span>
          {state && (
            <span
              className={cn(
                'ms-auto min-w-0 truncate text-end text-xs tabular-nums',
                WORK_STATE_TONE[tone ?? 'default'],
              )}
            >
              {state}
            </span>
          )}
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground rtl:-scale-x-100',
              !state && 'ms-auto',
            )}
            aria-hidden="true"
          />
        </Link>
      ))}
    </nav>
  )
}
