import { useEffect, useState, useCallback, useMemo } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import {
  RefreshCw,
  Users,
  MapPin,
  Lock,
  Shield,
  Server,
  Globe,
  Loader2,
  Filter,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Copy,
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { PageAlerts, type PageAlert } from '@/components/PageAlerts'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { SectionCard } from '@/components/ui/section-card'
import { StatStrip } from '@/components/ui/stat-strip'
import { Toolbar } from '@/components/ui/toolbar'
import { EmptyState } from '@/components/EmptyState'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Link } from 'react-router-dom'
import { useToast } from '@/components/ui/use-toast'
import { apiFetch, ApiError } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { copyText } from '@/lib/utils'

interface GameServer {
  name: string
  ip: string
  // Can be null: the server derives this from the Steam listing's addr
  // field, falling back to gameport, and stays honestly unknown (never a
  // guessed default) when neither is parseable.
  port: number | null
  gamePort?: number | null
  players: number
  maxPlayers: number
  map: string
  version: string
  vac: boolean
  isPrivate: boolean
  os: string
  dedicated?: boolean
  bots?: number
  keywords?: string
  tags?: string[]
  ping?: number | null
}

type SortField = 'name' | 'players' | 'maxPlayers' | 'ping'
type SortDirection = 'asc' | 'desc'

// The query port (used for A2S ping/connect diagnostics) is honestly null
// when the panel couldn't parse one -- never a guessed default. Ping keys
// off this directly and stay disabled when it's absent, so a fabricated
// port never gets pinged and no cache entry is ever written under a
// "port unknown" key (which would otherwise let two portless servers on
// the same IP collide into one ping result).
export function pingKey(server: Pick<GameServer, 'ip' | 'port'>): string | null {
  return server.port === null || server.port === undefined ? null : `${server.ip}:${server.port}`
}

// The human-facing address prefers the raw Steam-reported game port over
// the derived query port, falling back to the query port only if the game
// port is missing. Null when neither is known -- the caller must render an
// IP with no port rather than print the literal string "null".
export function displayPort(server: Pick<GameServer, 'port' | 'gamePort'>): number | null {
  return server.gamePort || server.port || null
}

export function displayAddress(server: Pick<GameServer, 'ip' | 'port' | 'gamePort'>): string {
  const port = displayPort(server)
  return port === null ? server.ip : `${server.ip}:${port}`
}

// Which locale key explains an empty server list, from GET /'s emptyReason
// (see deriveEmptyReason in serverFinder.js) plus the pre-existing
// apiKeyConfigured flag. 'master-unreachable' / 'no-servers-listed' /
// 'no-servers-responded' used to all render as the same generic "no
// servers found" -- three genuinely different next steps for the operator
// collapsed into one unhelpful message.
export function emptyServersDescKey(apiKeyConfigured: boolean, emptyReason?: string): string {
  if (!apiKeyConfigured) return 'emptyState.noApiKeyDesc'
  if (emptyReason === 'master-unreachable') return 'emptyState.noServersDescUnreachable'
  if (emptyReason === 'no-servers-responded') return 'emptyState.noServersDescNoneResponded'
  if (emptyReason === 'no-servers-listed') return 'emptyState.noServersDescGenuinelyEmpty'
  return 'emptyState.noServersDesc'
}

// Which locale key explains a null ping, from GET /ping's reason field (or
// 'request-failed' for a client-side fetch failure that never reached the
// server). 'unparseable-response' means the server IS running and
// reachable, just answered in a form the panel couldn't read -- a
// completely different next step from "never answered at all".
export function pingFailDescKey(reason?: string): string {
  return reason === 'unparseable-response' ? 'serverItem.pingFailUnparseable' : 'serverItem.pingFailUnreachable'
}

export default function ServerFinder() {
  const { t, i18n } = useTranslation('serverFinder')
  // The breadcrumb names the parent page by its own title.
  const { t: tServers } = useTranslation('servers')
  const [servers, setServers] = useState<GameServer[]>([])
  const [filteredServers, setFilteredServers] = useState<GameServer[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<string>('')
  const [cached, setCached] = useState(false)
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean>(true)
  // 'master-unreachable' | 'no-servers-listed' | 'no-servers-responded' from
  // GET /'s emptyReason -- undefined outside the empty master_server case.
  // Distinguishes "we couldn't even ask" from "we asked and it's genuinely
  // empty" from "we got a list but nothing on it replied", which used to
  // all render as the same generic "no servers found".
  const [emptyReason, setEmptyReason] = useState<string | undefined>(undefined)
  const [stats, setStats] = useState({ totalPlayers: 0, activeServers: 0, totalCapacity: 0 })
  const [currentPage, setCurrentPage] = useState(1)
  const { toast } = useToast()

  // Filters
  const [searchQuery, setSearchQuery] = useState('')
  const debouncedSearch = useDebouncedValue(searchQuery, 200)
  const [hideEmpty, setHideEmpty] = useState(false)
  const [hideFull, setHideFull] = useState(false)
  const [hidePrivate, setHidePrivate] = useState(false)
  const [showVacOnly, setShowVacOnly] = useState(false)
  const [versionFilter, setVersionFilter] = useState<string>('all')
  const [filtersOpen, setFiltersOpen] = useState(false)

  // Sorting
  const [sortField, setSortField] = useState<SortField>('players')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  // Pinging
  const [pingingServers, setPingingServers] = useState<Set<string>>(new Set())
  const [serverPings, setServerPings] = useState<Record<string, number | null>>({})
  // Why a null ping happened -- 'timeout' | 'socket-error' | 'unparseable-response'
  // from GET /ping's reason field, or 'request-failed' for a client-side
  // fetch failure that never reached the server at all. Server-computed and
  // previously discarded entirely; a null ping used to render identically
  // whether the server never answered or answered in a form the panel
  // couldn't read -- two completely different next steps for the operator.
  const [pingFailReasons, setPingFailReasons] = useState<Record<string, string>>({})
  
  // Pagination (client-side)
  const ITEMS_PER_PAGE = 50

  const fetchServers = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError(null)
    setCurrentPage(1) // Reset to page 1 on refresh

    try {
      const url = forceRefresh ? '/api/server-finder?refresh=true' : '/api/server-finder'
      const response = await apiFetch(url.replace('/api', ''))
      const data = await response.json().catch(() => null)

      // apiFetch() is the raw, unwrapped primitive (unlike xApi.method()
      // calls elsewhere, which go through lib/api's handleResponse()) --
      // callers are responsible for their own status/code handling.
      // GET /server-finder's only failure mode is an uncoded 500 with
      // success:false (server/routes/serverFinder.js), so a plain
      // `throw new Error(data.error)` here discarded response.status
      // before getUserErrorMessage() below could ever translate it via
      // the generic-500 wrapper -- same shape as the raw-fetch sites
      // fixed earlier tonight (AuthContext.tsx, FileDiffViewer.tsx,
      // Debug.tsx, Login.tsx).
      if (!response.ok || !data || data.success === false) {
        throw new ApiError(data?.error || `HTTP ${response.status}`, {
          status: response.status,
          code: data?.code,
        })
      }

      setServers(data.servers || [])
      setSource(data.source || 'unknown')
      setCached(data.cached || false)
      setApiKeyConfigured(data.apiKeyConfigured !== false)
      setEmptyReason(data.emptyReason)
      setStats({
        totalPlayers: data.totalPlayers || 0,
        activeServers: data.activeServers || 0,
        totalCapacity: data.totalCapacity || 0,
      })

      if (data.apiKeyConfigured === false) {
        setError(t('toasts.apiKeyMissing'))
      }

      if (data.servers?.length > 0) {
        toast({
          title: data.cached ? t('toasts.loadedCachedTitle') : t('toasts.loadedTitle'),
          description: t('toasts.loadedDesc', { count: data.count, players: data.totalPlayers || 0 }),
        })
      }
    } catch (err) {
      setError(getUserErrorMessage(err, t('toasts.fetchFailedFallback')))
    } finally {
      setLoading(false)
    }
  }, [toast, t])

  // Initial fetch
  useEffect(() => {
    fetchServers()
  }, [fetchServers])

  // Apply filters and sorting
  useEffect(() => {
    let result = [...servers]

    // Search filter
    if (debouncedSearch) {
      const query = debouncedSearch.toLowerCase()
      result = result.filter(
        s =>
          s.name.toLowerCase().includes(query) ||
          s.ip.includes(query) ||
          s.map?.toLowerCase().includes(query) ||
          s.keywords?.toLowerCase().includes(query)
      )
    }

    // Boolean filters
    if (hideEmpty) {
      result = result.filter(s => s.players > 0)
    }
    if (hideFull) {
      result = result.filter(s => s.players < s.maxPlayers)
    }
    if (hidePrivate) {
      result = result.filter(s => !s.isPrivate)
    }
    if (showVacOnly) {
      result = result.filter(s => s.vac)
    }
    // Version filter
    if (versionFilter && versionFilter !== 'all') {
      result = result.filter(s => s.version === versionFilter)
    }

    // Sorting
    result.sort((a, b) => {
      let aVal: number | string
      let bVal: number | string

      switch (sortField) {
        case 'name':
          aVal = a.name.toLowerCase()
          bVal = b.name.toLowerCase()
          break
        case 'players':
          aVal = a.players
          bVal = b.players
          break
        case 'maxPlayers':
          aVal = a.maxPlayers
          bVal = b.maxPlayers
          break
        case 'ping': {
          const aKey = pingKey(a)
          const bKey = pingKey(b)
          aVal = (aKey ? serverPings[aKey] : undefined) ?? 9999
          bVal = (bKey ? serverPings[bKey] : undefined) ?? 9999
          break
        }
        default:
          return 0
      }

      if (typeof aVal === 'string') {
        return sortDirection === 'asc'
          ? aVal.localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal)
      }

      return sortDirection === 'asc' ? aVal - (bVal as number) : (bVal as number) - aVal
    })

    setFilteredServers(result)
    // Only reset to page 1 when actual filters/sort change, not when pings update
  }, [servers, debouncedSearch, hideEmpty, hideFull, hidePrivate, showVacOnly, versionFilter, sortField, sortDirection]) // eslint-disable-line react-hooks/exhaustive-deps -- serverPings intentionally excluded to avoid pagination reset on ping updates

  useEffect(() => {
    setCurrentPage(1)
  }, [debouncedSearch, hideEmpty, hideFull, hidePrivate, showVacOnly, versionFilter, sortField, sortDirection])

  // Re-sort when pings arrive without resetting the current page
  useEffect(() => {
    if (sortField !== 'ping') return
    setFilteredServers(prev => {
      const sorted = [...prev]
      sorted.sort((a, b) => {
        const aKey = pingKey(a)
        const bKey = pingKey(b)
        const aVal = (aKey ? serverPings[aKey] : undefined) ?? 9999
        const bVal = (bKey ? serverPings[bKey] : undefined) ?? 9999
        return sortDirection === 'asc' ? aVal - bVal : bVal - aVal
      })
      return sorted
    })
  }, [serverPings, sortField, sortDirection])

  // Compute available versions from servers
  const availableVersions = useMemo(() => {
    const versions = new Set<string>()
    servers.forEach(s => {
      if (s.version) versions.add(s.version)
    })
    return Array.from(versions).sort((a, b) => {
      // Sort versions descending (newest first)
      const aParts = a.split('.').map(Number)
      const bParts = b.split('.').map(Number)
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aVal = aParts[i] || 0
        const bVal = bParts[i] || 0
        if (aVal !== bVal) return bVal - aVal
      }
      return 0
    })
  }, [servers])

  // A refresh can drop the version the operator filtered on (the last server
  // running it went offline). The Select then shows nothing selected and the
  // list stays empty with no visible reason, so fall back to "all versions".
  useEffect(() => {
    if (versionFilter !== 'all' && !availableVersions.includes(versionFilter)) {
      setVersionFilter('all')
    }
  }, [availableVersions, versionFilter])

  // Calculate pagination from filtered servers
  const totalPages = Math.max(1, Math.ceil(filteredServers.length / ITEMS_PER_PAGE))

  useEffect(() => {
    setCurrentPage(prev => Math.min(prev, totalPages))
  }, [totalPages])

  const paginatedServers = useMemo(() => filteredServers.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  ), [filteredServers, currentPage])

  const goToPage = (page: number) => {
    const validPage = Math.max(1, Math.min(page, totalPages))
    setCurrentPage(validPage)
  }

  // Goes through copyText (not the raw clipboard API directly) so this
  // still works over a plain-HTTP LAN deployment -- navigator.clipboard
  // requires a secure context and is unavailable there; copyText falls
  // back to execCommand.
  const copyAddress = async (address: string) => {
    const ok = await copyText(address)
    if (ok) {
      toast({ title: t('serverItem.addressCopiedTitle'), description: address })
    } else {
      toast({
        title: t('serverItem.addressCopyFailedTitle'),
        variant: 'destructive',
      })
    }
  }

  const pingServer = async (ip: string, port: number | null) => {
    if (port === null) return // no known query port -- nothing to ping
    const key = `${ip}:${port}`
    if (pingingServers.has(key)) return

    setPingingServers(prev => new Set([...prev, key]))

    try {
      // Must go through apiFetch, not a bare fetch(): /server-finder is
      // gated by requirePermission('server.install'), which needs the
      // Authorization: Bearer header apiFetch attaches. A bare fetch omits
      // it, so the panel's own auth middleware 401s every ping before it
      // ever reaches the UDP query -- indistinguishable client-side from a
      // real "server didn't respond", so every ping silently showed N/A.
      const response = await apiFetch(`/server-finder/ping?ip=${ip}&port=${port}`)
      const data = await response.json()

      if (data.success && data.ping !== null) {
        setServerPings(prev => ({ ...prev, [key]: data.ping }))
        setPingFailReasons(prev => { const { [key]: _drop, ...rest } = prev; return rest })
      } else {
        setServerPings(prev => ({ ...prev, [key]: null }))
        setPingFailReasons(prev => ({ ...prev, [key]: data.reason || 'timeout' }))
      }
    } catch {
      setServerPings(prev => ({ ...prev, [key]: null }))
      setPingFailReasons(prev => ({ ...prev, [key]: 'request-failed' }))
    } finally {
      setPingingServers(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDirection(field === 'name' ? 'asc' : 'desc')
    }
  }

  const SortButton = ({ field, label }: { field: SortField; label: string }) => (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => toggleSort(field)}
      className="h-8 px-2 flex items-center gap-1"
      aria-label={sortField === field
        ? t('serverList.sortAriaWithDirection', { label, direction: sortDirection === 'asc' ? t('serverList.directionAscending') : t('serverList.directionDescending') })
        : t('serverList.sortAria', { label })}
    >
      {label}
      {sortField === field ? (
        sortDirection === 'asc' ? (
          <ChevronUp className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        )
      ) : (
        <ArrowUpDown className="h-4 w-4 opacity-50" />
      )}
    </Button>
  )

  const getPingColor = (ping: number | null | undefined) => {
    if (ping === null || ping === undefined) return 'text-muted-foreground'
    if (ping < 50) return 'text-primary'
    if (ping < 100) return 'text-warning'
    if (ping < 200) return 'text-warning'
    return 'text-destructive'
  }

  // The API-key fetch also records its own "key missing" error; the warning
  // below already says that (with the steps), so it isn't repeated as an error.
  const apiKeyMissing = !apiKeyConfigured && !loading
  const alerts: PageAlert[] = []
  if (error && !(apiKeyMissing && error === t('toasts.apiKeyMissing'))) {
    alerts.push({
      id: 'load-error',
      tone: 'error',
      title: t('error.title'),
      description: error,
      action: { label: t('error.retry'), onClick: () => void fetchServers() },
    })
  }
  if (apiKeyMissing) {
    alerts.push({
      id: 'api-key',
      tone: 'warning',
      title: t('apiKeyWarning.title'),
      description: (
        <div className="space-y-1">
          <p>{t('apiKeyWarning.description')}</p>
          <ol className="list-inside list-decimal space-y-1">
            <li>
              <Trans
                i18nKey="apiKeyWarning.step1"
                t={t}
                components={{
                  1: <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" />,
                  2: <span className="sr-only" />,
                }}
              />
            </li>
            <li>
              <Trans
                i18nKey="apiKeyWarning.step2"
                t={t}
                components={{ 1: <Link to="/settings?tab=mods" className="text-primary hover:underline" /> }}
              />
            </li>
            <li>{t('apiKeyWarning.step3')}</li>
          </ol>
        </div>
      ),
      action: { label: t('apiKeyWarning.action'), to: '/settings?tab=mods' },
    })
  }

  const isFiltered = filteredServers.length !== servers.length
  const resetFilters = () => {
    setSearchQuery('')
    setHideEmpty(false)
    setHideFull(false)
    setHidePrivate(false)
    setShowVacOnly(false)
    setVersionFilter('all')
  }

  const pagination = filteredServers.length > ITEMS_PER_PAGE && (
    <>
      <p className="me-auto text-xs text-muted-foreground">
        {t('pagination.showing', {
          from: ((currentPage - 1) * ITEMS_PER_PAGE) + 1,
          to: Math.min(currentPage * ITEMS_PER_PAGE, filteredServers.length),
          total: filteredServers.length.toLocaleString(i18n.language),
        })}
      </p>
      <nav aria-label={t('pagination.nav')} className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => goToPage(1)}
          disabled={currentPage <= 1}
          aria-label={t('pagination.firstAria')}
        >
          <ChevronsLeft className="rtl:-scale-x-100" aria-hidden="true" />
          <span className="hidden sm:inline">{t('pagination.first')}</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage <= 1}
          aria-label={t('pagination.prevAria')}
        >
          <ChevronLeft className="rtl:-scale-x-100" aria-hidden="true" />
          <span className="hidden sm:inline">{t('pagination.prev')}</span>
        </Button>
        <span className="px-1.5 text-xs font-medium tabular-nums" aria-current="page">
          {t('pagination.pageOf', { current: currentPage, total: totalPages })}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => goToPage(currentPage + 1)}
          disabled={currentPage >= totalPages}
          aria-label={t('pagination.nextAria')}
        >
          <span className="hidden sm:inline">{t('pagination.next')}</span>
          <ChevronRight className="rtl:-scale-x-100" aria-hidden="true" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => goToPage(totalPages)}
          disabled={currentPage >= totalPages}
          aria-label={t('pagination.lastAria')}
        >
          <span className="hidden sm:inline">{t('pagination.last')}</span>
          <ChevronsRight className="rtl:-scale-x-100" aria-hidden="true" />
        </Button>
      </nav>
    </>
  )

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        breadcrumb={[{ label: tServers('pageHeader.title'), to: '/servers' }]}
        actions={
          // One Refresh: the panel's cached list, with "Reload from Steam"
          // (ask Steam directly) in its menu.
          <div className="flex items-center">
            <Button variant="outline" size="sm" onClick={() => fetchServers(false)} disabled={loading} className="rounded-e-none">
              {loading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              {t('pageHeader.refreshList')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  aria-label={t('pageHeader.refreshMenuAria')}
                  className="rounded-s-none border-s-0 px-2"
                >
                  <ChevronDown aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[min(20rem,calc(100vw-2rem))]">
                <DropdownMenuItem onSelect={() => fetchServers(true)} className="items-start gap-2.5 py-2">
                  <RefreshCw className="mt-0.5 text-muted-foreground" aria-hidden="true" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">{t('pageHeader.reloadFromSteam')}</span>
                    <span className="text-xs text-muted-foreground">{t('pageHeader.reloadFromSteamTip')}</span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      <PageAlerts alerts={alerts} />

      <StatStrip
        items={[
          {
            id: 'total',
            icon: Server,
            label: t('stats.totalServers'),
            value: servers.length.toLocaleString(i18n.language),
            detail: `${source === 'steam_api' ? t('stats.viaSteamApi') : t('stats.viaMasterServer')}${cached ? t('stats.cachedSuffix') : ''}`,
          },
          {
            id: 'active',
            icon: Globe,
            label: t('stats.activeServers'),
            value: stats.activeServers.toLocaleString(i18n.language),
            detail: t('stats.withPlayersOnline'),
          },
          {
            id: 'players',
            icon: Users,
            label: t('stats.totalPlayers'),
            value: stats.totalPlayers.toLocaleString(i18n.language),
            detail: t('stats.playingNow'),
          },
          {
            id: 'showing',
            icon: Filter,
            label: t('stats.showing'),
            value: filteredServers.length.toLocaleString(i18n.language),
            detail: isFiltered ? t('stats.filteredOf', { count: servers.length.toLocaleString(i18n.language) }) : t('stats.matchingFilters'),
            tone: isFiltered ? 'warning' : 'default',
          },
        ]}
      />

      <SectionCard
        title={t('serverList.title')}
        description={t('serverList.description')}
        flush
        footer={pagination || undefined}
      >
        <div className="space-y-3 p-4">
          <Toolbar
            search={{
              value: searchQuery,
              onChange: (value) => setSearchQuery(value.slice(0, 128)),
              placeholder: t('searchFilters.searchPlaceholder'),
              ariaLabel: t('searchFilters.searchAria'),
              slashToFocus: true,
            }}
            end={
              <div className="flex flex-wrap items-center gap-1">
                <SortButton field="name" label={t('searchFilters.sortName')} />
                <SortButton field="players" label={t('searchFilters.sortPlayers')} />
                <SortButton field="ping" label={t('searchFilters.sortPing')} />
              </div>
            }
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFiltersOpen(!filtersOpen)}
              aria-expanded={filtersOpen}
              aria-controls="server-finder-filters"
            >
              <Filter aria-hidden="true" />
              {filtersOpen ? t('searchFilters.hideFilters') : t('searchFilters.showFilters')}
            </Button>
          </Toolbar>

          {filtersOpen && (
            <div id="server-finder-filters" className="space-y-4 rounded-xl border border-border/70 bg-background/40 p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="hideEmpty"
                    checked={hideEmpty}
                    onCheckedChange={(checked) => setHideEmpty(checked === true)}
                  />
                  <Label htmlFor="hideEmpty" className="cursor-pointer text-sm">
                    {t('searchFilters.hideEmpty')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="hideFull"
                    checked={hideFull}
                    onCheckedChange={(checked) => setHideFull(checked === true)}
                  />
                  <Label htmlFor="hideFull" className="cursor-pointer text-sm">
                    {t('searchFilters.hideFull')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="hidePrivate"
                    checked={hidePrivate}
                    onCheckedChange={(checked) => setHidePrivate(checked === true)}
                  />
                  <Label htmlFor="hidePrivate" className="cursor-pointer text-sm">
                    {t('searchFilters.hidePrivate')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="showVacOnly"
                    checked={showVacOnly}
                    onCheckedChange={(checked) => setShowVacOnly(checked === true)}
                  />
                  <Label htmlFor="showVacOnly" className="cursor-pointer text-sm">
                    {t('searchFilters.vacOnly')}
                  </Label>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
                <Label className="text-sm">{t('searchFilters.versionLabel')}</Label>
                <Select value={versionFilter} onValueChange={setVersionFilter}>
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder={t('searchFilters.allVersions')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('searchFilters.allVersions')}</SelectItem>
                    {availableVersions.map(v => (
                      <SelectItem key={v} value={v}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-border/60">
          {loading ? (
            <div role="status" aria-busy="true" aria-label={t('serverList.loading')} className="divide-y divide-border/60">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="h-8 w-8 shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-48 max-w-full" />
                    <Skeleton className="h-3 w-32 max-w-full" />
                  </div>
                  <Skeleton className="hidden h-8 w-20 sm:block" />
                </div>
              ))}
            </div>
          ) : filteredServers.length === 0 ? (
            <div className="px-4 py-10">
              {servers.length === 0 ? (
                <EmptyState
                  type="noResults"
                  title={apiKeyConfigured ? t('emptyState.noServersTitle') : t('emptyState.noApiKeyTitle')}
                  description={t(emptyServersDescKey(apiKeyConfigured, emptyReason))}
                />
              ) : (
                <EmptyState
                  type="noResults"
                  title={t('emptyState.noMatchTitle')}
                  description={t('emptyState.noMatchDesc')}
                  action={{ label: t('emptyState.clearFilters'), onClick: resetFilters }}
                />
              )}
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {paginatedServers.map((server, index) => {
                const serverKey = `${server.ip}:${server.port}`
                const pKey = pingKey(server)
                const ping = pKey ? serverPings[pKey] : undefined
                const isPinging = pKey ? pingingServers.has(pKey) : false
                const address = displayAddress(server)
                const isFull = server.players >= server.maxPlayers && server.maxPlayers > 0
                const hasPlayers = server.players > 0 && !isFull
                const statusTone = isFull
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : hasPlayers
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border/60 bg-muted/40 text-muted-foreground'

                return (
                  <li
                    key={`${serverKey}-${index}`}
                    className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-accent/20 sm:flex-row sm:items-center sm:gap-4"
                  >
                    {/* Name and address first; on a phone the numbers wrap below */}
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md border ${statusTone}`} aria-hidden="true">
                        <Server className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <h3 className="truncate text-sm font-medium text-foreground">{server.name}</h3>
                          {server.isPrivate && (
                            <Tooltip>
                              <TooltipTrigger>
                                <Lock className="h-4 w-4 text-warning" />
                              </TooltipTrigger>
                              <TooltipContent>{t('serverItem.passwordProtected')}</TooltipContent>
                            </Tooltip>
                          )}
                          {server.vac && (
                            <Tooltip>
                              <TooltipTrigger>
                                <Shield className="h-4 w-4 text-primary" />
                              </TooltipTrigger>
                              <TooltipContent>{t('serverItem.vacSecured')}</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  copyAddress(address)
                                }}
                                className="flex items-center gap-1 rounded font-mono hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                                aria-label={t('serverItem.copyAddressAria', { address })}
                              >
                                <span dir="ltr">{address}</span>
                                <Copy className="h-3 w-3 opacity-50" aria-hidden="true" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>{t('serverItem.copyAddress')}</TooltipContent>
                          </Tooltip>
                          {server.map && (
                            <span className="flex min-w-0 items-center gap-1">
                              <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
                              <span className="truncate">{server.map}</span>
                            </span>
                          )}
                        </div>
                        {server.tags && server.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {server.tags.slice(0, 5).map((tag, i) => (
                              <Badge key={i} variant="secondary" className="max-w-[150px] truncate px-1.5 py-0 text-xs">
                                {tag}
                              </Badge>
                            ))}
                            {server.tags.length > 5 && (
                              <Badge variant="secondary" className="px-1.5 py-0 text-xs">
                                +{server.tags.length - 5}
                              </Badge>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 ps-11 sm:flex-nowrap sm:ps-0">
                      <span className="flex items-center gap-1.5 text-sm tabular-nums">
                        <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        <span
                          className={
                            server.players >= server.maxPlayers
                              ? 'font-medium text-destructive'
                              : server.players > 0
                              ? 'font-medium text-primary'
                              : 'text-muted-foreground'
                          }
                        >
                          {server.players}/{server.maxPlayers}
                        </span>
                      </span>
                      {server.version && (
                        <Badge variant="outline" className="font-mono text-xs">
                          v{server.version}
                        </Badge>
                      )}
                      <span className="flex w-14 justify-center">
                        {isPinging ? (
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
                        ) : ping !== undefined ? (
                          ping !== null ? (
                            <span className={`text-sm font-medium tabular-nums ${getPingColor(ping)}`}>
                              {t('serverItem.pingMs', { ping })}
                            </span>
                          ) : (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help text-sm font-medium text-muted-foreground">
                                  {t('serverItem.pingNa')}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-56 text-start">
                                {t(pingFailDescKey(pKey ? pingFailReasons[pKey] : undefined))}
                              </TooltipContent>
                            </Tooltip>
                          )
                        ) : pKey === null ? (
                          // No known query port -- pinging would either send
                          // a request the server rejects or, worse, silently
                          // share a cache entry with another portless server
                          // on the same IP. Reuses the existing "N/A" copy
                          // rather than a new label.
                          <span className="text-sm text-muted-foreground">{t('serverItem.pingNa')}</span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              pingServer(server.ip, server.port)
                            }}
                          >
                            {t('serverItem.pingButton')}
                          </Button>
                        )}
                      </span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="default"
                            size="sm"
                            disabled={displayPort(server) === null}
                            onClick={() => {
                              window.open(`steam://connect/${address}`, '_self')
                            }}
                          >
                            {t('serverItem.connect')}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('serverItem.connectTooltip')}</TooltipContent>
                      </Tooltip>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </SectionCard>
    </div>
  )
}
