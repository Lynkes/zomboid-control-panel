import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { filesApi } from '@/lib/filesApi'
import type { ProfileFiles } from '@/types/files'
import { MOBILE_FULL_SCREEN } from './NameDialog'
import { describeFilesError } from './filesUi'

interface RemoteRootsDialogProps {
  open: boolean
  profile: ProfileFiles
  /** can('bridge.setup'): the route also needs it (spec §A10.2). */
  canEdit: boolean
  onClose: () => void
  onSaved: (profile: ProfileFiles) => void
}

// "Set remote folders" for the active remote server (spec §A14.3): the game
// install folder has no default, and the Zomboid folder defaults to the one
// derived from the PanelBridge SFTP paths. An empty field clears the
// override. The server validates both (absolute POSIX, no "..").
export function RemoteRootsDialog({ open, profile, canEdit, onClose, onSaved }: RemoteRootsDialogProps) {
  const { t } = useTranslation('files')
  const [installPath, setInstallPath] = useState('')
  const [dataPath, setDataPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setInstallPath(profile.remoteRoots?.installPath ?? '')
    setDataPath(profile.remoteRoots?.dataPath ?? '')
    setError(null)
    setBusy(false)
  }, [open, profile.remoteRoots?.dataPath, profile.remoteRoots?.installPath])

  const derived = profile.remoteRoots?.derivedDataPath ?? ''
  const reachesEverything = installPath.trim() === '/' || dataPath.trim() === '/'

  const save = async () => {
    if (!canEdit) return
    setBusy(true)
    setError(null)
    try {
      const result = await filesApi.setRemoteRoots(profile.id, {
        installPath: installPath.trim() || null,
        dataPath: dataPath.trim() || null,
      })
      onSaved(result.profile)
    } catch (err) {
      setError(describeFilesError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose() }}>
      <DialogContent className={MOBILE_FULL_SCREEN}>
        <DialogHeader>
          <DialogTitle>{t('remote.title')}</DialogTitle>
          <DialogDescription>{t('remote.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          {!canEdit && (
            <p className="rounded-lg border border-border/60 bg-muted/40 p-3 text-sm text-muted-foreground">{t('remote.needsBridgeSetup')}</p>
          )}
          <div>
            <Label htmlFor="files-remote-install">{t('remote.installLabel')}</Label>
            <Input
              id="files-remote-install"
              dir="ltr"
              value={installPath}
              onChange={(event) => setInstallPath(event.target.value)}
              disabled={!canEdit || busy}
              spellCheck={false}
              autoComplete="off"
              className="mt-1.5 min-h-11 font-mono sm:min-h-9"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('remote.installHelp')}</p>
          </div>
          <div>
            <Label htmlFor="files-remote-data">{t('remote.dataLabel')}</Label>
            <Input
              id="files-remote-data"
              dir="ltr"
              value={dataPath}
              placeholder={derived}
              onChange={(event) => setDataPath(event.target.value)}
              disabled={!canEdit || busy}
              spellCheck={false}
              autoComplete="off"
              className="mt-1.5 min-h-11 font-mono sm:min-h-9"
            />
            {derived && <p className="mt-1 text-xs text-muted-foreground">{t('remote.dataHelp', { derived })}</p>}
          </div>
          {reachesEverything && (
            <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {t('remote.rootWarning')}
            </p>
          )}
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{t('actions.cancel')}</Button>
            <Button type="submit" disabled={!canEdit || busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              {t('remote.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
