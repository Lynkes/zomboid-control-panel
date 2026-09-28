import i18n from '@/i18n'
import { splitUptime } from '@/lib/utils'

// An elapsed time in the UI language, worded exactly as the Dashboard words
// the server's uptime: each unit from serverUptime.json's units.*, where
// translators own the abbreviations ("3 d 4 h 5 min" in pt-BR, "3 Tg. 4 Std.
// 5 Min." in German), seconds only within the first minute, then whole
// minutes. Floored, never rounded, so one duration reads the same wherever
// it appears -- ServerUptime, and the ages inside Settings > Bridge's
// diagnostics, which used to carry the server's English "2m" for 90 s next
// to the Dashboard's "1 min".
export function formatElapsed(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const shown = whole < 60 ? whole : whole - (whole % 60)
  return splitUptime(shown)
    .map(({ unit, count }) => i18n.t(`units.${unit}`, { ns: 'serverUptime', count }))
    .join(' ')
}
