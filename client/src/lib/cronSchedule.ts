import { zonedDateParts } from '@/lib/dateFormat'

// Schedule maths for the Scheduler page: the friendly builder's modes, the
// cron each one saves, reading a saved cron back into them, and a preview
// of the next runs. The server (node-cron + /validate-cron) stays the judge
// of what is valid and of the real next run; this only explains it.

export type ScheduleMode = 'daily' | 'interval' | 'weekdays' | 'advanced'

/** Hour steps that divide the day evenly, so "every N hours" stays even across midnight. */
export const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12] as const

export interface SimpleSchedule {
  mode: Exclude<ScheduleMode, 'advanced'>
  hour: number
  minute: number
  everyHours: number
  /** Cron weekdays, 0 = Sunday, sorted. */
  days: number[]
}

/** "06:30" -> [6, 30]; null for anything else. */
export function parseTimeOfDay(value: string): [number, number] | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return [hour, minute]
}

export function formatTimeOfDay(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function buildSimpleCron(schedule: SimpleSchedule): string {
  const { mode, hour, minute, everyHours, days } = schedule
  if (mode === 'interval') return everyHours <= 1 ? '0 * * * *' : `0 */${everyHours} * * *`
  if (mode === 'weekdays') return `${minute} ${hour} * * ${[...days].sort((a, b) => a - b).join(',')}`
  return `${minute} ${hour} * * *`
}

const PLAIN_INT = /^\d{1,2}$/

function expandWeekdays(field: string): number[] | null {
  const days = new Set<number>()
  for (const part of field.split(',')) {
    const range = /^(\d)(?:-(\d))?$/.exec(part)
    if (!range) return null
    const from = Number(range[1])
    const to = range[2] === undefined ? from : Number(range[2])
    if (from > 7 || to > 7 || to < from) return null
    for (let day = from; day <= to; day++) days.add(day % 7)
  }
  return [...days].sort((a, b) => a - b)
}

/**
 * The builder mode a saved cron fits, or null when only the Advanced field
 * can show it. Every cron buildSimpleCron writes comes back unchanged.
 */
export function parseSimpleCron(cron: string): SimpleSchedule | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dom, month, dow] = fields
  if (dom !== '*' || month !== '*') return null
  if (minute === '0' && dow === '*') {
    if (hour === '*') return { mode: 'interval', hour: 0, minute: 0, everyHours: 1, days: [] }
    const step = /^\*\/(\d{1,2})$/.exec(hour)
    if (step) {
      const everyHours = Number(step[1])
      if (everyHours >= 1 && everyHours <= 23) return { mode: 'interval', hour: 0, minute: 0, everyHours, days: [] }
      return null
    }
  }
  if (!PLAIN_INT.test(minute) || !PLAIN_INT.test(hour)) return null
  const m = Number(minute)
  const h = Number(hour)
  if (m > 59 || h > 23) return null
  if (dow === '*') return { mode: 'daily', hour: h, minute: m, everyHours: 1, days: [] }
  const days = expandWeekdays(dow)
  if (!days || days.length === 0) return null
  if (days.length === 7) return { mode: 'daily', hour: h, minute: m, everyHours: 1, days: [] }
  return { mode: 'weekdays', hour: h, minute: m, everyHours: 1, days }
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

function fieldValue(token: string, names: string[] | null, nameOffset: number): number | null {
  if (/^\d+$/.test(token)) return Number(token)
  if (!names) return null
  const index = names.indexOf(token.toUpperCase())
  return index === -1 ? null : index + nameOffset
}

/** One cron field as the set of values it matches; null for syntax this preview doesn't read (L, W, #, ?). */
function expandField(field: string, min: number, max: number, names: string[] | null = null, nameOffset = 0): Set<number> | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const [rangePart, stepPart, extra] = part.split('/')
    if (extra !== undefined) return null
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) return null
    let from: number
    let to: number
    if (rangePart === '*') {
      from = min
      to = max
    } else {
      const [startToken, endToken, more] = rangePart.split('-')
      if (more !== undefined) return null
      const start = fieldValue(startToken, names, nameOffset)
      if (start === null) return null
      const end = endToken === undefined ? (stepPart === undefined ? start : max) : fieldValue(endToken, names, nameOffset)
      if (end === null) return null
      from = start
      to = end
    }
    if (from < min || to > max || from > to) return null
    for (let value = from; value <= to; value += step) values.add(value)
  }
  return values
}

// The instant whose wall clock in `timeZone` reads y-m-d h:mi, or null when
// that time doesn't exist there (skipped by a daylight-saving jump).
function zonedToEpoch(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number | null {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  const offsetAt = (instant: number) => {
    const parts = zonedDateParts(instant, timeZone)
    if (!parts) return null
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - instant
  }
  const first = offsetAt(wall)
  if (first === null) return null
  let instant = wall - first
  const second = offsetAt(instant)
  if (second !== null && second !== first) instant = wall - second
  const check = zonedDateParts(instant, timeZone)
  if (!check || check.hour !== hour || check.minute !== minute) return null
  return instant
}

/**
 * The next `count` runs of a cron in a time zone, soonest first, as epoch
 * milliseconds. null when the preview can't read the expression (a seconds
 * field, L/W/# tokens, day-of-month and weekday both set) or the zone is
 * unknown here; the task list's next run, from the server, still shows.
 */
export function nextCronRuns(cron: string, timeZone: string, count = 3, from: number = Date.now()): number[] | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minutes = expandField(fields[0], 0, 59)
  const hours = expandField(fields[1], 0, 23)
  const doms = expandField(fields[2], 1, 31)
  const months = expandField(fields[3], 1, 12, MONTH_NAMES, 1)
  const rawDays = expandField(fields[4], 0, 7, DAY_NAMES, 0)
  if (!minutes || !hours || !doms || !months || !rawDays) return null
  if (fields[2] !== '*' && fields[4] !== '*') return null
  const days = new Set([...rawDays].map((day) => day % 7))
  const today = zonedDateParts(from, timeZone)
  if (!today) return null
  const sortedHours = [...hours].sort((a, b) => a - b)
  const sortedMinutes = [...minutes].sort((a, b) => a - b)
  const runs: number[] = []
  for (let offset = 0; offset <= 366 * 4 && runs.length < count; offset++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset))
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    if (!months.has(month) || !doms.has(day) || !days.has(date.getUTCDay())) continue
    for (const hour of sortedHours) {
      for (const minute of sortedMinutes) {
        const instant = zonedToEpoch(year, month, day, hour, minute, timeZone)
        if (instant !== null && instant > from) {
          runs.push(instant)
          if (runs.length === count) return runs
        }
      }
    }
  }
  return runs
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

/** "in 3 hr." / "2 hr. ago" in the formatting locale; null for a missing or invalid time. */
export function formatRelativeTime(value: string | number | null | undefined, locale: string, now: number = Date.now()): string | null {
  const time = typeof value === 'number' ? value : value ? Date.parse(value) : NaN
  if (!Number.isFinite(time)) return null
  let format: Intl.RelativeTimeFormat
  try {
    format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
  } catch {
    format = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' })
  }
  const delta = time - now
  const distance = Math.abs(delta)
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (distance >= ms) {
      // Round toward "now" for the past and away from it for the future, so
      // a run 59 minutes off never reads "in 0 hr.".
      const amount = delta < 0 ? -Math.floor(distance / ms) : Math.round(distance / ms)
      return format.format(amount, unit)
    }
  }
  return format.format(0, 'minute')
}
