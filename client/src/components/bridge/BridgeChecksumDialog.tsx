import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AlertTriangle, ExternalLink, Loader2, ShieldCheck } from 'lucide-react'
import {
  Dialog,
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
import { panelBridgeApi, serverApi, serverFilesApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'
import type { DeliveryStatus } from '@/lib/bridgeDeliveryTypes'

const RESTART_WARNING_MINUTES = 5
const SERVER_CONFIG_CHECKSUM_LINK = '/server-config?tab=ini&search=DoLuaChecksum'
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
  const playersOnline = status.live?.alive === true && (playerCount ?? 0) > 0

  const turnOn = async () => {
    if (guided || !acknowledged || !canManageServerFiles) return
    setPending('save')
    setError(null)
    try {
      // The status this dialog opened with can be minutes old: a restart
      // outside the panel may have brought a loose file back, which would
      // lock every player out the moment the check is on. Re-ask the
      // server instead of trusting the page.
      const fresh = await panelBridgeApi.getDelivery()
      if (fresh.serverId !== status.serverId || !fresh.checksum.canTurnOn) {
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
    if (!canControlServer) return
    setPending('lifecycle')
    try {
      if (status.serverRunning === true) {
        await serverApi.restart(playersOnline ? RESTART_WARNING_MINUTES : 0)
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-h-[80vh] sm:max-w-xl">
        <DialogHeader className="pe-6">
          <DialogTitle className="flex items-center gap-2 leading-snug">
            <ShieldCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            {t('checksumOffer.title')}
          </DialogTitle>
          <DialogDescription>{t('security.sentence')}</DialogDescription>
        </DialogHeader>

        {phase === 'confirm' ? (
          <div className="space-y-3">
            <Ack id={`${baseId}-non-admin`} checked={ackNonAdmin} onChange={setAckNonAdmin} label={t('checksumOffer.ackNonAdmin')} />
            {needsLinuxAck && (
              <Ack id={`${baseId}-linux`} checked={ackLinux} onChange={setAckLinux} label={t('checksumOffer.ackLinux')} />
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
          </div>
        ) : (
          <p className="rounded-lg border border-border/60 bg-muted/40 p-3 text-sm" role="status">
            {t('checksumOffer.restartPrompt')}
          </p>
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
