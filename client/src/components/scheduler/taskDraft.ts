import { formatTimeOfDay, parseSimpleCron, type ScheduleMode } from '@/lib/cronSchedule'
import { taskTypeOfCommand, type TaskType } from './scheduleText'

/** Everything the task dialog edits. Built once per open; the dialog is keyed on it. */
export interface TaskDraft {
  name: string
  /** The name follows the type and schedule until the operator types one. */
  nameAuto: boolean
  type: TaskType | null
  message: string
  command: string
  mode: ScheduleMode
  /** 'HH:MM' */
  time: string
  everyHours: string
  /** Cron weekdays, 0 = Sunday */
  days: number[]
  cron: string
  serverId: string
}

export interface CronPreset {
  name: string
  cron: string
}

export function emptyTaskDraft(serverId: string): TaskDraft {
  return {
    name: '',
    nameAuto: true,
    type: null,
    message: '',
    command: '',
    mode: 'daily',
    time: '06:00',
    everyHours: '6',
    days: [1],
    cron: '',
    serverId,
  }
}

/** A draft holding a saved task (Edit) or a copy of one (Duplicate, with its own name). */
export function draftFromTask(task: { name: string; cron_expression: string; command: string; server_id: string | number | null }, name = task.name): TaskDraft {
  const kind = taskTypeOfCommand(task.command)
  const simple = parseSimpleCron(task.cron_expression)
  const base = emptyTaskDraft(task.server_id != null ? String(task.server_id) : '')
  return {
    ...base,
    name,
    nameAuto: false,
    type: kind.type,
    message: kind.message,
    command: kind.command,
    cron: task.cron_expression,
    ...(simple
      ? {
          mode: simple.mode,
          time: formatTimeOfDay(simple.hour, simple.minute),
          everyHours: String(simple.everyHours),
          days: simple.mode === 'weekdays' ? simple.days : base.days,
        }
      : { mode: 'advanced' as const }),
  }
}
