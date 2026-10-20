import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Clock3, Copy, Crown, Flame, RefreshCw, Skull, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Badge } from '@/components/ui/badge'
import { BridgeStatusBadge } from '@/components/BridgeStatusBadge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { PageAlerts, type PageAlert } from '@/components/PageAlerts'
import { SectionCard } from '@/components/ui/section-card'
import { Skeleton } from '@/components/ui/skeleton'
import { Segmented } from '@/components/ui/segmented'
import { StatStrip } from '@/components/ui/stat-strip'
import { Toolbar } from '@/components/ui/toolbar'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { formatDateTime } from '@/lib/dateFormat'
import { panelBridgeApi } from '@/lib/api'
import { useRequestGuard } from '@/hooks/useRequestGuard'
import { useSocket } from '@/contexts/SocketContext'
import {
  leaderboardRowRead,
  redactLeaderboardDiagnostics,
  type LeaderboardDiagnostics,
} from '@/lib/leaderboardDiagnostics'
import { cn, copyText } from '@/lib/utils'

type LeaderboardMetric = 'bestDays' | 'currentKills' | 'allTimeKills' | 'deaths' | 'favoriteWeapon'

export interface LeaderboardPlayer {
  id: string
  username: string
  displayName: string
  online: boolean
  currentKills: number
  allTimeKills: number
  currentDays: number
  bestDays: number
  deaths: number
  favoriteWeapon?: string | null
  favoriteWeaponKills: number
  lastSeenAt?: number
  // From bridges after 1.7.73 (see LeaderboardDiagnostics). lastSeenAt moves
  // on any touch, a zombie kill's weapon count included; lastSampledAt only
  // when kills and days were actually read.
  lastSampledAt?: number
  lastSampleSource?: string
  everRead?: boolean
  aliases?: string[]
  awaitingNewLife?: boolean
}

export function rankLeaderboard(
  players: LeaderboardPlayer[],
  metric: LeaderboardMetric,
  query = '',
): LeaderboardPlayer[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = normalizedQuery
    ? players.filter((player) =>
      [player.username, player.displayName, player.favoriteWeapon || '']
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
    )
    : players

  const valueFor = (player: LeaderboardPlayer) => {
    if (metric === 'favoriteWeapon') return player.favoriteWeaponKills
    return player[metric]
  }

  return [...filtered].sort((left, right) => {
    const valueDifference = valueFor(right) - valueFor(left)
    if (valueDifference !== 0) return valueDifference
    const allTimeDifference = right.allTimeKills - left.allTimeKills
    if (allTimeDifference !== 0) return allTimeDifference
    return left.username.localeCompare(right.username)
  })
}

type LeaderboardSortColumn = 'rank' | 'player' | 'bestDays' | 'currentKills' | 'allTimeKills' | 'deaths' | 'favoriteWeapon'

interface LeaderboardTableSort {
  column: LeaderboardSortColumn
  direction: 'asc' | 'desc'
}

const NUMERIC_COLUMNS: ReadonlySet<LeaderboardSortColumn> = new Set(['bestDays', 'currentKills', 'allTimeKills', 'deaths'])

/**
 * The table's own order, on top of the ranking: `ranked` is already ranked
 * by the chosen metric, so "rank" keeps (or reverses) that order and every
 * other column sorts with ties left in rank order. Rows without a favourite
 * weapon stay last in both directions.
 */
function sortLeaderboardRows(ranked: LeaderboardPlayer[], sort: LeaderboardTableSort): LeaderboardPlayer[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  const column = sort.column
  if (column === 'rank') return sort.direction === 'asc' ? ranked : [...ranked].reverse()
  return [...ranked].sort((left, right) => {
    if (column === 'player') {
      return sign * left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' })
    }
    if (column === 'favoriteWeapon') {
      const a = left.favoriteWeapon || ''
      const b = right.favoriteWeapon || ''
      if (!a || !b) return a ? -1 : b ? 1 : 0
      return sign * a.localeCompare(b, undefined, { sensitivity: 'base' })
    }
    return sign * (left[column] - right[column])
  })
}

function formatNumber(value: number, language: string): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(Math.max(0, value || 0))
}

function formatDays(value: number, language: string): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.max(0, value || 0))
}

function formatDate(value: number | undefined, language: string): string | null {
  if (!Number.isFinite(value) || !value || value < 100000000000) return null
  return formatDateTime(value, { language, style: 'medium' })
}

function metricValue(player: LeaderboardPlayer, metric: LeaderboardMetric, language: string, t: TFunction): string {
  if (metric === 'bestDays') return t('daysShort', { value: formatDays(player.bestDays, language) })
  if (metric === 'favoriteWeapon') return player.favoriteWeapon || '—'
  return formatNumber(player[metric], language)
}

function playerLink(player: LeaderboardPlayer): string {
  return `/players?player=${encodeURIComponent(player.username)}`
}

// Gold, silver and bronze: the rank colours are the meaning here, so they
// stay literal instead of borrowing the status tokens.
const PODIUM_TONE = {
  1: { box: 'border-amber-400/40 bg-amber-400/10', icon: 'text-amber-300' },
  2: { box: 'border-slate-300/30 bg-slate-300/10', icon: 'text-slate-300' },
  3: { box: 'border-orange-400/30 bg-orange-400/10', icon: 'text-orange-300' },
} as const

function PodiumPlace({ player, place, metric, language }: {
  player: LeaderboardPlayer
  place: 1 | 2 | 3
  metric: LeaderboardMetric
  language: string
}) {
  const { t } = useTranslation('leaderboard')
  const tone = PODIUM_TONE[place]

  return (
    <div className={cn('flex min-w-0 items-center gap-3 rounded-lg border px-3 py-3', tone.box)}>
      <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/60 text-base font-semibold tabular-nums', tone.icon)}>
        {place === 1 ? <Crown className="h-4 w-4" aria-hidden="true" /> : place}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground" title={player.displayName}>{player.displayName}</div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn('h-1.5 w-1.5 rounded-full', player.online ? 'bg-success' : 'bg-muted-foreground/40')} aria-hidden="true" />
          <span className="truncate">{player.username}</span>
        </div>
      </div>
      <div className="shrink-0 text-end text-sm font-semibold tabular-nums text-foreground">
        {metricValue(player, metric, language, t)}
      </div>
    </div>
  )
}

// The username line of a table row: the last read time as its tooltip, and
// a "Not read yet" badge for a row the bridge has never read (only bridges
// that report reads, after 1.7.73, can say so).
function PlayerNameLine({ player, diagnostics, language }: {
  player: LeaderboardPlayer
  diagnostics: LeaderboardDiagnostics | null
  language: string
}) {
  const { t } = useTranslation('leaderboard')
  const readDate = formatDate(player.lastSampledAt, language)
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="truncate" title={readDate ? t('table.lastRead', { date: readDate }) : undefined}>{player.username}</span>
      {leaderboardRowRead(player, diagnostics) === false && (
        <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px] font-medium" title={t('table.notReadYetTitle')}>
          {t('table.notReadYet')}
        </Badge>
      )}
    </div>
  )
}

export default function Leaderboard() {
  const { t, i18n } = useTranslation('leaderboard')
  const language = i18n.language || 'en'
  const [players, setPlayers] = useState<LeaderboardPlayer[]>([])
  const [metric, setMetric] = useState<LeaderboardMetric>('allTimeKills')
  const [query, setQuery] = useState('')
  const [tableSort, setTableSort] = useState<LeaderboardTableSort>({ column: 'rank', direction: 'asc' })
  const [trackingStartedAt, setTrackingStartedAt] = useState<number | undefined>()
  const [generatedAt, setGeneratedAt] = useState<number | undefined>()
  const [lastUpdated, setLastUpdated] = useState<number | undefined>()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bridgeConnected, setBridgeConnected] = useState(false)
  const [bridgeRunning, setBridgeRunning] = useState(false)
  const [bridgeStatusLoading, setBridgeStatusLoading] = useState(true)
  const [diagnostics, setDiagnostics] = useState<LeaderboardDiagnostics | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyResetTimer = useRef<number | undefined>(undefined)
  const socket = useSocket()

  // refresh() runs on the 30 s poll, on the buttons and on activeServerChanged.
  // A request sent for the server that was active a moment ago can resolve
  // AFTER the one for the new server and would overwrite its board with the
  // old server's players; the guard drops a response once a newer request
  // has started.
  const refreshGuard = useRequestGuard()

  const refresh = useCallback(async () => {
    const requestId = refreshGuard.next()
    setRefreshing(true)
    const [leaderboardResult, statusResult] = await Promise.allSettled([
      panelBridgeApi.getLeaderboard(),
      panelBridgeApi.getStatus(),
    ])
    if (refreshGuard.isStale(requestId)) return

    if (statusResult.status === 'fulfilled') {
      setBridgeRunning(Boolean(statusResult.value.isRunning))
      setBridgeConnected(Boolean(statusResult.value.isRunning && statusResult.value.modConnected))
    } else {
      setBridgeRunning(false)
      setBridgeConnected(false)
    }
    setBridgeStatusLoading(false)

    if (leaderboardResult.status === 'fulfilled' && leaderboardResult.value.success && leaderboardResult.value.data) {
      const data = leaderboardResult.value.data
      setPlayers(data.players || [])
      setTrackingStartedAt(data.trackingStartedAt)
      setGeneratedAt(data.generatedAt)
      setDiagnostics(data.diagnostics && typeof data.diagnostics === 'object' ? data.diagnostics : null)
      setLastUpdated(Date.now())
      setError(null)
    } else {
      const reason = leaderboardResult.status === 'rejected'
        ? leaderboardResult.reason
        : new Error(t('errors.unexpected'))
      setError(getUserErrorMessage(reason, t('errors.load')))
    }

    setLoading(false)
    setRefreshing(false)
  }, [t, refreshGuard])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 30000)
    return () => window.clearInterval(interval)
  }, [refresh])

  // The board belongs to one server. On a switch, drop the old server's data
  // at once (it would otherwise stay up until the next poll, up to 30 s, and
  // look like the new server's) and load the new one.
  useEffect(() => {
    if (!socket) return
    const handleActiveServerChanged = () => {
      setPlayers([])
      setTrackingStartedAt(undefined)
      setGeneratedAt(undefined)
      setLastUpdated(undefined)
      setDiagnostics(null)
      setError(null)
      setBridgeRunning(false)
      setBridgeConnected(false)
      setBridgeStatusLoading(true)
      setLoading(true)
      void refresh()
    }
    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, refresh])

  useEffect(() => () => window.clearTimeout(copyResetTimer.current), [])

  const copyDiagnostics = useCallback(async () => {
    const summary = redactLeaderboardDiagnostics({ players, generatedAt, trackingStartedAt, diagnostics })
    const ok = await copyText(JSON.stringify(summary, null, 2))
    setCopyState(ok ? 'copied' : 'failed')
    window.clearTimeout(copyResetTimer.current)
    copyResetTimer.current = window.setTimeout(() => setCopyState('idle'), 2500)
  }, [players, generatedAt, trackingStartedAt, diagnostics])

  const rankedPlayers = useMemo(() => rankLeaderboard(players, metric, query), [players, metric, query])
  const rankOf = useMemo(() => new Map(rankedPlayers.map((player, index) => [player.id, index + 1])), [rankedPlayers])
  const tableRows = useMemo(() => sortLeaderboardRows(rankedPlayers, tableSort), [rankedPlayers, tableSort])
  const onlineCount = players.filter((player) => player.online).length
  const totalKills = players.reduce((sum, player) => sum + player.allTimeKills, 0)
  const totalDeaths = players.reduce((sum, player) => sum + player.deaths, 0)
  const leader = rankedPlayers[0]
  const trackingDate = formatDate(trackingStartedAt, language)
  const dataDate = formatDate(generatedAt || lastUpdated, language)
  const lastSweepDate = formatDate(diagnostics?.lastSweepAt, language)
  const resetCount = Array.isArray(diagnostics?.resets) ? diagnostics.resets.length : 0
  const hasStaleData = Boolean(error && players.length > 0)
  // The leaderboard is read through PanelBridge: when it isn't connected, the
  // alert's fix is the bridge settings, not another retry.
  const bridgeDown = !bridgeStatusLoading && !bridgeConnected
  const alertAction = bridgeDown
    ? { label: t('actions.openBridgeSettings'), to: '/settings?tab=bridge' }
    : { label: t('actions.retry'), onClick: () => void refresh() }
  const alerts: PageAlert[] = []
  if (error && !hasStaleData) {
    alerts.push({ id: 'load-error', tone: 'error', title: t('errors.title'), description: error, action: alertAction })
  }
  if (hasStaleData) {
    alerts.push({ id: 'stale', tone: 'warning', title: t('stale.title'), description: error, action: alertAction })
  }

  const toggleSort = (column: LeaderboardSortColumn) => {
    setTableSort((current) => {
      if (current.column === column) return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      return { column, direction: NUMERIC_COLUMNS.has(column) ? 'desc' : 'asc' }
    })
  }

  const sortHeader = (column: LeaderboardSortColumn, label: React.ReactNode, className: string) => {
    const active = tableSort.column === column
    const SortIcon = active ? (tableSort.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
    return (
      <th
        scope="col"
        className={className}
        aria-sort={active ? (tableSort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button
          type="button"
          onClick={() => toggleSort(column)}
          className={cn(
            'inline-flex items-center gap-1 rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70',
            active && 'text-foreground',
          )}
        >
          {label}
          <SortIcon className={cn('h-3 w-3 shrink-0', !active && 'opacity-50')} aria-hidden="true" />
        </button>
      </th>
    )
  }

  // Shown under an empty board too: a reset (a world wipe, an unreadable
  // file) leaves it empty, and the reset count is what explains it.
  const diagnosticsFooter = (
    <>
      {diagnostics?.bridgeVersion && <span>{t('footer.bridgeVersion', { version: diagnostics.bridgeVersion })}</span>}
      {lastSweepDate && <span>{t('footer.lastSweep', { date: lastSweepDate })}</span>}
      {diagnostics && <span title={t('footer.resetsTitle')}>{t('footer.resets', { total: resetCount })}</span>}
      {!diagnostics && <span>{t('footer.oldBridge')}</span>}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void copyDiagnostics()}
        title={t('actions.copyDiagnosticsTitle')}
        className="h-7 gap-1.5 px-2 text-xs"
      >
        {copyState === 'copied'
          ? <Check className="h-3 w-3" aria-hidden="true" />
          : <Copy className="h-3 w-3" aria-hidden="true" />}
        {copyState === 'copied'
          ? t('actions.copied')
          : copyState === 'failed'
            ? t('actions.copyFailed')
            : t('actions.copyDiagnostics')}
      </Button>
    </>
  )
  const metricOptions: Array<{ value: LeaderboardMetric; label: string }> = [
    { value: 'bestDays', label: t('metrics.days') },
    { value: 'currentKills', label: t('metrics.currentKills') },
    { value: 'allTimeKills', label: t('metrics.allTimeKills') },
    { value: 'deaths', label: t('metrics.deaths') },
    { value: 'favoriteWeapon', label: t('metrics.weapon') },
  ]
  const metricLabel = metricOptions.find((option) => option.value === metric)?.label

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        status={(
          <BridgeStatusBadge
            connected={bridgeConnected}
            running={bridgeRunning}
            loading={bridgeStatusLoading}
            summary={t('bridge.summary')}
          />
        )}
        meta={trackingDate ? <span>{t('trackingSince', { date: trackingDate })}</span> : undefined}
        actions={(
          <Button
            type="button"
            variant="ghost"
            size="iconDense"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label={t('actions.refresh')}
            title={t('actions.refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} aria-hidden="true" />
          </Button>
        )}
      />

      <PageAlerts alerts={alerts} />

      {loading && players.length === 0 ? (
        <div className="space-y-6" role="status" aria-busy="true" aria-label={t('loading')}>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/60 bg-border/60 sm:grid-cols-4">
            {[1, 2, 3, 4].map((item) => (
              <div key={item} className="space-y-2 bg-card px-4 py-3">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-6 w-16" />
              </div>
            ))}
          </div>
          <div className="divide-y divide-border/40 rounded-xl border border-border/60 bg-card">
            {[1, 2, 3, 4, 5].map((item) => (
              <div key={item} className="flex items-center gap-4 px-5 py-3">
                <Skeleton className="h-4 w-6" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="ms-auto h-4 w-16" />
              </div>
            ))}
          </div>
        </div>
      ) : players.length === 0 && !error ? (
        <>
          <EmptyState
            type="noPlayers"
            title={t('empty.title')}
            description={t('empty.description')}
            action={{ label: t('actions.refresh'), onClick: () => void refresh() }}
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {diagnosticsFooter}
          </div>
        </>
      ) : players.length > 0 ? (
        <>
          <StatStrip
            items={[
              { id: 'players', icon: Users, label: t('summary.players'), value: formatNumber(players.length, language), detail: t('summary.playersDetail', { online: onlineCount }) },
              { id: 'kills', icon: Flame, label: t('summary.allTimeKills'), value: formatNumber(totalKills, language), detail: t('summary.allTimeKillsDetail'), tone: 'warning' },
              { id: 'deaths', icon: Skull, label: t('summary.deaths'), value: formatNumber(totalDeaths, language), detail: t('summary.deathsDetail'), tone: 'danger' },
              { id: 'leader', icon: Crown, label: t('summary.leader'), value: leader ? metricValue(leader, metric, language, t) : '—', detail: leader?.displayName || t('summary.noLeader') },
            ]}
          />

          {/* Search and the ranking metric shape both the podium and the table. */}
          <Toolbar
            search={{
              value: query,
              onChange: setQuery,
              placeholder: t('table.search'),
              ariaLabel: t('table.searchAria'),
              slashToFocus: true,
            }}
          >
            <Segmented
              value={metric}
              onValueChange={setMetric}
              items={metricOptions}
              ariaLabel={t('metrics.ariaLabel')}
              size="md"
            />
          </Toolbar>

          {rankedPlayers.length > 0 && (
            <SectionCard
              title={t('podium.title')}
              description={t('podium.subtitle', { metric: metricLabel })}
              density="compact"
            >
              <div className="grid gap-3 md:grid-cols-3">
                {rankedPlayers.slice(0, 3).map((player, index) => (
                  <PodiumPlace key={player.id} player={player} place={(index + 1) as 1 | 2 | 3} metric={metric} language={language} />
                ))}
              </div>
            </SectionCard>
          )}

          <SectionCard
            title={t('table.title')}
            description={dataDate ? t('table.updated', { date: dataDate }) : t('table.waitingForUpdate')}
            flush
          >
            {rankedPlayers.length === 0 ? (
              <EmptyState type="noResults" title={t('table.noMatchesTitle')} description={t('table.noMatchesDescription')} compact />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b border-border/40 text-start text-xs font-medium text-muted-foreground">
                      {sortHeader('rank', <><span aria-hidden="true">#</span><span className="sr-only">{t('table.rank')}</span></>, 'w-16 px-3 py-3 text-center sm:px-4')}
                      {sortHeader('player', t('table.player'), 'px-3 py-3 sm:px-5')}
                      {sortHeader('bestDays', t('table.days'), 'px-3 py-3 text-end sm:px-4')}
                      {sortHeader('currentKills', t('table.currentKills'), 'px-3 py-3 text-end sm:px-4')}
                      {sortHeader('allTimeKills', t('table.allTimeKills'), 'px-3 py-3 text-end sm:px-4')}
                      {sortHeader('deaths', t('table.deaths'), 'px-3 py-3 text-end sm:px-4')}
                      {sortHeader('favoriteWeapon', t('table.weapon'), 'px-3 py-3 sm:px-5')}
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((player) => (
                      <tr key={player.id} className="border-b border-border/25 last:border-0 hover:bg-muted/25">
                        <td className="px-3 py-3 text-center text-xs tabular-nums text-muted-foreground sm:px-4">{rankOf.get(player.id)}</td>
                        <td className="px-3 py-3 sm:px-5">
                          <div className="flex min-w-44 items-center gap-2">
                            <span className={cn('h-2 w-2 shrink-0 rounded-full', player.online ? 'bg-success' : 'bg-muted-foreground/35')} aria-label={player.online ? t('table.online') : t('table.offline')} title={player.online ? t('table.online') : t('table.offline')} />
                            <div className="min-w-0">
                              <Link
                                to={playerLink(player)}
                                title={t('table.openPlayer', { name: player.displayName })}
                                className="block truncate rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                              >
                                {player.displayName}
                              </Link>
                              <PlayerNameLine player={player} diagnostics={diagnostics} language={language} />
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3 text-end tabular-nums text-foreground sm:px-4" title={t('table.currentDaysTitle', { value: formatDays(player.currentDays, language) })}>{t('daysShort', { value: formatDays(player.bestDays, language) })}</td>
                        <td className="px-3 py-3 text-end tabular-nums text-foreground sm:px-4">{formatNumber(player.currentKills, language)}</td>
                        <td className="px-3 py-3 text-end tabular-nums text-foreground sm:px-4">{formatNumber(player.allTimeKills, language)}</td>
                        <td className="px-3 py-3 text-end tabular-nums text-foreground sm:px-4">{formatNumber(player.deaths, language)}</td>
                        <td className="max-w-40 truncate px-3 py-3 text-muted-foreground sm:px-5" title={player.favoriteWeapon || undefined}>{player.favoriteWeapon || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3 w-3" aria-hidden="true" />{t('footer.refreshRate')}</span>
            <span>{t('footer.historyNote')}</span>
            {diagnosticsFooter}
          </div>
        </>
      ) : null}
    </div>
  )
}
