import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Cloud,
  Download,
  HardDrive,
  Info,
  Loader2,
  Minus,
  Play,
  RefreshCw,
  RotateCw,
  ShieldCheck,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { DisabledReason } from '@/components/DisabledReason'
import { useAuth } from '@/contexts/AuthContext'
import { useBridgeDelivery } from '@/hooks/useBridgeDelivery'
import { panelBridgeApi, serverApi, serverFilesApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { cn } from '@/lib/utils'
import type { DeliveryMethod, DeliveryStatus } from '@/lib/bridgeDeliveryTypes'
import {
  DELIVERY_ACTION_KEYS,
  type DeliveryAction,
  getAvailabilityParams,
  getBlockReasonKey,
  getChecksumBlockerKey,
  getDeliveryStateView,
  getGuidedWorkshopManual,
  getStateVersion,
  resolveStateActions,
} from '@/lib/bridgeDeliveryView'
import { BridgeDeliverySwitchDialog } from './BridgeDeliverySwitchDialog'
import { BridgeChecksumDialog } from './BridgeChecksumDialog'
import { BridgeGuidedSteps } from './BridgeGuidedSteps'

const RESTART_WARNING_MINUTES = 5

const WARNING_CALLOUT = 'border-warning/40 bg-warning/10'
const NEUTRAL_CALLOUT = 'border-border/60 bg-muted/40'
// Long translated labels (fr/de/uk run 30-60% longer than English) wrap
// instead of overflowing the card at phone width; min-h keeps the Button
// size=sm touch target.
const WRAPPING_BUTTON = 'h-auto min-h-11 gap-2 whitespace-normal text-start sm:min-h-8'

interface BridgeDeliveryPanelProps {
  // Refetch trigger only (see useBridgeDelivery); the panel always shows
  // the server's own answer for the active server.
  activeServerId: string | number | null
  // `<ServerName>.ini` of the active profile, for the guided steps' wording.
  iniFileName: string | null
  // modStatus.playerCount from GET /panel-bridge/status while the bridge is
  // alive, else null. Decides whether a restart gives players a warning.
  playerCount: number | null
}

type PendingAction = DeliveryAction | 'checksumOff'

// Settings › PanelBridge: "How PanelBridge is installed" for the active
// server (§4). Every state, availability and checksum decision comes from
// GET /panel-bridge/delivery; this component only maps them to copy and
// buttons (lib/bridgeDeliveryView.ts).
export function BridgeDeliveryPanel({ activeServerId, iniFileName, playerCount }: BridgeDeliveryPanelProps) {
  const { t } = useTranslation('bridgeDelivery')
  const { toast } = useToast()
  const { can } = useAuth()
  const canSetupBridge = can('bridge.setup')
  const canManageServerFiles = can('serverfiles.manage')
  const canControlServer = can('server.control')
  const canView = canSetupBridge || can('bridge.diagnostics') || canManageServerFiles || can('mods.manage')
  const { status, loading, error, refetch } = useBridgeDelivery({ activeServerId, enabled: canView })
  const [switchTarget, setSwitchTarget] = useState<DeliveryMethod | null>(null)
  const [checksumOpen, setChecksumOpen] = useState(false)
  const [pending, setPending] = useState<PendingAction | null>(null)

  if (!canView) return null

  const noBridgeSetupReason = !canSetupBridge ? t('permissions.noBridgeSetup', { ns: 'settings' }) : null
  const noServerControlReason = !canControlServer ? t('needsServerControl') : null
  const noServerFilesReason = !canManageServerFiles ? t('checksumOffer.needsServerFiles') : null
  const playersOnline = status?.live?.alive === true && (playerCount ?? 0) > 0

  const runAction = async (action: PendingAction, fn: () => Promise<unknown>, successTitle: string, failureTitle: string) => {
    setPending(action)
    try {
      await fn()
      toast({ title: successTitle, variant: 'success' })
    } catch (err) {
      toast({ title: failureTitle, description: getUserErrorMessage(err, failureTitle), variant: 'destructive' })
    } finally {
      setPending(null)
      void refetch()
    }
  }

  const onAction = (action: DeliveryAction) => {
    if (!status) return
    switch (action) {
      case 'switchToWorkshop':
        if (canSetupBridge) setSwitchTarget('workshop')
        return
      case 'switchToLocal':
      case 'switchToLocalAndStart':
        // "and start" is the dialog's own primary button for a stopped
        // server (apply, then POST /server/start), so both open the same
        // preview -- the switch back still edits files and is shown first.
        if (canSetupBridge) setSwitchTarget('local')
        return
      case 'installNow':
      case 'updateNow':
        if (!canSetupBridge) return
        void runAction(action, () => panelBridgeApi.installModAuto(status.serverId), t('toast.installed'), t('toast.installFailed'))
        return
      case 'restartNow':
        if (!canControlServer) return
        void runAction(
          action,
          () => serverApi.restart(playersOnline ? RESTART_WARNING_MINUTES : 0),
          t('toast.restartStarted'),
          t('toast.actionFailed'),
        )
        return
      case 'startServer':
        if (!canControlServer) return
        void runAction(action, () => serverApi.start(), t('toast.startStarted'), t('toast.actionFailed'))
        return
    }
  }

  const turnChecksumOff = () => {
    if (!canManageServerFiles) return
    void runAction(
      'checksumOff',
      () => serverFilesApi.saveIni({ DoLuaChecksum: 'false' }),
      t('toast.checksumOff'),
      t('toast.checksumFailed'),
    )
  }

  const actionReason = (action: DeliveryAction): string | null => {
    if (action === 'restartNow' || action === 'startServer') return noServerControlReason
    return noBridgeSetupReason
  }

  const actionIcon = (action: DeliveryAction) => {
    if (pending === action) return <Loader2 className="h-3.5 w-3.5 animate-spin" />
    switch (action) {
      case 'restartNow':
        return <RotateCw className="h-3.5 w-3.5" />
      case 'startServer':
      case 'switchToLocalAndStart':
        return <Play className="h-3.5 w-3.5" />
      case 'installNow':
      case 'updateNow':
        return <Download className="h-3.5 w-3.5" />
      default:
        return <RefreshCw className="h-3.5 w-3.5" />
    }
  }

  const renderActions = (actions: DeliveryAction[]) =>
    actions.length > 0 && (
      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => {
            const reason = actionReason(action)
            return (
              <DisabledReason key={action} reason={reason} className="max-w-full">
                <Button
                  type="button"
                  size="sm"
                  variant={action === 'switchToLocalAndStart' ? 'default' : 'outline'}
                  className={WRAPPING_BUTTON}
                  disabled={Boolean(reason) || pending !== null}
                  onClick={() => onAction(action)}
                >
                  {actionIcon(action)}
                  {t(DELIVERY_ACTION_KEYS[action])}
                </Button>
              </DisabledReason>
            )
          })}
        </div>
        {actions.includes('restartNow') && playersOnline && (
          <p className="text-xs text-muted-foreground">{t('action.restartWarningNote')}</p>
        )}
      </div>
    )

  const renderStateCallout = (s: DeliveryStatus) => {
    const view = getDeliveryStateView(s.state)
    const params = { version: getStateVersion(s) }
    const warning = view.tone === 'warning'
    const icon = warning ? (
      <AlertTriangle className="h-4 w-4 text-warning" />
    ) : s.state === 'workshop-waiting' ? (
      <Loader2 className="h-4 w-4 animate-spin text-primary" />
    ) : view.tone === 'ok' ? (
      <CheckCircle2 className="h-4 w-4 text-success" />
    ) : (
      <Info className="h-4 w-4 text-primary" />
    )
    return (
      <Alert className={warning ? WARNING_CALLOUT : NEUTRAL_CALLOUT} aria-live="polite" data-state={s.state}>
        {icon}
        <AlertTitle className={warning ? 'text-warning' : undefined}>{t(view.titleKey, params)}</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{t(view.bodyKey, params)}</p>
          {s.state === 'workshop-start-failed' && s.lastStartFailure && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t('state.evidence')}</p>
              <code dir="ltr" className="block whitespace-pre-wrap break-all rounded bg-background/60 p-2 font-mono text-xs">
                {s.lastStartFailure.line}
              </code>
            </div>
          )}
          {view.causesKey && <p className="text-xs text-muted-foreground">{t(view.causesKey)}</p>}
          {renderActions(resolveStateActions(s))}
        </AlertDescription>
      </Alert>
    )
  }

  const renderOptionCard = (s: DeliveryStatus, method: DeliveryMethod) => {
    const isCurrent = s.method === method
    const prefix = method === 'local' ? 'local' : 'workshop'
    const pros = [`${prefix}.pro1`, `${prefix}.pro2`]
    const cons = method === 'local' ? ['local.con1', 'local.con2'] : ['workshop.con1', 'workshop.con2', 'workshop.con3']
    const availability = method === 'workshop' ? s.switchAvailability.toWorkshop : s.switchAvailability.toLocal
    const blockedReason =
      !isCurrent && !availability.available && availability.reason && availability.reason !== 'sameMethod'
        ? t(getBlockReasonKey(availability.reason), getAvailabilityParams(s))
        : null
    const Icon = method === 'local' ? HardDrive : Cloud
    const switchReason = noBridgeSetupReason ?? blockedReason
    return (
      <div
        className={cn(
          'flex flex-col gap-3 rounded-lg border p-3',
          isCurrent ? 'border-primary/40 bg-primary/5' : 'border-border/60 bg-muted/25',
        )}
        data-testid={`bridge-delivery-option-${method}`}
        aria-current={isCurrent ? 'true' : undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <p className="text-sm font-medium">{t(`${prefix}.title`)}</p>
          {isCurrent && <Badge variant="default">{t('current')}</Badge>}
          {method === 'workshop' && (
            <Badge variant="secondary">{s.release.preview ? t('preview') : t('recommended')}</Badge>
          )}
          {method === 'workshop' && s.release.source === 'env' && <Badge variant="outline">{t('testOverride')}</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">{t(`${prefix}.lead`)}</p>
        <ul className="space-y-1.5 text-xs">
          {pros.map((key) => (
            <li key={key} className="flex items-start gap-2">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
              <span>
                <span className="sr-only">{t('pro')}: </span>
                {t(key)}
              </span>
            </li>
          ))}
          {cons.map((key) => (
            <li key={key} className="flex items-start gap-2">
              <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>
                <span className="sr-only">{t('con')}: </span>
                {t(key)}
              </span>
            </li>
          ))}
        </ul>
        {method === 'workshop' && <p className="text-xs text-muted-foreground">{t('workshop.players')}</p>}
        {!isCurrent && (
          <div className="mt-auto space-y-1.5">
            {blockedReason && <p className="text-xs text-warning">{blockedReason}</p>}
            {(availability.available || blockedReason) && (
              <DisabledReason reason={switchReason} className="max-w-full">
                <Button
                  type="button"
                  size="sm"
                  variant={method === 'workshop' ? 'default' : 'outline'}
                  className={WRAPPING_BUTTON}
                  disabled={Boolean(switchReason) || pending !== null}
                  onClick={() => onAction(method === 'workshop' ? 'switchToWorkshop' : 'switchToLocal')}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t(method === 'workshop' ? 'action.switchToWorkshop' : 'action.switchToLocal')}
                </Button>
              </DisabledReason>
            )}
          </div>
        )}
      </div>
    )
  }

  const renderChecksum = (s: DeliveryStatus) => {
    // #168: with the panel-installed bridge the integrity check has to stay
    // off, and the operator should know what that costs (§4.3). `null`
    // (guided, file unreadable) is shown too -- local delivery requires off.
    if (s.method === 'local' && s.checksum.current !== true) {
      const workshop = s.switchAvailability.toWorkshop
      const blocked = !workshop.available && workshop.reason && workshop.reason !== 'sameMethod'
        ? t(getBlockReasonKey(workshop.reason), getAvailabilityParams(s))
        : null
      const reason = noBridgeSetupReason ?? blocked
      return (
        <Alert className={WARNING_CALLOUT} data-testid="bridge-delivery-checksum-off">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle className="text-warning">{t('checksumOff.title')}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{t('checksumOff.body')}</p>
            {(workshop.available || blocked) && (
              <DisabledReason reason={reason} className="max-w-full">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={WRAPPING_BUTTON}
                  disabled={Boolean(reason) || pending !== null}
                  onClick={() => onAction('switchToWorkshop')}
                >
                  <Cloud className="h-3.5 w-3.5" />
                  {t('action.switchToWorkshop')}
                </Button>
              </DisabledReason>
            )}
          </AlertDescription>
        </Alert>
      )
    }

    if (s.checksum.playersBlocked) {
      return (
        <Alert className={WARNING_CALLOUT} data-testid="bridge-delivery-players-blocked">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle className="text-warning">{t('playersBlocked.title')}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{t('playersBlocked.body')}</p>
            <DisabledReason reason={noServerFilesReason} className="max-w-full">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={WRAPPING_BUTTON}
                disabled={!canManageServerFiles || pending !== null}
                onClick={turnChecksumOff}
              >
                {pending === 'checksumOff' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('playersBlocked.turnOff')}
              </Button>
            </DisabledReason>
          </AlertDescription>
        </Alert>
      )
    }

    // "Turn it off again" stays reachable for as long as the check is on
    // with Workshop delivery, whatever the state -- it is the escape hatch
    // if players turn out to be refused (the Linux caveat, a leftover file).
    if (s.method === 'workshop' && s.checksum.current === true) {
      return (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 p-3" data-testid="bridge-delivery-checksum-on">
          <p className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
            {t('checksumOffer.isOn')}
          </p>
          <DisabledReason reason={noServerFilesReason} className="max-w-full">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={WRAPPING_BUTTON}
              disabled={!canManageServerFiles || pending !== null}
              onClick={turnChecksumOff}
            >
              {pending === 'checksumOff' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('checksumOffer.turnOff')}
            </Button>
          </DisabledReason>
        </div>
      )
    }

    if (s.state === 'workshop-confirmed') {
      const blockers = s.checksum.turnOnBlockers.filter((b) => b !== 'alreadyOn')
      const blockedReason = !s.checksum.canTurnOn && blockers.length > 0 ? t(getChecksumBlockerKey(blockers[0])) : null
      // Guided access only shows instructions (no file write), so it needs
      // no serverfiles.manage to open.
      const reason = (s.access === 'automatic' ? noServerFilesReason : null) ?? blockedReason
      return (
        <div className="space-y-3 rounded-lg border border-border/60 bg-muted/25 p-3" data-testid="bridge-delivery-checksum-offer">
          <div className="space-y-1">
            <p className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              {t('checksumOffer.title')}
            </p>
            <p className="text-xs text-muted-foreground">{t('checksumOffer.body')}</p>
            <p className="text-xs text-muted-foreground">{t('security.sentence')}</p>
          </div>
          {blockedReason && <p className="text-xs text-warning">{blockedReason}</p>}
          <DisabledReason reason={reason} className="max-w-full">
            <Button
              type="button"
              size="sm"
              className={WRAPPING_BUTTON}
              disabled={Boolean(reason) || !s.checksum.canTurnOn || pending !== null}
              onClick={() => setChecksumOpen(true)}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {t('checksumOffer.turnOn')}
            </Button>
          </DisabledReason>
        </div>
      )
    }
    return null
  }

  const renderBanners = (s: DeliveryStatus) => (
    <>
      {s.steamReportsUnavailable && (
        <Alert className={WARNING_CALLOUT} data-testid="bridge-delivery-steam-unavailable">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertDescription>{t('banner.steamUnavailable')}</AlertDescription>
        </Alert>
      )}
      {s.method === 'workshop' && s.access === 'automatic' && s.disk && s.disk.looseFiles.length > 0 && (
        <Alert className={WARNING_CALLOUT} data-testid="bridge-delivery-leftovers">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertDescription>
            {t('banner.leftovers', { files: s.disk.looseFiles.map((f) => f.path).join(', ') })}
          </AlertDescription>
        </Alert>
      )}
    </>
  )

  const showGuidedReminder = (s: DeliveryStatus) =>
    s.method === 'workshop' &&
    s.access === 'guided' &&
    s.state !== 'workshop-confirmed' &&
    s.state !== 'workshop-id-unknown' &&
    Boolean(s.effectiveWorkshopId)

  return (
    <section className="space-y-4 rounded-xl border border-border/70 bg-background/40 p-4" aria-labelledby="bridge-delivery-heading" data-testid="bridge-delivery-panel">
      <div>
        <h3 id="bridge-delivery-heading" className="flex items-center gap-2 text-sm font-medium">
          <Cloud className="h-4 w-4 text-primary" aria-hidden="true" />
          {t('sectionTitle')}
        </h3>
        {status && <p className="text-xs text-muted-foreground">{t('appliesTo', { server: status.serverName })}</p>}
      </div>

      {!status && loading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('loading')}
        </p>
      )}

      {!status && !loading && error != null && (
        <Alert className={WARNING_CALLOUT}>
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle className="text-warning">{t('loadFailed')}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{getUserErrorMessage(error, t('loadFailed'))}</p>
            <Button type="button" size="sm" variant="outline" className="gap-2" onClick={() => void refetch()}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {status && (
        <>
          {renderStateCallout(status)}
          {renderBanners(status)}
          {renderChecksum(status)}
          {showGuidedReminder(status) && (
            <BridgeGuidedSteps to="workshop" manual={getGuidedWorkshopManual(status)} iniFileName={iniFileName} />
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {renderOptionCard(status, 'local')}
            {renderOptionCard(status, 'workshop')}
          </div>
          {status.method === 'workshop' && (
            <p className={cn('flex items-start gap-2 rounded-lg border p-3 text-xs text-muted-foreground', NEUTRAL_CALLOUT)}>
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
              <span>{t(status.modAutoRestart ? 'banner.autoRestartOn' : 'banner.autoRestartOff')}</span>
            </p>
          )}

          <BridgeDeliverySwitchDialog
            open={switchTarget !== null}
            onOpenChange={(open) => { if (!open) setSwitchTarget(null) }}
            status={status}
            to={switchTarget ?? (status.method === 'local' ? 'workshop' : 'local')}
            playerCount={playerCount}
            iniFileName={iniFileName}
            onChanged={refetch}
          />
          <BridgeChecksumDialog
            open={checksumOpen}
            onOpenChange={setChecksumOpen}
            status={status}
            playerCount={playerCount}
            onChanged={refetch}
          />
        </>
      )}
    </section>
  )
}
