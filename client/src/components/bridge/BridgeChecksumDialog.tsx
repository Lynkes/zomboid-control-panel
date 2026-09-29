import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AlertTriangle, ExternalLink, Loader2, ShieldCheck } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useToast } from '@/components/ui/use-toast'
import { DisabledReason } from '@/components/DisabledReason'
import { useAuth } from '@/contexts/AuthContext'
import { useDeliveryDialogServer } from '@/hooks/useBridgeDelivery'
import { panelBridgeApi, serverApi, serverFilesApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import type { DeliveryStatus } from '@/lib/bridgeDeliveryTypes'
import { getRestartWarning, isDeliveryStatus, SERVER_CONFIG_CHECKSUM_LINK } from '@/lib/bridgeDeliveryView'

// Same footer button shape as BridgeDeliverySwitchDialog: full-width and
// wrapping on phones, content-width from sm up.
const DIALOG_ACTION = 'h-auto min-h-11 w-full gap-2 whitespace-normal sm:min-h-9 sm:w-auto'

interface AckProps {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}

function Ack({ id, checked, onChange, label }: AckProps) {
  const labelId = `${id}-label`
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/25 p-3 text-sm">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        aria-labelledby={labelId}
        className="mt-0.5"
      />
      <label id={labelId} htmlFor={id} className="cursor-pointer leading-relaxed">
        {label}
      </label>
    </div>
  )
}

interface BridgeChecksumDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: DeliveryStatus
  playerCount: number | null
  onChanged: () => unknown
}

// Turning DoLuaChecksum back on once PanelBridge is confirmed to load from
// the Steam Workshop (§4.7). The panel never turns it on by itself (I5):
// this dialog is the only path, the acknowledgements are required, and the
// write goes through the ordinary partial-key PUT /server-files/ini (backed
// up, serverfiles.manage) only after a fresh status still says canTurnOn.
export function BridgeChecksumDialog({ open, onOpenChange, status, playerCount, onChanged }: BridgeChecksumDialogProps) {
  const { t } = useTranslation('bridgeDelivery')
  const { toast } = useToast()
  const { can } = useAuth()
  const canManageServerFiles = can('serverfiles.manage')
  const canControlServer = can('server.control')
  const baseId = useId()
  const [ackNonAdmin, setAckNonAdmin] = useState(false)
  const [ackLinux, setAckLinux] = useState(false)
  const [ackRemoteFiles, setAckRemoteFiles] = useState(false)
  const [phase, setPhase] = useState<'confirm' | 'saved'>('confirm')
  const [pending, setPending] = useState<'save' | 'lifecycle' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setAckNonAdmin(false)
    setAckLinux(false)
    setAckRemoteFiles(false)
    setPhase('confirm')
    setError(null)
  }, [open])

  const guided = status.access === 'guided'
  const needsLinuxAck = status.checksum.requiresLinuxAck
  const acknowledged = ackNonAdmin && (!needsLinuxAck || ackLinux) && (!guided || ackRemoteFiles)
  const ackReason = !acknowledged ? t('checksumOffer.ackRequired') : null
  const serverFilesReason = !canManageServerFiles ? t('checksumOffer.needsServerFiles') : null
  const busy = pending !== null
  // Same rule as the block's "Restart now": an unknown player count gets
  // the 5-minute warning too, never an instant kick.
  const restartWarning = getRestartWarning(status, playerCount)

  // The acknowledgements were given for the server this opened for; if the
  // status moves on to another one, close rather than carry them over.
  const pinned = useDeliveryDialogServer(open, status, busy, () => {
    toast({ title: t('dialog.serverChanged'), variant: 'warning' })
    onOpenChange(false)
  })

  const turnOn = async () => {
    if (guided || !acknowledged || !canManageServerFiles) return
    setPending('save')
    setError(null)
    try {
      // The status this dialog opened with can be minutes old: a restart
      // outside the panel may have brought a loose file back, which would
      // lock every player out the moment the check is on. Re-ask the
      // server instead of trusting the page.
      const fresh: unknown = await panelBridgeApi.getDelivery()
      if (!isDeliveryStatus(fresh) || fresh.serverId !== pinned.serverId || !fresh.checksum.canTurnOn) {
        setError(t('checksumOffer.noLongerAvailable'))
        void onChanged()
        return
      }
      await serverFilesApi.saveIni({ DoLuaChecksum: 'true' })
      toast({ title: t('toast.checksumOn'), variant: 'success' })
      setPhase('saved')
      void onChanged()
    } catch (err) {
      setError(getUserErrorMessage(err, t('toast.checksumFailed')))
    } finally {
      setPending(null)
    }
  }

  const runLifecycle = async () => {
    // /server/restart and /server/start act on whatever is active.
    if (!canControlServer || pinned.changed) return
    setPending('lifecycle')
    try {
      if (status.serverRunning === true) {
        await serverApi.restart(restartWarning.minutes)
        toast({ title: t('toast.restartStarted'), variant: 'success' })
      } else {
        await serverApi.start()
        toast({ title: t('toast.startStarted'), variant: 'success' })
      }
      onOpenChange(false)
      void onChanged()
    } catch (err) {
      setError(getUserErrorMessage(err, t('toast.actionFailed')))
    } finally {
      setPending(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      {/* Height bound: DialogContent's own dvh cap. The acknowledgements
          (three of them, plus the manual steps, on a guided server) scroll
          in a DialogBody so the buttons stay on screen on a phone or a
          zoomed-in window; the short restart prompt needs no body. */}
      <DialogContent className="sm:max-w-xl">
        <DialogHeader className="pe-6">
          <DialogTitle className="flex items-center gap-2 leading-snug">
            <ShieldCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            {t('checksumOffer.title')}
          </DialogTitle>
          <DialogDescription>{t('security.sentence')}</DialogDescription>
        </DialogHeader>

        {phase === 'confirm' ? (
          <DialogBody className="space-y-3" data-testid="bridge-checksum-dialog-body">
            <Ack id={`${baseId}-non-admin`} checked={ackNonAdmin} onChange={setAckNonAdmin} label={t('checksumOffer.ackNonAdmin')} />
            {/* "Turn it off here" only exists where the panel can read the
                check (automatic access); a guided server gets the manual way
                back instead of a promise of a button it never shows. */}
            {needsLinuxAck && (
              <Ack
                id={`${baseId}-linux`}
                checked={ackLinux}
                onChange={setAckLinux}
                label={t(guided ? 'checksumOffer.ackLinuxGuided' : 'checksumOffer.ackLinux')}
              />
            )}
            {guided && (
              <Ack
                id={`${baseId}-remote-files`}
                checked={ackRemoteFiles}
                onChange={setAckRemoteFiles}
                label={t('checksumOffer.ackRemoteFiles')}
              />
            )}
            {guided && (
              <p className="rounded-lg border border-border/60 bg-muted/40 p-3 text-sm">{t('checksumOffer.guidedInstructions')}</p>
            )}
          </DialogBody>
        ) : (
          <div className="space-y-1.5 rounded-lg border border-border/60 bg-muted/40 p-3 text-sm" role="status">
            <p>{t('checksumOffer.restartPrompt')}</p>
            {status.serverRunning === true && restartWarning.minutes > 0 && (
              <p className="text-xs text-muted-foreground">{t('action.restartWarningNote')}</p>
            )}
          </div>
        )}

        {error && (
          <Alert className="border-warning/40 bg-warning/10" aria-live="polite">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          {phase === 'confirm' ? (
            <>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                {t('dialog.cancel')}
              </Button>
              {guided ? (
                acknowledged ? (
                  <Button asChild className={DIALOG_ACTION}>
                    <Link to={SERVER_CONFIG_CHECKSUM_LINK}>
                      <ExternalLink className="h-4 w-4" />
                      {t('checksumOffer.openServerConfig')}
                    </Link>
                  </Button>
                ) : (
                  <DisabledReason reason={ackReason} className="w-full sm:w-auto">
                    <Button type="button" disabled className={DIALOG_ACTION}>
                      <ExternalLink className="h-4 w-4" />
                      {t('checksumOffer.openServerConfig')}
                    </Button>
                  </DisabledReason>
                )
              ) : (
                <DisabledReason reason={serverFilesReason ?? ackReason} className="w-full sm:w-auto">
                  <Button
                    type="button"
                    onClick={() => void turnOn()}
                    disabled={!acknowledged || !canManageServerFiles || busy}
                    className={DIALOG_ACTION}
                  >
                    {pending === 'save' && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t('checksumOffer.confirm')}
                  </Button>
                </DisabledReason>
              )}
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                {t('checksumOffer.later')}
              </Button>
              {status.serverRunning !== null && (
                <DisabledReason reason={!canControlServer ? t('needsServerControl') : null} className="w-full sm:w-auto">
                  <Button
                    type="button"
                    onClick={() => void runLifecycle()}
                    disabled={!canControlServer || busy}
                    className={DIALOG_ACTION}
                  >
                    {pending === 'lifecycle' && <Loader2 className="h-4 w-4 animate-spin" />}
                    {status.serverRunning ? t('action.restartNow') : t('action.startServer')}
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
