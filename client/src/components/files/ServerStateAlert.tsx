import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, RefreshCw, Satellite } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { ProfileFiles } from '@/types/files'

interface ServerStateAlertProps {
  profile: ProfileFiles
  checking: boolean
  onCheckAgain: () => void
}

// The live-state callout above the file list (spec §A14.4). Running and
// "can't tell" on a local server are warnings: world save files are locked
// while it runs, and game or launch files need a confirmation. A remote
// server's state is never visible to the panel, which is a plain fact, not
// a warning. Nothing shows while the server is stopped.
export function ServerStateAlert({ profile, checking, onCheckAgain }: ServerStateAlertProps) {
  const { t } = useTranslation('files')

  if (profile.remote) {
    return (
      <Alert className="border-border/60 bg-muted/40">
        <Satellite className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <AlertDescription className="text-muted-foreground">{t('serverState.remoteUnknown')}</AlertDescription>
      </Alert>
    )
  }

  const state = profile.serverState
  if (state !== 'running' && state !== 'unknown') return null

  return (
    <Alert className="border-warning/40 bg-warning/10">
      <AlertTriangle className="h-4 w-4 !text-warning" aria-hidden="true" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <AlertTitle className="text-warning">{t(`serverState.${state}.title`)}</AlertTitle>
          <AlertDescription className="text-muted-foreground">{t(`serverState.${state}.body`)}</AlertDescription>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 self-start" onClick={onCheckAgain} disabled={checking}>
          {checking ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
          {t('serverState.checkAgain')}
        </Button>
      </div>
    </Alert>
  )
}
