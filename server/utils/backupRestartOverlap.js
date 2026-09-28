// Scheduled backups vs scheduled restarts (2026-09-27, Discord report from a
// Linux/Docker operator: "Scheduled backup failing -- Skipped: a restart was
// in progress", with a restart schedule and a backup schedule both firing
// every 4 hours on the hour). scheduler.js holds a scheduled backup back
// while performRestart() is running (see _onScheduledBackupTick() in
// scheduler.js for why a backup must not archive the save mid-restart); this file
// is the read-only half of that story -- recognising the old skip rows, and
// predicting, from the two cron expressions alone, which restart schedules a
// backup schedule keeps landing inside, so the Backups/Scheduler pages can
// say so before the operator wonders why backups run late.
import {
  expandCronField,
  hasUnsupportedCronFieldCount,
  zonedDateParts,
} from "./cronValidation.js";
import { expandCronFieldRanged } from "./cronNextRun.js";

// The exact Schedule History message scheduler.js wrote for a scheduled
// backup that fired during a restart, before those backups were deferred
// instead of dropped. Nothing writes it any more, but an install upgrading
// from v1.3.8 or earlier still has these rows (the reporting operator had
// one as the newest backup row, forever, because every tick collided) --
// backupService.getStatus() recognises it so the UI can call it what it
// was, a skip, rather than a backup that broke.
export const LEGACY_RESTART_SKIP_MESSAGE = "Skipped: a restart was in progress";

// How long a scheduled restart typically keeps restartInProgress set AFTER
// its warning countdown: the final countdown seconds, the world save, quit,
// the process-exit wait, relaunch and the first RCON handshake
// (performRestart() in scheduler.js). A typical figure, used only to decide
// whether to WARN about an overlap -- the deferral itself waits against a
// much larger hard budget (RESTART_SEQUENCE_BUDGET_MS in scheduler.js).
export const RESTART_TYPICAL_TAIL_MINUTES = 5;

const MINUTES_PER_DAY = 24 * 60;
// A year and a day: long enough to cover every day-of-month/month/weekday
// combination at least once, so a "1st of the month" or a weekly restart is
// never missed just because its day isn't this week.
const HORIZON_DAYS = 366;

function parseDaySchedule(expression) {
  if (typeof expression !== "string" || hasUnsupportedCronFieldCount(expression)) {
    return null;
  }
  const [minuteField, hourField, domField, monthField, dowField] = expression
    .trim()
    .split(/\s+/);
  const minutes = expandCronField(minuteField, 59);
  const hours = expandCronField(hourField, 23);
  const doms = expandCronFieldRanged(domField, 1, 31);
  const months = expandCronFieldRanged(monthField, 1, 12);
  const dows = expandCronFieldRanged(dowField, 0, 6);
  // Names (MON, JAN) and the 7-means-Sunday alias are valid to node-cron but
  // not to these expanders -- no warning is better than a wrong one, and
  // computeNextRun() makes the same trade for the same reason.
  if (!minutes || !hours || !doms || !months || !dows) return null;

  const fireMinutes = new Uint8Array(MINUTES_PER_DAY);
  for (const hour of hours) {
    for (const minute of minutes) fireMinutes[hour * 60 + minute] = 1;
  }
  const list = [];
  for (let minute = 0; minute < MINUTES_PER_DAY; minute++) {
    if (fireMinutes[minute]) list.push(minute);
  }
  return { fireMinutes, list, doms, months, dows };
}

// node-cron's own day rule, the one that decides when the jobs actually
// fire: month, day-of-month and day-of-week must ALL match (TimeMatcher.match
// in node-cron 4.x ANDs them; a "*" field expands to every value, so it
// never excludes a day). That is NOT the classic cron rule, where two
// restricted day fields match if EITHER does -- computeNextRun() still
// applies that one, a separate pre-existing divergence that only differs
// for a schedule restricting both fields ("0 4 1 * 1"). Both schedules run
// in the same scheduler timezone, so comparing LOCAL wall-clock dates is
// exactly the question -- the weekday of a local calendar date is plain
// Gregorian arithmetic, no zone lookup needed.
function firesOnDay(schedule, year, month, day) {
  if (!schedule.months.has(month) || !schedule.doms.has(day)) return false;
  return schedule.dows.has(new Date(Date.UTC(year, month - 1, day)).getUTCDay());
}

function localDate(start, offsetDays) {
  const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offsetDays));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

// First (restart minute, backup minute) pair, in calendar order, where the
// backup fires at or after the restart and before `windowMinutes` have
// passed -- i.e. while that restart would typically still be running. A
// window reaching past midnight checks the backup against the NEXT day's
// schedule.
function firstOverlap(backup, restart, start, windowMinutes) {
  for (let offset = 0; offset < HORIZON_DAYS; offset++) {
    const today = localDate(start, offset);
    if (!firesOnDay(restart, today.year, today.month, today.day)) continue;
    const tomorrow = localDate(start, offset + 1);
    const backupToday = firesOnDay(backup, today.year, today.month, today.day);
    const backupTomorrow = firesOnDay(backup, tomorrow.year, tomorrow.month, tomorrow.day);
    if (!backupToday && !backupTomorrow) continue;

    for (const restartMinute of restart.list) {
      for (let delta = 0; delta < windowMinutes; delta++) {
        const at = restartMinute + delta;
        const hit =
          at < MINUTES_PER_DAY
            ? backupToday && backup.fireMinutes[at]
            : backupTomorrow && backup.fireMinutes[at - MINUTES_PER_DAY];
        if (hit) return { restartMinute, backupMinute: at % MINUTES_PER_DAY };
      }
    }
  }
  return null;
}

// Whether EVERY backup the schedule fires over the same horizon lands
// inside one of this restart schedule's windows (today's restarts, or one
// from the day before whose window reaches past midnight). The notice
// otherwise quotes only the first colliding pair, and "the 00:00 backup"
// alone reads as if only the midnight one were affected -- with both on
// "0 */4 * * *" (the reported setup) it is all six a day.
function everyBackupOverlaps(backup, restart, start, windowMinutes) {
  // coverToday[m]: a restart firing earlier the same day still covers
  // minute m; coverFromYesterday[m]: one from the previous day does.
  const coverToday = new Uint8Array(MINUTES_PER_DAY);
  const coverFromYesterday = new Uint8Array(MINUTES_PER_DAY);
  for (const restartMinute of restart.list) {
    for (let delta = 0; delta < windowMinutes; delta++) {
      const at = restartMinute + delta;
      if (at < MINUTES_PER_DAY) coverToday[at] = 1;
      else coverFromYesterday[at - MINUTES_PER_DAY] = 1;
    }
  }

  let sawBackup = false;
  for (let offset = 0; offset < HORIZON_DAYS; offset++) {
    const today = localDate(start, offset);
    if (!firesOnDay(backup, today.year, today.month, today.day)) continue;
    const yesterday = localDate(start, offset - 1);
    const restartToday = firesOnDay(restart, today.year, today.month, today.day);
    const restartYesterday = firesOnDay(
      restart,
      yesterday.year,
      yesterday.month,
      yesterday.day,
    );
    for (const backupMinute of backup.list) {
      sawBackup = true;
      const covered =
        (restartToday && coverToday[backupMinute]) ||
        (restartYesterday && coverFromYesterday[backupMinute]);
      if (!covered) return false;
    }
  }
  return sawBackup;
}

// The longest stretch, in minutes, between two consecutive backup fire
// times of a day (wrapping from the last one to the next day's first).
function longestBackupGap(backup) {
  const { list } = backup;
  let longest = list[0] + MINUTES_PER_DAY - list[list.length - 1];
  for (let i = 1; i < list.length; i++) {
    longest = Math.max(longest, list[i] - list[i - 1]);
  }
  return longest;
}

function formatMinuteOfDay(minuteOfDay) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}`;
}

/**
 * Which of `restarts` ({kind, name, cron}) the backup schedule `backupCron`
 * fires inside of -- at the same minute as the restart, or within
 * `windowMinutes` after it. One entry per overlapping restart schedule, with
 * the first colliding pair of local times ("HH:MM") as an example the UI can
 * quote, `allBackups` when every backup collides (not just that one), and
 * the window itself (how far apart the operator needs to move the two).
 * Empty when nothing overlaps or either expression can't be parsed
 * (advisory only: a missed warning costs a late backup, never a lost one --
 * the scheduler defers colliding backups regardless of what this predicts).
 */
export function findBackupRestartOverlaps(
  backupCron,
  restarts,
  { timezone = "UTC", windowMinutes = 1, from = new Date() } = {},
) {
  const backup = parseDaySchedule(backupCron);
  if (!backup || !Array.isArray(restarts) || restarts.length === 0) return [];

  let start;
  try {
    start = zonedDateParts(from, timezone);
  } catch {
    start = zonedDateParts(from, "UTC");
  }
  const window = Math.max(1, Math.floor(windowMinutes));
  // A backup schedule that never leaves `window` minutes without a run
  // ("*/5" against the default 10-minute window) lands on every restart no
  // matter how the two are staggered, so the notice's advice can't apply --
  // and nothing is late in any sense that matters: the held-back run
  // starts as soon as the restart ends, around when the next tick or two
  // were due anyway (those fold into it). Warning about that would be a
  // permanent banner with no fix.
  if (longestBackupGap(backup) <= window) return [];

  const overlaps = [];
  for (const restart of restarts) {
    const parsed = parseDaySchedule(restart?.cron);
    if (!parsed) continue;
    const hit = firstOverlap(backup, parsed, start, window);
    if (!hit) continue;
    overlaps.push({
      kind: restart.kind,
      name: restart.name ?? null,
      cron: restart.cron,
      restartTime: formatMinuteOfDay(hit.restartMinute),
      backupTime: formatMinuteOfDay(hit.backupMinute),
      allBackups: everyBackupOverlaps(backup, parsed, start, window),
      windowMinutes: window,
    });
  }
  return overlaps;
}
