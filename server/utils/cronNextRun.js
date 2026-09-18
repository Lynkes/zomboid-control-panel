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
import {
  hasUnsupportedCronFieldCount,
  expandCronField,
  zonedDateParts,
  utcOffsetMinutes,
} from "./cronValidation.js";

// Cron's own day-of-month/month fields are 1-based (unlike minute/hour,
// which are 0-based and already correctly handled by expandCronField's
// existing 0..max range) -- "*" must expand to 1..max, not 0..max, or a
// bare "*" day-of-month field would wrongly treat day 0 as a valid match
// and every other real value would still work by coincidence (0 never
// actually appears in a zoned day-of-month), silently masking the bug
// rather than ever surfacing it. A dedicated min-aware variant, not a
// change to expandCronField itself -- that function's 0-based contract is
// correct and load-bearing for its OWN callers (minute/hour fields).
function expandCronFieldRanged(field, min, max) {
  const values = new Set();
  for (const part of field.split(",")) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const start = match[1] === "*" ? min : Number(match[1]);
    const end =
      match[2] === undefined ? (match[1] === "*" ? max : start) : Number(match[2]);
    const step = match[3] === undefined ? 1 : Number(match[3]);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      !Number.isInteger(step) ||
      start < min ||
      end > max ||
      start > end ||
      step < 1
    ) {
      return null;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size > 0 ? values : null;
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

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedWeekday(ms, zone) {
  const short = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(
    new Date(ms),
  );
  return WEEKDAY_INDEX[short] ?? null;
}

// How far ahead to search before giving up and reporting "no upcoming run
// found" (null) rather than an unbounded/slow search. 400 days comfortably
// covers every real pattern this scheduler supports (isCronTooFrequent already
// floors the minimum interval at 5 minutes; nothing here fires less than
// once a year in practice) while keeping the day-level outer loop's total
// iteration count small and predictable.
const MAX_LOOKAHEAD_DAYS = 400;
// Safety bound on the inner (same-day) minute walk, matching a full day.
const MINUTES_PER_DAY = 24 * 60;

/**
 * Compute the next UTC instant (ISO string) a 5-field cron expression fires
 * at in `timezone`, strictly after `fromDate`. Returns null for an
 * unsupported expression shape or if no match is found within the lookahead
 * window (a malformed or practically-impossible combination, e.g. Feb 30).
 *
 * Two-level search, not a flat minute-by-minute walk over the whole window:
 * an outer loop advances by a full day (cheap — no Intl call needed to
 * decide whether to keep skipping, since day-of-month/month/day-of-week are
 * checked once per candidate day) until it finds a day that matches month +
 * (day-of-month OR day-of-week, cron's own combining rule when both fields
 * are restricted), then an inner loop walks that ONE day minute-by-minute
 * for the first hour:minute match. Bounds total Intl.DateTimeFormat calls to
 * roughly MAX_LOOKAHEAD_DAYS + 1440 in the worst case instead of
 * MAX_LOOKAHEAD_DAYS * 1440, the difference between computing this for a
 * page full of tasks comfortably within one request and not.
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

  const domIsWildcard = domField.trim() === "*";
  const dowIsWildcard = dowField.trim() === "*";

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

    if (!months.has(candidateMonth)) continue;

    // Cron's own day-of-month/day-of-week combining rule: when BOTH fields
    // are restricted (neither is "*"), a day qualifies if EITHER matches
    // (OR, not AND) -- when only one is restricted, that one alone decides.
    // Weekday is resolved lazily (noon local, to stay clear of any midnight
    // DST edge) only when day-of-week actually participates in the
    // decision, since it's the one check in this loop that costs an Intl
    // call.
    let dayMatches;
    if (domIsWildcard && dowIsWildcard) {
      dayMatches = true;
    } else if (dowIsWildcard) {
      dayMatches = doms.has(candidateDay);
    } else {
      const noonUtcForWeekday = resolveZonedTimeToUtcMs(
        candidateYear, candidateMonth, candidateDay, 12, 0, timezone,
      );
      const weekday = zonedWeekday(noonUtcForWeekday, timezone);
      const dowMatches = weekday !== null && dows.has(weekday);
      dayMatches = domIsWildcard ? dowMatches : doms.has(candidateDay) || dowMatches;
    }
    if (!dayMatches) continue;

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
