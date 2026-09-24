import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Clock3, Crown, Flame, RefreshCw, Search, Skull, Trophy, Users, WifiOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { BridgeStatusBadge } from '@/components/BridgeStatusBadge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/EmptyState'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/PageHeader'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { panelBridgeApi } from '@/lib/api'
import { cn } from '@/lib/utils'

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

function formatNumber(value: number, language: string): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(Math.max(0, value || 0))
}

function formatDays(value: number, language: string): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.max(0, value || 0))
}

function formatDate(value: number | undefined, language: string): string | null {
  if (!Number.isFinite(value) || !value || value < 100000000000) return null
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function metricValue(player: LeaderboardPlayer, metric: LeaderboardMetric, language: string): string {
  if (metric === 'bestDays') return `${formatDays(player.bestDays, language)} d`
  if (metric === 'favoriteWeapon') return player.favoriteWeapon || '—'
  return formatNumber(player[metric], language)
}

function StatTile({ icon, label, value, detail, tone = 'default' }: {
  icon: React.ReactNode
  label: string
  value: string
  detail: string
  tone?: 'default' | 'amber' | 'red' | 'blue'
}) {
  return (
    <div className={cn(
      'min-w-0 rounded-lg border px-3 py-3 sm:px-4',
      tone === 'amber' && 'border-amber-400/25 bg-amber-400/8',
      tone === 'red' && 'border-red-400/25 bg-red-400/8',
      tone === 'blue' && 'border-sky-400/25 bg-sky-400/8',
      tone === 'default' && 'border-border/60 bg-card/50',
    )}>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
        <span className="text-primary" aria-hidden="true">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-foreground">{value}</div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  )
}

function PodiumPlace({ player, place, metric, language }: {
  player: LeaderboardPlayer
  place: 1 | 2 | 3
  metric: LeaderboardMetric
  language: string
}) {
  const placeTone = place === 1
    ? 'border-amber-400/45 bg-amber-400/10'
    : place === 2
      ? 'border-slate-300/30 bg-slate-300/8'
      : 'border-orange-400/30 bg-orange-400/8'
  const iconTone = place === 1 ? 'text-amber-300' : place === 2 ? 'text-slate-300' : 'text-orange-300'

  return (
    <div className={cn('flex min-w-0 items-center gap-3 rounded-lg border px-3 py-3', placeTone)}>
      <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-current/25 font-display text-lg', iconTone)}>
        {place === 1 ? <Crown className="h-4 w-4" aria-hidden="true" /> : place}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground" title={player.displayName}>{player.displayName}</div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn('h-1.5 w-1.5 rounded-full', player.online ? 'bg-emerald-400' : 'bg-muted-foreground/40')} aria-hidden="true" />
          <span className="truncate">{player.username}</span>
        </div>
      </div>
      <div className="shrink-0 text-end font-mono text-sm font-semibold tabular-nums text-foreground">
        {metricValue(player, metric, language)}
      </div>
    </div>
  )
}

export default function Leaderboard() {
  const { t, i18n } = useTranslation('leaderboard')
  const language = i18n.language || 'en'
  const [players, setPlayers] = useState<LeaderboardPlayer[]>([])
  const [metric, setMetric] = useState<LeaderboardMetric>('allTimeKills')
  const [query, setQuery] = useState('')
  const [trackingStartedAt, setTrackingStartedAt] = useState<number | undefined>()
  const [generatedAt, setGeneratedAt] = useState<number | undefined>()
  const [lastUpdated, setLastUpdated] = useState<number | undefined>()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bridgeConnected, setBridgeConnected] = useState(false)
  const [bridgeRunning, setBridgeRunning] = useState(false)
  const [bridgeStatusLoading, setBridgeStatusLoading] = useState(true)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    const [leaderboardResult, statusResult] = await Promise.allSettled([
      panelBridgeApi.getLeaderboard(),
      panelBridgeApi.getStatus(),
    ])

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
  }, [t])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 30000)
    return () => window.clearInterval(interval)
  }, [refresh])

  const rankedPlayers = useMemo(() => rankLeaderboard(players, metric, query), [players, metric, query])
  const onlineCount = players.filter((player) => player.online).length
  const totalKills = players.reduce((sum, player) => sum + player.allTimeKills, 0)
  const totalDeaths = players.reduce((sum, player) => sum + player.deaths, 0)
  const leader = rankedPlayers[0]
  const trackingDate = formatDate(trackingStartedAt, language)
  const dataDate = formatDate(generatedAt || lastUpdated, language)
  const hasStaleData = Boolean(error && players.length > 0)
  const metricOptions: Array<{ value: LeaderboardMetric; label: string }> = [
    { value: 'bestDays', label: t('metrics.days') },
    { value: 'currentKills', label: t('metrics.currentKills') },
    { value: 'allTimeKills', label: t('metrics.allTimeKills') },
    { value: 'deaths', label: t('metrics.deaths') },
    { value: 'favoriteWeapon', label: t('metrics.weapon') },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        icon={<Trophy className="h-5 w-5" />}
        eyebrow={t('page.eyebrow')}
        tone="ops"
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <BridgeStatusBadge
              connected={bridgeConnected}
              running={bridgeRunning}
              loading={bridgeStatusLoading}
              summary={t('bridge.summary')}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              disabled={refreshing}
              aria-label={t('actions.refresh')}
              title={t('actions.refresh')}
              className="gap-2"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} aria-hidden="true" />
              <span className="hidden sm:inline">{t('actions.refresh')}</span>
            </Button>
          </div>
        )}
      />

      {error && !hasStaleData && (
        <Alert variant="destructive">
          <WifiOff className="h-4 w-4" />
          <AlertTitle>{t('errors.title')}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{error}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
              {t('actions.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {loading && players.length === 0 ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true" aria-label={t('loading')}>
          {[1, 2, 3, 4].map((item) => <div key={item} className="h-28 animate-pulse rounded-lg border border-border/40 bg-card/40" />)}
        </div>
      ) : players.length === 0 && !error ? (
        <EmptyState
          type="noPlayers"
          title={t('empty.title')}
          description={t('empty.description')}
          action={{ label: t('actions.refresh'), onClick: () => void refresh() }}
        />
      ) : players.length > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile icon={<Users className="h-3.5 w-3.5" />} label={t('summary.players')} value={formatNumber(players.length, language)} detail={t('summary.playersDetail', { online: onlineCount })} />
            <StatTile icon={<Flame className="h-3.5 w-3.5" />} label={t('summary.allTimeKills')} value={formatNumber(totalKills, language)} detail={t('summary.allTimeKillsDetail')} tone="amber" />
            <StatTile icon={<Skull className="h-3.5 w-3.5" />} label={t('summary.deaths')} value={formatNumber(totalDeaths, language)} detail={t('summary.deathsDetail')} tone="red" />
            <StatTile icon={<Crown className="h-3.5 w-3.5" />} label={t('summary.leader')} value={leader ? metricValue(leader, metric, language) : '—'} detail={leader?.displayName || t('summary.noLeader')} tone="blue" />
          </div>

          <section className="space-y-3" aria-labelledby="leaderboard-podium-heading">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 id="leaderboard-podium-heading" className="text-sm font-semibold text-foreground">{t('podium.title')}</h2>
                <p className="text-xs text-muted-foreground">{t('podium.subtitle', { metric: metricOptions.find((option) => option.value === metric)?.label })}</p>
              </div>
              {trackingDate && <span className="text-xs text-muted-foreground">{t('trackingSince', { date: trackingDate })}</span>}
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {rankedPlayers.slice(0, 3).map((player, index) => (
                <PodiumPlace key={player.id} player={player} place={(index + 1) as 1 | 2 | 3} metric={metric} language={language} />
              ))}
            </div>
          </section>

          <Card>
            <CardHeader className="gap-3 border-b border-border/40 pb-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-sm font-semibold text-foreground">{t('table.title')}</h2>
                <p className="text-xs text-muted-foreground">{dataDate ? t('table.updated', { date: dataDate }) : t('table.waitingForUpdate')}</p>
              </div>
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                <div className="relative sm:w-56">
                  <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('table.search')} aria-label={t('table.searchAria')} className="h-9 ps-8 text-xs" />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="border-b border-border/40 px-3 py-3 sm:px-4">
                <div className="flex flex-wrap gap-1" role="tablist" aria-label={t('metrics.ariaLabel')}>
                  {metricOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="tab"
                      aria-selected={metric === option.value}
                      onClick={() => setMetric(option.value)}
                      className={cn(
                        'min-h-9 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        metric === option.value ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              {rankedPlayers.length === 0 ? (
                <EmptyState type="noResults" title={t('table.noMatchesTitle')} description={t('table.noMatchesDescription')} compact />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b border-border/40 text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                        <th scope="col" className="w-16 px-3 py-3 text-center sm:px-4">#</th>
                        <th scope="col" className="px-3 py-3 sm:px-4">{t('table.player')}</th>
                        <th scope="col" className="px-3 py-3 text-right sm:px-4">{t('table.days')}</th>
                        <th scope="col" className="px-3 py-3 text-right sm:px-4">{t('table.currentKills')}</th>
                        <th scope="col" className="px-3 py-3 text-right sm:px-4">{t('table.allTimeKills')}</th>
                        <th scope="col" className="px-3 py-3 text-right sm:px-4">{t('table.deaths')}</th>
                        <th scope="col" className="px-3 py-3 sm:px-4">{t('table.weapon')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rankedPlayers.map((player, index) => (
                        <tr key={player.id} className="border-b border-border/25 last:border-0 hover:bg-muted/25">
                          <td className="px-3 py-3 text-center font-mono text-xs tabular-nums text-muted-foreground sm:px-4">{index + 1}</td>
                          <td className="px-3 py-3 sm:px-4">
                            <div className="flex min-w-44 items-center gap-2">
                              <span className={cn('h-2 w-2 shrink-0 rounded-full', player.online ? 'bg-emerald-400' : 'bg-muted-foreground/35')} aria-label={player.online ? t('table.online') : t('table.offline')} title={player.online ? t('table.online') : t('table.offline')} />
                              <div className="min-w-0">
                                <div className="truncate font-medium text-foreground" title={player.displayName}>{player.displayName}</div>
                                <div className="truncate text-xs text-muted-foreground">{player.username}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground sm:px-4" title={t('table.currentDaysTitle', { value: formatDays(player.currentDays, language) })}>{formatDays(player.bestDays, language)} d</td>
                          <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground sm:px-4">{formatNumber(player.currentKills, language)}</td>
                          <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground sm:px-4">{formatNumber(player.allTimeKills, language)}</td>
                          <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground sm:px-4">{formatNumber(player.deaths, language)}</td>
                          <td className="max-w-40 truncate px-3 py-3 text-muted-foreground sm:px-4" title={player.favoriteWeapon || undefined}>{player.favoriteWeapon || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {hasStaleData && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t('stale.title')}</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center gap-3">
                <span>{error}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>{t('actions.retry')}</Button>
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3 w-3" aria-hidden="true" />{t('footer.refreshRate')}</span>
            <span>{t('footer.historyNote')}</span>
          </div>
        </>
      ) : null}
    </div>
  )
}
