import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Archive, Megaphone, RotateCcw, Save, SquareTerminal, type LucideIcon } from 'lucide-react'
import { useDateFormat } from '@/lib/dateFormat'
import { parseSimpleCron } from '@/lib/cronSchedule'

/** What a task does, as the dialog's first choice. Backup is a pointer: the backup schedule lives on Backups. */
export type TaskType = 'restart' | 'save' | 'broadcast' | 'command' | 'backup'

export const TASK_TYPE_ICONS: Record<TaskType, LucideIcon> = {
  restart: RotateCcw,
  save: Save,
  broadcast: Megaphone,
  command: SquareTerminal,
  backup: Archive,
}

const BROADCAST_PREFIX = 'servermsg '

/**
 * Reads a saved command back into the dialog's task type, the same way the
 * server classifies it (scheduler.js classifyScheduledCommand): exactly
 * "restart" or "save", or a "servermsg " broadcast. Anything else, PanelBridge
 * actions included, is a command and is kept verbatim.
 */
export function taskTypeOfCommand(command: string): { type: Exclude<TaskType, 'backup'>; message: string; command: string } {
  const lower = command.trim().toLowerCase()
  if (lower === 'restart') return { type: 'restart', message: '', command: '' }
  if (lower === 'save') return { type: 'save', message: '', command: '' }
  if (command.toLowerCase().startsWith(BROADCAST_PREFIX)) {
    return { type: 'broadcast', message: command.slice(BROADCAST_PREFIX.length), command: '' }
  }
  return { type: 'command', message: '', command }
}

export function commandForTaskType(type: TaskType | null, message: string, command: string): string {
  if (type === 'restart') return 'restart'
  if (type === 'save') return 'save'
  if (type === 'broadcast') return message.trim() ? `${BROADCAST_PREFIX}${message.trim()}` : ''
  if (type === 'command') return command.trim()
  return ''
}

// PanelBridge actions and other suggestions for the Command type. Restart,
// save and broadcasts have their own task types.
export function getCommandSuggestions(t: TFunction) {
  return [
    { label: t('commands.checkModUpdates'), value: 'checkModsNeedUpdate' },
    // PanelBridge actions, routed through the Lua mod via `bridge:<action>`.
    // JSON args after the action name are validated server-side.
    { label: t('commands.triggerBlizzard'), value: 'bridge:triggerBlizzard {"duration":2}' },
    { label: t('commands.triggerStorm'), value: 'bridge:triggerStorm {"duration":1}' },
    { label: t('commands.triggerTropicalStorm'), value: 'bridge:triggerTropicalStorm {"duration":1}' },
    { label: t('commands.stopAllWeather'), value: 'bridge:stopWeather' },
    { label: t('commands.startRain'), value: 'bridge:startRain {"intensity":0.7}' },
    { label: t('commands.stopRain'), value: 'bridge:stopRain' },
    { label: t('commands.restoreUtilities'), value: 'bridge:restoreUtilities' },
    { label: t('commands.shutOffUtilities'), value: 'bridge:shutOffUtilities' },
    // No bridge:saveWorld suggestion (#197): the bridge's save wrote the
    // world's map_sand.bin. An existing bridge:saveWorld task runs as `save`.
    { label: t('commands.broadcastServerChat'), value: 'bridge:sendToServerChat {"message":"Scheduled broadcast"}' },
  ]
}

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** Plain-language schedules and task summaries, in the UI language. */
export function useScheduleText() {
  const { t, i18n } = useTranslation('scheduler')
  const { formatTime } = useDateFormat()

  return useMemo(() => {
    const dayName = (day: number) => t(`weekdays.${WEEKDAY_KEYS[day % 7]}.name`)
    const dayShort = (day: number) => t(`weekdays.${WEEKDAY_KEYS[day % 7]}.short`)
    // A time of day, not an instant: formatted in UTC so the browser's own
    // zone can't move it, in the locale's 12/24-hour style.
    const timeOfDay = (hour: number, minute: number) =>
      formatTime(Date.UTC(2000, 0, 1, hour, minute), { timeZone: 'UTC', pad: true })

    // Intl.ListFormat is ES2021: not in this project's TS lib, in every browser the panel supports.
    const ListFormat = (Intl as unknown as { ListFormat?: new (locale: string, options: object) => { format: (list: string[]) => string } }).ListFormat
    const joinDays = (days: number[]) => {
      // Monday first, Sunday last, the way the day picker lays them out.
      const names = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(dayName)
      try {
        return ListFormat ? new ListFormat(i18n.language, { style: 'long', type: 'conjunction' }).format(names) : names.join(', ')
      } catch {
        return names.join(', ')
      }
    }

    /** "Every day at 06:00", "Every 6 hours"; null for a cron only the Advanced field can show. */
    const describeCron = (cron: string): string | null => {
      const simple = parseSimpleCron(cron)
      if (!simple) return null
      if (simple.mode === 'interval') {
        return simple.everyHours <= 1 ? t('summary.hourly') : t('summary.everyNHours', { count: simple.everyHours })
      }
      const time = timeOfDay(simple.hour, simple.minute)
      if (simple.mode === 'daily') return t('summary.daily', { time })
      if (simple.days.join(',') === '1,2,3,4,5') return t('summary.monToFri', { time })
      return t('summary.weekdays', { days: joinDays(simple.days), time })
    }

    const typeLabel = (type: TaskType) => t(`taskType.${type}`)

    return { dayName, dayShort, timeOfDay, describeCron, typeLabel }
  }, [t, i18n.language, formatTime])
}
