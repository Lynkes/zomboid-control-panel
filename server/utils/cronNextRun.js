// continuous-bug-hunt round 28 (ux-proposals-need-backend-data): the UX
// deep pass (092bfac0) wanted per-task and per-backup-schedule "next run"
// times on the Scheduler page but had no server data to show -- node-cron
// (this codebase's scheduling library) exposes cron.parse() for field
// expansion but has no "what time does this fire next" API of its own.
// Built on the SAME timezone-resolution primitives cronValidation.js's own
// DST-warning checks already use (expandCronField/zonedDateParts/
// utcOffsetMinutes), rather than a second, independently-typed date-math
// implementation that could disagree with those checks about what a given
// cron expression + timezone combination actually means.
//
// Its day rule is node-cron 4's, not classic cron's: see computeNextRun.
// nodeCronNextRun() below asks node-cron itself instead, for a preview that
// must also cover the syntax these expanders don't (MON, L, 1#1, 7).
import cron from "node-cron";
import {
  hasUnsupportedCronFieldCount,
  expandCronField,
  zonedDateParts,
  utcOffsetMinutes,
} from "./cronValidation.js";

// Cron's own day-of-month/month fields are 1-based (unlike minute/hour,
// which are 0-based) -- "*" must expand to 1..max, not 0..max, or a bare "*"
// day-of-month field would wrongly treat day 0 as a valid match. The same
// expander as the minute/hour fields (cronValidation.js's expandCronField,
// wrap-around ranges included) with a 1-based lower bound, so the two can't
// drift apart on what a field means.
// Exported for backupRestartOverlap.js, which needs the same day-level
// field expansion to decide whether two schedules can fire on the same day.
export function expandCronFieldRanged(field, min, max) {
  return expandCronField(field, max, min);
}

// Resolves a LOCAL wall-clock moment in `zone` to the real UTC instant it
// names. Same guess/re-derive-twice technique as cronValidation.js's own
// wallTimeExists (which only checks existence) -- here we need the actual
// instant, not just a yes/no, so this returns candidate2 (the doubly-
// corrected guess) directly. A wall time that was skipped entirely by a
// spring-forward transition has no real answer; candidate2 still lands on
// SOME nearby real instant in that rare case, an acceptable estimate for a
// "next run" preview (never used to actually fire anything -- node-cron's
// own scheduler, which already handles this correctly, does the real
// firing).
function resolveZonedTimeToUtcMs(year, month, day, hour, minute, zone) {
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = utcOffsetMinutes(new Date(guessUtc), zone);
  const candidate1 = guessUtc - offset1 * 60000;
  const offset2 = utcOffsetMinutes(new Date(candidate1), zone);
  return guessUtc - offset2 * 60000;
}

// How far ahead to search before giving up and reporting "no upcoming run
// found" (null) rather than an unbounded/slow search. With node-cron's AND
// day rule a schedule restricting both day fields can fire years apart
// ("0 4 29 2 1": a Feb 29 that is a Monday, 2016 -> 2044), and the weekday
// of a given date repeats on a 28-year cycle (within 1901-2099), so 28 years
// finds every run node-cron would. The outer loop is plain calendar
// arithmetic -- no Intl call -- so the full window stays cheap.
const MAX_LOOKAHEAD_DAYS = 366 * 28;
// Safety bound on the inner (same-day) minute walk, matching a full day.
const MINUTES_PER_DAY = 24 * 60;

/**
 * Compute the next UTC instant (ISO string) a 5-field cron expression fires
 * at in `timezone`, strictly after `fromDate`. Returns null for an
 * unsupported expression shape or if no match is found within the lookahead
 * window (a malformed or practically-impossible combination, e.g. Feb 30).
 *
 * Day rule: node-cron 4's, the engine that actually fires every job -- the
 * month, day-of-month AND day-of-week must all match (TimeMatcher.match in
 * node_modules/node-cron/dist/_shared.js). NOT classic cron's rule, where two
 * restricted day fields match if EITHER does: this used to apply that one,
 * so "0 4 1 * 1" previewed as the next 1st of the month while node-cron ran
 * it only on a 1st that is a Monday -- months later.
 *
 * Two-level search, not a flat minute-by-minute walk over the whole window:
 * an outer loop advances by a full day (cheap — no Intl call at all, since
 * day-of-month/month/day-of-week are plain calendar checks once per
 * candidate day) until it finds a day that matches, then an inner loop walks
 * that ONE day minute-by-minute for the first hour:minute match. Intl calls
 * happen only for fire times on matching days, not per day of the window,
 * the difference between computing this for a page full of tasks
 * comfortably within one request and not.
 */
export function computeNextRun(cronExpression, timezone, fromDate = new Date()) {
  if (hasUnsupportedCronFieldCount(cronExpression)) return null;
  const [minuteField, hourField, domField, monthField, dowField] = cronExpression
    .trim()
    .split(/\s+/);

  const minutes = expandCronField(minuteField, 59);
  const hours = expandCronField(hourField, 23);
  const doms = expandCronFieldRanged(domField, 1, 31);
  const months = expandCronFieldRanged(monthField, 1, 12);
  const dows = expandCronFieldRanged(dowField, 0, 6);
  if (!minutes || !hours || !doms || !months || !dows) return null;

  let fromMs;
  try {
    fromMs = fromDate.getTime();
  } catch {
    return null;
  }
  if (!Number.isFinite(fromMs)) return null;

  // Start searching from the next whole minute after `fromDate` -- never
  // returns a moment at or before "now".
  const startParts = zonedDateParts(new Date(fromMs), timezone);
  let candidateYear = startParts.year;
  let candidateMonth = startParts.month;
  let candidateDay = startParts.day;

  for (let dayOffset = 0; dayOffset <= MAX_LOOKAHEAD_DAYS; dayOffset++) {
    if (dayOffset > 0) {
      // Advance the LOCAL calendar date by one day using plain Gregorian
      // arithmetic via Date.UTC (a pure calendar operation, no timezone
      // involved -- "the day after 2026-02-28" is the same answer in every
      // zone), then re-derive year/month/day from it. Deliberately not
      // adding 86400000ms to a resolved UTC instant: near a DST transition
      // that can land on the same local day twice or skip a hour, which
      // would corrupt the calendar walk itself, not just one candidate time.
      const advanced = new Date(Date.UTC(candidateYear, candidateMonth - 1, candidateDay + 1));
      candidateYear = advanced.getUTCFullYear();
      candidateMonth = advanced.getUTCMonth() + 1;
      candidateDay = advanced.getUTCDate();
    }

    // node-cron's day rule (see the doc comment above): every day field
    // must match, a "*" field matching every day. The weekday of a LOCAL
    // calendar date is plain Gregorian arithmetic, no zone lookup -- the
    // same computation node-cron's own MatcherWalker.matchesWeekday uses.
    if (!months.has(candidateMonth) || !doms.has(candidateDay)) continue;
    const weekday = new Date(Date.UTC(candidateYear, candidateMonth - 1, candidateDay)).getUTCDay();
    if (!dows.has(weekday)) continue;

    // This calendar day matches -- walk its minutes for the first hour+
    // minute match at/after the real "start searching from" point (only
    // relevant on dayOffset === 0; every later day starts its search at
    // that day's own local midnight). Each candidate resolves its own
    // zoned time independently (not offset from a single day-start instant)
    // so a DST transition partway through this day can't skew every
    // subsequent minute in it.
    for (let minuteOfDay = 0; minuteOfDay < MINUTES_PER_DAY; minuteOfDay++) {
      const hour = Math.floor(minuteOfDay / 60);
      const minute = minuteOfDay % 60;
      if (!hours.has(hour) || !minutes.has(minute)) continue;
      const candidateUtcMs = resolveZonedTimeToUtcMs(
        candidateYear, candidateMonth, candidateDay, hour, minute, timezone,
      );
      if (candidateUtcMs <= fromMs) continue;
      // Guard against the same DST-gap estimation caveat noted on
      // resolveZonedTimeToUtcMs: only accept a candidate whose own zoned
      // parts read back correctly, so a skipped-by-spring-forward wall time
      // is never reported as a real "next run" moment.
      const readBack = zonedDateParts(new Date(candidateUtcMs), timezone);
      if (
        readBack.year !== candidateYear ||
        readBack.month !== candidateMonth ||
        readBack.day !== candidateDay ||
        readBack.hour !== hour ||
        readBack.minute !== minute
      ) {
        continue;
      }
      return new Date(candidateUtcMs).toISOString();
    }
  }

  return null;
}

// The next time node-cron itself would fire `expression` in `timezone`
// (ISO string), or null when it can't say. For a live preview of a schedule
// about to be armed: it is the same TimeMatcher the armed job's own
// getNextRun() walks, so the two cannot disagree -- whatever syntax node-cron
// accepts (names, L, 1#1, 7 for Sunday) and whatever its day rule is.
// A stopped, never-started task (createTask, no start()): nothing is
// scheduled, and getNextRuns() is node-cron's public way to ask a task that
// isn't running (getNextRun() answers only for a started one). destroy()
// takes it back out of node-cron's task registry -- which it can only do
// for a zone Intl accepts (it formats the time for its task:destroyed
// event), so an unusable zone is refused before any task exists.
export function nodeCronNextRun(expression, timezone) {
  if (timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      return null;
    }
  }
  let task = null;
  try {
    task = cron.createTask(expression, () => {}, { timezone });
    const [next] = task.getNextRuns(1);
    return next instanceof Date && Number.isFinite(next.getTime()) ? next.toISOString() : null;
  } catch {
    // Invalid expression or zone, or no run within node-cron's own search
    // window.
    return null;
  } finally {
    try {
      task?.destroy();
    } catch {
      // Nothing was started; nothing left to clean up.
    }
  }
}

// Whether `expression` restricts BOTH the day-of-month and the weekday --
// the case where node-cron's day rule (both must match) differs from classic
// cron's (either may). Read from node-cron's own expansion (cron.parse), so
// "?", "1-31", "*/1" and "0-7" count as unrestricted exactly when they mean
// every day. False for anything node-cron refuses.
export function restrictsBothDayFields(expression) {
  let fields;
  try {
    fields = cron.parse(expression);
  } catch {
    return false;
  }
  const coversAll = (values, min, max) => {
    const set = new Set(values);
    for (let value = min; value <= max; value++) {
      if (!set.has(value)) return false;
    }
    return true;
  };
  return !coversAll(fields.dayOfMonth, 1, 31) && !coversAll(fields.dayOfWeek, 0, 6);
}
