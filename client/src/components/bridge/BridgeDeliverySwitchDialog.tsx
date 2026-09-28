import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { DisabledReason } from '@/components/DisabledReason'
import { useAuth } from '@/contexts/AuthContext'
import { useRequestGuard } from '@/hooks/useRequestGuard'
import { ApiError, panelBridgeApi, serverApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import type { DeliveryMethod, DeliveryPlanResponse, DeliveryStatus } from '@/lib/bridgeDeliveryTypes'
import {
  describeDeliveryStep,
  getAvailabilityParams,
  getBlockReasonKey,
  getWarningKey,
} from '@/lib/bridgeDeliveryView'
import { BridgeGuidedSteps } from './BridgeGuidedSteps'

// 'guided' is the one-click "I've made these changes" of a server whose
// files the panel can't reach: it records the choice and nothing else.
type ApplyMode = 'restart' | 'start' | 'later' | 'guided'

// Players online get this much warning before a "Switch and restart now";
// an empty server restarts immediately. Same /server/restart call the rest
// of the panel uses.
const RESTART_WARNING_MINUTES = 5

// Full-width, wrapping footer buttons on phones ("Switch and restart now
// (players get a 5-minute warning)" is two lines at 360 px, longer still
// translated); content-width in a row from sm up.
const DIALOG_ACTION = 'h-auto min-h-11 w-full gap-2 whitespace-normal sm:min-h-9 sm:w-auto'

interface BridgeDeliverySwitchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: DeliveryStatus
  to: DeliveryMethod
  // From GET /panel-bridge/status modStatus -- DeliveryStatus.live carries
  // no player count. null when the bridge isn't reporting.
  playerCount: number | null
  iniFileName: string | null
  onChanged: () => unknown
}

// Preview-then-apply for a delivery switch (§4.6, §4.8). Not an AlertDialog:
// nothing is deleted -- loose files are archived, and every ini is backed up
// before it is edited. The preview is a server dry run, so every step shown
// is exactly what apply will do, in order.
export function BridgeDeliverySwitchDialog({
  open,
  onOpenChange,
  status,
  to,
  playerCount,
  iniFileName,
  onChanged,
}: BridgeDeliverySwitchDialogProps) {
  const { t } = useTranslation('bridgeDelivery')
  const { toast } = useToast()
  const { can } = useAuth()
  const canSetupBridge = can('bridge.setup')
  const canControlServer = can('server.control')
  const guard = useRequestGuard()
  const [plan, setPlan] = useState<DeliveryPlanResponse | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [staleNotice, setStaleNotice] = useState(false)
  const [pending, setPending] = useState<ApplyMode | null>(null)

  const serverId = status.serverId
  const loadPlan = useCallback(async () => {
    const requestId = guard.next()
    setPlanLoading(true)
    setPlanError(null)
    try {
      const next = await panelBridgeApi.planDelivery({ serverId, method: to })
      if (guard.isStale(requestId)) return
      setPlan(next)
    } catch (err) {
      if (guard.isStale(requestId)) return
      setPlan(null)
      setPlanError(getUserErrorMessage(err, t('dialog.planFailed')))
    } finally {
      if (!guard.isStale(requestId)) setPlanLoading(false)
    }
  }, [guard, serverId, to, t])

  useEffect(() => {
    if (!open) {
      // Invalidate any preview still in flight so it can't land in the
      // next opening of this dialog.
      guard.next()
      setPlan(null)
      setPlanError(null)
      setStaleNotice(false)
      return
    }
    void loadPlan()
  }, [open, loadPlan, guard])

  const playersOnline = status.live?.alive === true && (playerCount ?? 0) > 0
  const noBridgeSetupReason = !canSetupBridge ? t('permissions.noBridgeSetup', { ns: 'settings' }) : null
  const blockedReason = plan?.blocked
    ? t(getBlockReasonKey(plan.blocked.reason), getAvailabilityParams(status, plan.sharedWith))
    : null
  const baseReason = noBridgeSetupReason ?? blockedReason
  const lifecycleReason = baseReason ?? (!canControlServer ? t('needsServerControl') : null)
  const busy = pending !== null
  const canApply = Boolean(plan) && !plan?.blocked && canSetupBridge && !planLoading

  const apply = async (mode: ApplyMode) => {
    if (!plan || plan.blocked || !canSetupBridge) return
    const withLifecycle = mode === 'restart' || mode === 'start'
    if (withLifecycle && !canControlServer) return
    setPending(mode)
    try {
      await panelBridgeApi.applyDelivery({ serverId: plan.serverId, method: plan.to, expectedFrom: plan.from })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PANELBRIDGE_DELIVERY_STALE') {
        // Someone (another tab, another admin, a crash-recovery reconcile)
        // changed the method since this preview was built. Re-plan against
        // the current method rather than applying steps nobody reviewed.
        setStaleNotice(true)
        void onChanged()
        await loadPlan()
      } else {
        // §5.5: a failed apply carries `restored`. false means the undo
        // itself failed part-way (a broken I6), and the coded message's own
        // "the panel put back what it had already changed" would then be
        // untrue -- so it is replaced, not appended to.
        const notRestored =
          err instanceof ApiError && (err.data as { restored?: unknown } | undefined)?.restored === false
        toast({
          title: t('toast.switchFailed'),
          description: notRestored ? t('toast.notRestored') : getUserErrorMessage(err, t('toast.switchFailed')),
          variant: 'destructive',
        })
        void onChanged()
      }
      setPending(null)
      return
    }

    toast({
      title: t(plan.to === 'workshop' ? 'toast.switchedToWorkshop' : 'toast.switchedToLocal', { server: status.serverName }),
      variant: 'success',
    })
    // Two explicit calls, never a chain hidden on the server: the switch
    // above is already committed, so a failed start/restart is reported on
    // its own and doesn't pretend the switch didn't happen.
    if (withLifecycle) {
      try {
        if (mode === 'restart') await serverApi.restart(playersOnline ? RESTART_WARNING_MINUTES : 0)
        else await serverApi.start()
      } catch (err) {
        toast({
          title: t('toast.lifecycleFailed'),
          description: getUserErrorMessage(err, t('toast.lifecycleFailed')),
          variant: 'destructive',
        })
      }
    }
    setPending(null)
    onOpenChange(false)
    void onChanged()
  }

  const title = t(to === 'workshop' ? 'dialog.titleToWorkshop' : 'dialog.titleToLocal', { server: status.serverName })
  const guided = plan?.access === 'guided'
  const codeComponent = <code dir="ltr" className="rounded bg-muted px-1 font-mono text-xs break-all" />

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-h-[80vh] sm:max-w-2xl">
        <DialogHeader className="pe-6">
          <DialogTitle className="leading-snug">{title}</DialogTitle>
          <DialogDescription>{guided && !plan?.blocked ? t('guided.title') : t('dialog.intro')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {staleNotice && (
            <Alert className="border-warning/40 bg-warning/10" aria-live="polite">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertDescription>{t('dialog.staleNotice')}</AlertDescription>
            </Alert>
          )}

          {planLoading && !plan && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('dialog.planning')}
            </p>
          )}

          {planError && (
            <Alert className="border-warning/40 bg-warning/10">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertTitle className="text-warning">{t('dialog.planFailed')}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{planError}</p>
                <Button type="button" size="sm" variant="outline" className="gap-2" onClick={() => void loadPlan()} disabled={planLoading}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t('retry')}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {plan?.blocked && (
            <Alert className="border-warning/40 bg-warning/10">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertTitle className="text-warning">{t('dialog.blockedTitle')}</AlertTitle>
              <AlertDescription>{blockedReason}</AlertDescription>
            </Alert>
          )}

          {plan && !guided && plan.steps.length > 0 && (
            <div className="space-y-2">
              <ol className="list-decimal space-y-2 ps-6 text-sm" data-testid="bridge-delivery-steps">
                {plan.steps.map((step, index) => {
                  const view = describeDeliveryStep(step)
                  return (
                    <li key={`${step.kind}-${index}`} className="break-words" data-step-kind={step.kind}>
                      <Trans t={t} i18nKey={view.key} values={view.params} components={{ code: codeComponent }} />
                      {view.serverName && <span className="text-muted-foreground"> ({view.serverName})</span>}
                    </li>
                  )
                })}
              </ol>
              <p className="text-xs text-muted-foreground">{t('dialog.backupNote')}</p>
            </div>
          )}

          {/* Guided steps are done by hand, outside the panel, so unlike the
              automatic list they aren't merely informational: shown on a
              blocked plan (e.g. -nosteam, or no known item id), following
              them would get around the block. The block reason above is
              all a blocked plan shows. */}
          {plan && guided && plan.manual && !plan.blocked && (
            <BridgeGuidedSteps to={plan.to} manual={plan.manual} iniFileName={iniFileName} />
          )}

          {plan && plan.warnings.length > 0 && (
            <Alert className="border-warning/40 bg-warning/10">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertTitle className="text-warning">{t('dialog.warningsTitle')}</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 ps-5">
                  {plan.warnings.map((warning) => (
                    <li key={warning}>{t(getWarningKey(warning), getAvailabilityParams(status, plan.sharedWith))}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('dialog.cancel')}
          </Button>
          {guided ? (
            <DisabledReason reason={baseReason} className="w-full sm:w-auto">
              <Button type="button" onClick={() => void apply('guided')} disabled={!canApply || busy} className={DIALOG_ACTION}>
                {pending === 'guided' && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('guided.done')}
              </Button>
            </DisabledReason>
          ) : (
            <>
              <DisabledReason reason={baseReason} className="w-full sm:w-auto">
                <Button type="button" variant="outline" onClick={() => void apply('later')} disabled={!canApply || busy} className={DIALOG_ACTION}>
                  {pending === 'later' && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t('dialog.applyOnly')}
                </Button>
              </DisabledReason>
              {status.serverRunning === true && (
                <DisabledReason reason={lifecycleReason} className="w-full sm:w-auto">
                  <Button
                    type="button"
                    onClick={() => void apply('restart')}
                    disabled={!canApply || !canControlServer || busy}
                    className={DIALOG_ACTION}
                  >
                    {pending === 'restart' && <Loader2 className="h-4 w-4 animate-spin" />}
                    {playersOnline ? t('dialog.applyRestartPlayers') : t('dialog.applyRestartEmpty')}
                  </Button>
                </DisabledReason>
              )}
              {status.serverRunning === false && (
                <DisabledReason reason={lifecycleReason} className="w-full sm:w-auto">
                  <Button
                    type="button"
                    onClick={() => void apply('start')}
                    disabled={!canApply || !canControlServer || busy}
                    className={DIALOG_ACTION}
                  >
                    {pending === 'start' && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t('dialog.applyStart')}
                  </Button>
                </DisabledReason>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
