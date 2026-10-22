import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { DisabledReason } from '@/components/DisabledReason'
import { useToast } from '@/components/ui/use-toast'
import { useSocket } from '@/contexts/SocketContext'
import { backupApi, serversApi, type ServerInstance } from '@/lib/api'
import { withAutoStartServer } from '@/lib/autoStartServers'
import { getUserErrorMessage } from '@/lib/errorMessage'

// Which servers the backup schedule backs up (backupServerIds), on the
// Backups page's schedule card -- the same choice as each row's "Scheduled
// backup" on the Dashboard's list of servers. Shown with two local servers
// or more: with one, the schedule backs up the active server, as it always
// did. Each checkbox saves at once, on its own, like the auto-start list in
// Settings › Connection. A remote server's world isn't on this machine.

interface ScheduledBackupServersProps {
  canManage: boolean
}

export function ScheduledBackupServers({ canManage }: ScheduledBackupServersProps) {
  const { t } = useTranslation(['backups', 'dashboard'])
  const { toast } = useToast()
  const socket = useSocket()
  const [servers, setServers] = useState<ServerInstance[]>([])
  const [serverIds, setServerIds] = useState<string[] | null>(null)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    const [list, summary] = await Promise.allSettled([serversApi.getAll(), backupApi.getSummary()])
    if (list.status === 'fulfilled') setServers(list.value?.servers ?? [])
    if (summary.status === 'fulfilled') {
      const ids = summary.value?.schedule?.serverIds
      setServerIds(Array.isArray(ids) ? ids.map(String) : null)
      setLoaded(true)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!socket) return
    const onChange = () => { void load() }
    socket.on('activeServerChanged', onChange)
    return () => { socket.off('activeServerChanged', onChange) }
  }, [socket, load])

  const local = servers.filter((server) => !server.isRemote)
  if (!loaded || local.length < 2) return null

  const activeId = servers.find((server) => server.isActive)?.id
  const chosen = serverIds ?? (activeId !== undefined ? [String(activeId)] : [])

  const toggle = async (server: ServerInstance, checked: boolean) => {
    if (!canManage) return
    const previous = serverIds
    const next = withAutoStartServer(chosen, server.id, checked)
    setServerIds(next)
    try {
      await backupApi.updateSettings({ serverIds: next })
      toast({
        title: t(checked ? 'dashboard:serversOverview.scheduledBackupOnTitle' : 'dashboard:serversOverview.scheduledBackupOffTitle'),
        description: t(checked ? 'dashboard:serversOverview.scheduledBackupOnDesc' : 'dashboard:serversOverview.scheduledBackupOffDesc', { name: server.name || server.serverName }),
      })
    } catch (error) {
      setServerIds(previous)
      toast({
        title: t('dashboard:toasts.errorTitle'),
        description: getUserErrorMessage(error, t('dashboard:serversOverview.scheduledBackupSaveFailed')),
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="space-y-2" data-testid="scheduled-backup-servers">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{t('settingsPanel.scheduledServersLabel')}</p>
        <p className="text-xs text-muted-foreground">{t('settingsPanel.scheduledServersHelp')}</p>
      </div>
      <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
        {local.map((server) => {
          const id = `scheduled-backup-server-${server.id}`
          return (
            <li key={server.id} className="flex items-center gap-3 px-3 py-2">
              <DisabledReason reason={!canManage ? t('permissions.noManage') : null}>
                <Checkbox
                  id={id}
                  checked={chosen.includes(String(server.id))}
                  disabled={!canManage}
                  onCheckedChange={(checked) => toggle(server, checked === true)}
                />
              </DisabledReason>
              <Label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
                <span className="truncate">{server.name || server.serverName}</span>
                {server.isActive && (
                  <span className="inline-flex shrink-0 items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                    {t('dashboard:serversOverview.activeBadge')}
                  </span>
                )}
              </Label>
            </li>
          )
        })}
      </ul>
      {chosen.length === 0 && (
        <p className="text-xs text-warning">{t('settingsPanel.scheduledServersNone')}</p>
      )}
    </div>
  )
}
