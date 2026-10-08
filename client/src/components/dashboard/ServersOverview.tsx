import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRightLeft, Loader2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { DisabledReason } from '@/components/DisabledReason'
import { ServerUptime } from '@/components/ServerUptime'
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/contexts/SocketContext'
import { useAuth } from '@/contexts/AuthContext'
import { serversApi, type ServerInstance } from '@/lib/api'
import { autoStartEnabled, autoStartServerIds, type AutoStartSettings } from '@/lib/autoStartServers'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { cn } from '@/lib/utils'

// Every server at a glance on the Dashboard, so running several doesn't mean
// switching between them to see which are up: state and uptime from the
// per-server process scan (GET /servers/status), players from a one-off RCON
// count per server (GET /servers/rcon-status?players=1) -- the panel's own
// RCON connection reaches the active server only -- and each one's place in
// the auto-start list. Shown only with two servers or more; with one, the
// rest of the Dashboard already is that server.

const POLL_MS = 15_000

type StatusRow = Awaited<ReturnType<typeof serversApi.getStatus>>['servers'][number]
type RconRow = Awaited<ReturnType<typeof serversApi.getRconStatuses>>['servers'][number]
type RowState = 'running' | 'stopped' | 'unknown'

interface ServersOverviewProps {
  activeServerId: string | null
  autoStartSettings: AutoStartSettings
  canChangeAutoStart: boolean
  onAutoStartChange: (server: ServerInstance, chosen: boolean) => void
  /** Whether the overview is on screen (two servers or more). */
  onShownChange?: (shown: boolean) => void
}

function rowState(server: ServerInstance, status: StatusRow | undefined, rcon: RconRow | undefined): RowState {
  // The process scan only sees this machine: a remote server is up when its
  // RCON answers.
  if (server.isRemote) return rcon?.status === 'connected' ? 'running' : 'stopped'
  if (!status || status.stateUnknown) return 'unknown'
  return status.running ? 'running' : 'stopped'
}

export function ServersOverview({
  activeServerId, autoStartSettings, canChangeAutoStart, onAutoStartChange, onShownChange,
}: ServersOverviewProps) {
  const { t } = useTranslation('dashboard')
  const { toast } = useToast()
  const socket = useSocket()
  const { can } = useAuth()
  const canSwitch = can('servers.manage')
  const [servers, setServers] = useState<ServerInstance[]>([])
  const [statuses, setStatuses] = useState<Record<string, StatusRow>>({})
  const [rcon, setRcon] = useState<Record<string, RconRow>>({})
  const [switching, setSwitching] = useState<string | null>(null)
  const requestSeq = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current
    const [list, status, rconStatus] = await Promise.allSettled([
      serversApi.getAll(),
      serversApi.getStatus(),
      serversApi.getRconStatuses({ players: true }),
    ])
    // An older poll answering after a newer one must not put its rows back.
    if (seq !== requestSeq.current) return
    if (list.status === 'fulfilled') setServers(list.value?.servers ?? [])
    if (status.status === 'fulfilled') {
      setStatuses(Object.fromEntries((status.value?.servers ?? []).map((row) => [String(row.id), row])))
    }
    if (rconStatus.status === 'fulfilled') {
      setRcon(Object.fromEntries((rconStatus.value?.servers ?? []).map((row) => [String(row.id), row])))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void refresh()
    }, POLL_MS)
    return () => clearInterval(interval)
  }, [refresh, activeServerId])

  useEffect(() => {
    if (!socket) return
    const onChange = () => { void refresh() }
    socket.on('activeServerChanged', onChange)
    return () => { socket.off('activeServerChanged', onChange) }
  }, [socket, refresh])

  const shown = servers.length > 1
  useEffect(() => { onShownChange?.(shown) }, [shown, onShownChange])

  const handleSwitch = async (server: ServerInstance) => {
    if (!canSwitch) return
    setSwitching(String(server.id))
    try {
      // The Dashboard follows the active server through activeServerChanged.
      await serversApi.activate(server.id)
    } catch (error) {
      toast({
        title: t('serversOverview.switchFailed', { name: server.name || server.serverName }),
        description: getUserErrorMessage(error, t('toasts.errorTitle')),
        variant: 'destructive',
      })
    } finally {
      setSwitching(null)
    }
  }

  if (!shown) return null

  const autoStartOn = autoStartEnabled(autoStartSettings)
  const chosen = autoStartServerIds(autoStartSettings, activeServerId)
  const isActiveServer = (server: ServerInstance) =>
    activeServerId !== null ? String(server.id) === activeServerId : server.isActive
  // The active server first -- with many servers the list scrolls, and the
  // one the rest of the Dashboard shows stays in view -- then My Servers order.
  const ordered = [...servers.filter(isActiveServer), ...servers.filter((server) => !isActiveServer(server))]

  return (
    <section
      aria-labelledby="servers-overview-heading"
      className="mt-6 overflow-hidden rounded-lg border border-border/65 bg-card/50 shadow-sm"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/35 px-4 py-2">
        <h2 id="servers-overview-heading" className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary/75">
          {t('serversOverview.heading')}
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
          {t('serversOverview.runningCount', {
            running: servers.filter((server) => rowState(server, statuses[String(server.id)], rcon[String(server.id)]) === 'running').length,
            total: servers.length,
          })}
        </span>
      </header>
      {/* About six rows, then it scrolls (many installed or linked servers).
          Focusable so the keyboard can scroll it too. */}
      <ul
        data-testid="servers-overview-list"
        tabIndex={0}
        aria-labelledby="servers-overview-heading"
        className="max-h-[19rem] divide-y divide-border/30 overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {ordered.map((server) => {
          const id = String(server.id)
          const status = statuses[id]
          const rconRow = rcon[id]
          const state = rowState(server, status, rconRow)
          const isActive = isActiveServer(server)
          const players = rconRow?.status === 'connected' ? rconRow.players ?? null : null
          const name = server.name || server.serverName
          const checkboxId = `servers-overview-autostart-${id}`
          return (
            <li key={id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
              <div className="flex min-w-0 flex-1 basis-48 items-center gap-2.5">
                <span
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    state === 'running' ? 'bg-success' : state === 'unknown' ? 'bg-warning' : 'bg-muted-foreground/40',
                  )}
                  aria-hidden="true"
                />
                <span className="truncate text-sm font-medium" title={name}>{name}</span>
                {isActive && (
                  <span className="inline-flex shrink-0 items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                    {t('serversOverview.activeBadge')}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className={cn(state === 'running' && 'text-success/80', state === 'unknown' && 'text-warning/80')}>
                  {t(`serversOverview.state.${state}`)}
                </span>
                {state === 'running' && !server.isRemote && <ServerUptime startedAt={status?.startedAt} />}
                <span
                  className="inline-flex items-center gap-1 tabular-nums"
                  title={players !== null ? t('serversOverview.playersTitle', { players }) : t('serversOverview.playersUnknown')}
                >
                  <Users className="h-3 w-3" aria-hidden="true" />
                  <span className="sr-only">
                    {players !== null ? t('serversOverview.playersTitle', { players }) : t('serversOverview.playersUnknown')}
                  </span>
                  <span aria-hidden="true">{players ?? '–'}</span>
                </span>
                <span className="font-mono tabular-nums" title={t('serversOverview.gamePortTitle')}>:{server.serverPort}</span>
              </div>
              <div className="flex items-center gap-3">
                {!server.isRemote && (
                  <div className="flex items-center gap-1.5">
                    <DisabledReason reason={!canChangeAutoStart ? t('actions.noPermissionAutoStart') : null}>
                      <Checkbox
                        id={checkboxId}
                        checked={autoStartOn && chosen.includes(id)}
                        disabled={!canChangeAutoStart}
                        onCheckedChange={(checked) => onAutoStartChange(server, checked === true)}
                      />
                    </DisabledReason>
                    <Label htmlFor={checkboxId} className="cursor-pointer text-[11px] text-muted-foreground">
                      {t('serversOverview.autoStartLabel')}
                    </Label>
                  </div>
                )}
                {!isActive && (
                  <DisabledReason reason={!canSwitch ? t('serversOverview.noPermissionSwitch') : null}>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 px-2 text-xs"
                      disabled={!canSwitch || switching !== null}
                      onClick={() => handleSwitch(server)}
                      aria-label={t('serversOverview.showAria', { name })}
                    >
                      {switching === id
                        ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                        : <ArrowRightLeft className="h-3 w-3" aria-hidden="true" />}
                      {t('serversOverview.show')}
                    </Button>
                  </DisabledReason>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
