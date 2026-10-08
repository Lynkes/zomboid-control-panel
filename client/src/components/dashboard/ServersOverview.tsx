import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRightLeft, Loader2, Play, RotateCcw, Square, Users } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { DisabledReason } from '@/components/DisabledReason'
import { ServerUptime } from '@/components/ServerUptime'
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/contexts/SocketContext'
import { useAuth } from '@/contexts/AuthContext'
import { serversApi, type ServerInstance } from '@/lib/api'
import {
  autoStartEnabled, autoStartServerIds, restartOnCrashServerIds, type AutoStartSettings,
} from '@/lib/autoStartServers'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { cn } from '@/lib/utils'

// Every server at a glance on the Dashboard, so running several doesn't mean
// switching between them to see which are up: state and uptime from the
// per-server process scan (GET /servers/status), players from a one-off RCON
// count per server (GET /servers/rcon-status?players=1) -- the panel's own
// RCON connection reaches the active server only -- each one's place in the
// auto-start list and the restart-if-it-goes-down list, and Start, Stop and
// Restart for the servers other than the active one (POST
// /servers/:id/start|stop|restart; the active one's are the Dashboard's own,
// below). Shown only with two servers or more; with one, the rest of the
// Dashboard already is that server. The server watch pushes servers:status
// when one of them starts or stops, and the list refreshes on it.

const POLL_MS = 15_000
// The Dashboard's own Restart warns players this long first.
const RESTART_WARNING_MINUTES = 5

type StatusRow = Awaited<ReturnType<typeof serversApi.getStatus>>['servers'][number]
type RconRow = Awaited<ReturnType<typeof serversApi.getRconStatuses>>['servers'][number]
type RowState = 'running' | 'stopped' | 'unknown'
type ServerAction = 'start' | 'stop' | 'restart'

interface ServersOverviewProps {
  activeServerId: string | null
  autoStartSettings: AutoStartSettings
  canChangeAutoStart: boolean
  onAutoStartChange: (server: ServerInstance, chosen: boolean) => void
  onRestartOnCrashChange: (server: ServerInstance, chosen: boolean) => void
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
  activeServerId, autoStartSettings, canChangeAutoStart, onAutoStartChange, onRestartOnCrashChange, onShownChange,
}: ServersOverviewProps) {
  const { t } = useTranslation('dashboard')
  const { toast } = useToast()
  const socket = useSocket()
  const { can } = useAuth()
  const canSwitch = can('servers.manage')
  const canControl = can('server.control')
  const [servers, setServers] = useState<ServerInstance[]>([])
  const [statuses, setStatuses] = useState<Record<string, StatusRow>>({})
  const [rcon, setRcon] = useState<Record<string, RconRow>>({})
  const [switching, setSwitching] = useState<string | null>(null)
  // One action at a time, like the panel's lifecycle lock.
  const [pending, setPending] = useState<{ id: string; action: ServerAction } | null>(null)
  const [toConfirm, setToConfirm] = useState<{ server: ServerInstance; action: 'stop' | 'restart' } | null>(null)
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
    socket.on('servers:status', onChange)
    return () => {
      socket.off('activeServerChanged', onChange)
      socket.off('servers:status', onChange)
    }
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

  const runAction = async (server: ServerInstance, action: ServerAction) => {
    if (!canControl || pending) return
    const name = server.name || server.serverName
    setPending({ id: String(server.id), action })
    try {
      if (action === 'start') {
        const result = await serversApi.start(server.id)
        toast({ title: t(result?.alreadyRunning ? 'serversOverview.alreadyRunningTitle' : 'serversOverview.startedTitle', { name }) })
      } else if (action === 'stop') {
        const result = await serversApi.stop(server.id)
        toast(result?.alreadyStopped
          ? { title: t('serversOverview.alreadyStoppedTitle', { name }) }
          : { title: t('serversOverview.stopRequestedTitle', { name }), description: t('serversOverview.stopRequestedDesc') })
      } else {
        await serversApi.restart(server.id, RESTART_WARNING_MINUTES)
        // The outcome comes later, as the Dashboard's own Restart's does.
        toast({ title: t('serversOverview.restartRequestedTitle', { name }), description: t('serversOverview.restartRequestedDesc', { minutes: RESTART_WARNING_MINUTES }) })
      }
    } catch (error) {
      toast({
        title: t(`serversOverview.${action}Failed`, { name }),
        description: getUserErrorMessage(error, t('toasts.errorTitle')),
        variant: 'destructive',
      })
    } finally {
      setPending(null)
      void refresh()
    }
  }

  if (!shown) return null

  const autoStartOn = autoStartEnabled(autoStartSettings)
  const chosen = autoStartServerIds(autoStartSettings, activeServerId)
  const restartChosen = restartOnCrashServerIds(autoStartSettings)
  const isActiveServer = (server: ServerInstance) =>
    activeServerId !== null ? String(server.id) === activeServerId : server.isActive
  // The active server first -- with many servers the list scrolls, and the
  // one the rest of the Dashboard shows stays in view -- then My Servers order.
  const ordered = [...servers.filter(isActiveServer), ...servers.filter((server) => !isActiveServer(server))]
  const confirmName = toConfirm ? toConfirm.server.name || toConfirm.server.serverName : ''

  const actionButton = (server: ServerInstance, action: ServerAction) => {
    const id = String(server.id)
    const name = server.name || server.serverName
    const Icon = action === 'start' ? Play : action === 'stop' ? Square : RotateCcw
    return (
      <DisabledReason key={action} reason={!canControl ? t('actions.noPermissionControl') : null}>
        <Button
          size="sm"
          variant="outline"
          className={cn(
            'h-7 gap-1.5 px-2 text-xs',
            action === 'start' && 'border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300',
            action === 'stop' && 'border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300',
            action === 'restart' && 'border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300',
          )}
          disabled={!canControl || pending !== null}
          onClick={() => (action === 'start' ? runAction(server, action) : setToConfirm({ server, action }))}
          aria-label={t(`serversOverview.${action}Aria`, { name })}
        >
          {pending?.id === id && pending.action === action
            ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            : <Icon className="h-3 w-3" aria-hidden="true" />}
          {t(`actions.${action}`)}
        </Button>
      </DisabledReason>
    )
  }

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
          const restartCheckboxId = `servers-overview-restart-${id}`
          // The active server's Start/Stop/Restart are the Dashboard's own; a
          // remote one is run by its host; an unknown state offers neither.
          const actions: ServerAction[] = isActive || server.isRemote || state === 'unknown'
            ? []
            : state === 'running' ? ['stop', 'restart'] : ['start']
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
              <div className="flex flex-wrap items-center gap-3">
                {!server.isRemote && (
                  <>
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
                    <div className="flex items-center gap-1.5" title={t('serversOverview.restartOnCrashHint')}>
                      <DisabledReason reason={!canChangeAutoStart ? t('actions.noPermissionAutoStart') : null}>
                        <Checkbox
                          id={restartCheckboxId}
                          checked={restartChosen.includes(id)}
                          disabled={!canChangeAutoStart}
                          onCheckedChange={(checked) => onRestartOnCrashChange(server, checked === true)}
                        />
                      </DisabledReason>
                      <Label htmlFor={restartCheckboxId} className="cursor-pointer text-[11px] text-muted-foreground">
                        {t('serversOverview.restartOnCrashLabel')}
                      </Label>
                    </div>
                  </>
                )}
                {actions.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    {actions.map((action) => actionButton(server, action))}
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

      <AlertDialog open={toConfirm !== null} onOpenChange={(open) => !open && setToConfirm(null)}>
        <AlertDialogContent className="glass border-border/50">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-3 text-xl">
              <AlertTriangle className="h-5 w-5 text-warning" aria-hidden="true" />
              {toConfirm?.action === 'restart'
                ? t('serversOverview.confirmRestartTitle', { name: confirmName })
                : t('serversOverview.confirmStopTitle', { name: confirmName })}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-base">
              {toConfirm?.action === 'restart' ? t('confirm.restartServer.description') : t('confirm.stopServer.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-2">
            <AlertDialogCancel className="mt-0">{t('confirm.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className={cn(buttonVariants({ variant: 'warning' }))}
              onClick={() => {
                const target = toConfirm
                setToConfirm(null)
                if (target) void runAction(target.server, target.action)
              }}
            >
              {toConfirm?.action === 'restart' ? t('actions.restart') : t('actions.stop')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
