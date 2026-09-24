import cron from "node-cron";

// 2026-08-29, timezone-picker card: whether Intl (and therefore node-cron,
// which resolves its own timezone option through the same Intl machinery --
// see node_modules/node-cron/dist/_shared.js's getPartsFormatter) will
// actually accept `tz` as a real IANA zone name. Construction throwing a
// RangeError is the canonical way to ask this -- it is the exact check that
// determines whether cron.schedule(expr, cb, { timezone: tz }) will work at
// schedule time, so there is no meaningful gap between "this function says
// valid" and "node-cron accepts it." Deliberately NOT built on
// Intl.supportedValuesOf('timeZone') (Node 18+): that list is narrower than
// what the constructor accepts (it omits some valid legacy/alias names
// Intl still resolves correctly), so using it here would reject values a
// real install could have been using safely for years.
//
// 2026-09-05, scheduler-time-audit follow-up: that reasoning is sound for
// legacy alias NAMES that still track a real region's actual DST calendar
// (e.g. a renamed zone Intl still resolves) -- it was never meant to cover a
// BARE NUMERIC OFFSET, which isn't an alias for a place and tracks no DST
// calendar at all. The constructor above happens to accept those too
// (confirmed: `new Intl.DateTimeFormat("en-US", { timeZone: "-05:00" })`
// does not throw), so before this fix a value like "-05:00" would pass this
// check and get handed to cron.schedule() as a fixed, DST-blind offset --
// not the "fires twice/never" shape a real DST-observing zone risks, but a
// quieter one: every schedule on that install would silently and
// permanently drift by an hour from the operator's actual local time across
// every DST transition, forever, with nothing to notice it by. Rejecting
// only the bare-offset syntax below closes that gap without touching the
// alias leniency fd346578 deliberately chose -- every legacy NAME that
// commit was protecting still passes.
const RAW_OFFSET_TIMEZONE_RE = /^(?:UTC|GMT)?[+-]\d{1,2}(?::?\d{2})?$/i;

export function isValidIanaTimezone(tz) {
  if (typeof tz !== "string" || !tz.trim()) return false;
  const trimmed = tz.trim();
  if (RAW_OFFSET_TIMEZONE_RE.test(trimmed)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// True only for a value that isValidIanaTimezone() rejects specifically
// because it's a bare numeric offset -- lets a caller give a more specific,
// actionable log/error message than the generic "not a valid IANA zone" one
// for this one particular, previously-silently-accepted shape.
export function isRawOffsetTimezone(tz) {
  return typeof tz === "string" && RAW_OFFSET_TIMEZONE_RE.test(tz.trim());
}

export function hasUnsupportedCronFieldCount(expression) {
  return (
    typeof expression !== "string" ||
    expression.trim().split(/\s+/).length !== 5
  );
}

export function isSupportedFiveFieldCron(expression) {
  return (
    !hasUnsupportedCronFieldCount(expression) && cron.validate(expression)
  );
}

// round 28 (scheduled-task next-run data): exported so cronNextRun.js can
// reuse the exact same 0-based field expansion this file's own DST checks
// already rely on, instead of a second, independently-typed parser that
// could disagree with THIS file about what a given cron field means.
export function expandCronField(field, max) {
  const values = new Set();

  for (const part of field.split(",")) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!match) return null;

    const start = match[1] === "*" ? 0 : Number(match[1]);
    const end = match[2] === undefined
      ? (match[1] === "*" ? max : start)
      : Number(match[2]);
    const step = match[3] === undefined ? 1 : Number(match[3]);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      !Number.isInteger(step) ||
      start < 0 ||
      end > max ||
      start > end ||
      step < 1
    ) {
      return null;
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  return values.size > 0 ? values : null;
}

// bughunt-2026-08-31-c (server/utils sweep): the wrap-around check used to
// fire only when `hour === "*"` literally -- so "0,58 5,6 * * *" (fires at
// 5:58 and 6:00, 2 minutes apart) sailed through the 5-minute floor this
// function exists to enforce, because the hour field is the discrete list
// "5,6", not the wildcard string this checked for, even though it means
// exactly the same "every listed hour" thing the wrap logic was written to
// catch. Verified live: isCronTooFrequent("0,58 5,6 * * *") returned false
// before this fix. Generalized by expanding BOTH fields into absolute
// minutes-since-midnight and checking every consecutive gap, including the
// day-wrap from the last firing back to the first -- this subsumes the old
// hour==="*" special case rather than sitting alongside it, so there is
// only one place left that can drift out of sync with the actual rule.
export function isCronTooFrequent(expression) {
  if (hasUnsupportedCronFieldCount(expression)) return true;
  const [minute, hour] = expression.trim().split(/\s+/);

  const minutes = expandCronField(minute, 59);
  if (!minutes) return true;
  const hours = expandCronField(hour, 23);
  if (!hours) return true;

  const dayMinutes = new Set();
  for (const h of hours) {
    for (const m of minutes) {
      dayMinutes.add(h * 60 + m);
    }
  }
  const sorted = [...dayMinutes].sort((left, right) => left - right);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] - sorted[index - 1] < 5) return true;
  }
  if (sorted.length >= 2) {
    const wrap = 24 * 60 - sorted[sorted.length - 1] + sorted[0];
    if (wrap < 5) return true;
  }

  return false;
}

// 2026-09-05, scheduler-time-audit: node-cron's own README states its DST
// model verbatim -- "Across a daylight-saving fall-back the repeated hour
// runs once, so a sub-hourly schedule (for example */15) can pause for up
// to the length of the DST shift during that hour." A schedule whose MINUTE
// field fires more than once per hour (independent of which hour(s) it's
// combined with) is exactly that shape; a schedule with a single fixed
// minute value fires once per listed hour and is unaffected (the repeated
// hour "runs once" is a correct fire, not a skip, for that case) --
// confirmed empirically tonight against real node-cron 4.6.0 output, not
// just read from the doc. Reuses expandCronField rather than a second
// parser, so this can never drift out of sync with isCronTooFrequent's own
// understanding of what a cron minute field means.
//
// Returns the approximate interval in minutes (60 / fire-count-per-hour)
// when the schedule is sub-hourly, or null when it isn't (or the field
// can't be parsed). This is an average for an unevenly-spaced custom list
// (e.g. "0,10,45") -- a reasonable warning-message number, not a scheduling
// guarantee.
export function subHourlyIntervalMinutes(expression) {
  if (hasUnsupportedCronFieldCount(expression)) return null;
  const [minute] = expression.trim().split(/\s+/);
  const minutes = expandCronField(minute, 59);
  if (!minutes || minutes.size < 2) return null;
  return Math.round(60 / minutes.size);
}

// Whether `zone` observes DST at all -- compares the UTC offset for the
// same IANA zone in January and July of a fixed reference year. A zone with
// no DST (UTC, most of Asia, Arizona, ...) reports the identical offset
// both times; a DST-observing zone does not. Deliberately not based on
// "does the zone name contain a region known to have DST" (fragile,
// incomplete) -- this asks Intl the same way node-cron itself resolves
// offsets, so there is no gap between what this predicts and what node-cron
// will actually do.
export function timezoneObservesDst(zone) {
  try {
    const offsetOf = (date) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        timeZoneName: "shortOffset",
      })
        .formatToParts(date)
        .find((part) => part.type === "timeZoneName")?.value;
    const january = offsetOf(new Date(Date.UTC(2026, 0, 1)));
    const july = offsetOf(new Date(Date.UTC(2026, 6, 1)));
    return Boolean(january && july && january !== july);
  } catch {
    return false;
  }
}

// Composes the two checks above into the one-line warning scheduleTask()
// (and the auto-restart / backup-schedule setup functions) log and, for
// scheduleTask(), return to the caller so an API response can carry it.
// Returns null when the schedule isn't at risk (not sub-hourly, or the
// configured zone doesn't observe DST at all -- e.g. UTC, which is why this
// is worth checking per-install rather than warning unconditionally on
// every sub-hourly schedule).
// Scoped to the 15-60 minute band per the card's own framing: isCronTooFrequent
// already floors every schedule at 5 minutes, so a 5-14 minute schedule fires
// several times an hour -- losing one occurrence among many is far less
// noticeable than losing one of only 1-4. Left the narrower window rather
// than substituting a broader "any sub-hourly" gate on my own judgment;
// flagged in the commit message in case the 5-14 band is wanted too.
export function dstFallBackWarning(expression, timezone, label) {
  const interval = subHourlyIntervalMinutes(expression);
  if (interval === null || interval < 15 || interval > 60) return null;
  if (!timezoneObservesDst(timezone)) return null;
  const name = label ? `"${label}" ` : "";
  return (
    `Schedule ${name}fires roughly every ${interval} minute(s); during ` +
    `${timezone}'s daylight-saving fall-back each year, one occurrence in ` +
    "the repeated hour will be silently skipped -- this is a limitation of " +
    "the underlying scheduler (node-cron), not a bug in the panel."
  );
}

// continuous-bug-hunt round 17 (2026-09-18, scheduler DST sweep): the
// warning above only ever covers FALL-BACK for a sub-hourly (2+ distinct
// minute values) schedule. A schedule with a SINGLE fixed hour:minute --
// the far more common shape for a nightly backup or restart -- was
// previously believed to be entirely DST-safe (the file's own prior
// comment on dstFallBackWarning documents, correctly and empirically
// verified against real node-cron 4.6.0, that such a schedule does NOT
// double-fire on fall-back: node-cron's matcher walks forward using
// STRUCTURAL local hour/minute comparisons, so it can never re-match the
// same hour:minute twice on one calendar day, even when that local time
// genuinely recurs). That reasoning is sound for fall-back, but it says
// nothing about SPRING-FORWARD -- and empirically (verified live against
// node-cron 4.6.0's TimeMatcher, "30 2 * * *" in America/New_York across
// 2026-03-08, the real US spring-forward date that year) a schedule whose
// fixed hour:minute falls inside the skipped local hour is silently
// dropped for that one calendar day: node-cron's own matcher rejects the
// nonexistent local time as not a real match and moves on to the NEXT
// valid day, with no missed-execution event (there was never a valid slot
// to miss) and, until now, no warning from this panel either.
//
// Reimplements node-cron's own guess-then-verify local-time resolution
// (node_modules/node-cron/dist/_shared.js's
// localTimeToTimestamp()/readsBackTo()) using only public Intl APIs rather
// than importing node-cron's private dist path, which is not part of its
// published package exports and could change or disappear on a version
// bump. Scans forward day by day (not hour by hour) for cheapness -- DST
// transitions are at most 2 per year -- and only for schedules with a
// small number of (hour, minute) combinations, so a legitimately sub-hourly
// schedule (already covered by dstFallBackWarning above, and far more
// expensive to scan this way) doesn't turn this into an unbounded scan.
const DST_TRANSITION_SCAN_DAYS = 370; // > 1 full year, so every zone's transition(s) are covered regardless of today's date
const DST_SPRING_FORWARD_MAX_FIRE_COMBINATIONS = 8; // (hour,minute) pairs; keeps the day-by-day scan cheap

// round 28: exported for cronNextRun.js -- same reasoning as
// expandCronField's own export comment above.
export function utcOffsetMinutes(date, zone) {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(value || "");
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] || 0));
}

// round 28: exported for cronNextRun.js -- same reasoning as
// expandCronField's own export comment above.
export function zonedDateParts(date, zone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      if (part.type !== "literal") acc[part.type] = Number(part.value);
      return acc;
    }, {});
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    // Intl renders local midnight as "24", not "00", for this option set.
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
  };
}

// Whether the given LOCAL wall-clock moment genuinely exists in `zone` --
// false for exactly the "spring-forward gap" case (the guess and its
// re-derived candidate both land on a real UTC instant, but neither reads
// back to the target local hour:minute, because that local time was
// skipped entirely). Mirrors node-cron's own guess/verify approach; see
// this file's header comment on dstSpringForwardWarning for why it's
// reimplemented here rather than imported from node-cron's internals.
function wallTimeExists(year, month, day, hour, minute, zone) {
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = utcOffsetMinutes(new Date(guessUtc), zone);
  const candidate1 = guessUtc - offset1 * 60000;
  const offset2 = utcOffsetMinutes(new Date(candidate1), zone);
  const candidate2 = guessUtc - offset2 * 60000;
  const readsBack = (ts) => {
    const parts = zonedDateParts(new Date(ts), zone);
    return (
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === hour &&
      parts.minute === minute
    );
  };
  return readsBack(candidate1) || readsBack(candidate2);
}

export function dstSpringForwardWarning(expression, timezone, label) {
  if (hasUnsupportedCronFieldCount(expression)) return null;
  if (!timezoneObservesDst(timezone)) return null;
  const [minute, hour] = expression.trim().split(/\s+/);
  const minutes = expandCronField(minute, 59);
  const hours = expandCronField(hour, 23);
  if (!minutes || !hours) return null;
  if (minutes.size * hours.size > DST_SPRING_FORWARD_MAX_FIRE_COMBINATIONS) {
    return null;
  }

  const now = new Date();
  for (let dayOffset = 0; dayOffset <= DST_TRANSITION_SCAN_DAYS; dayOffset += 1) {
    const probe = new Date(now.getTime() + dayOffset * 86400000);
    const { year, month, day } = zonedDateParts(probe, timezone);
    for (const h of hours) {
      for (const m of minutes) {
        if (!wallTimeExists(year, month, day, h, m, timezone)) {
          const name = label ? `"${label}" ` : "";
          const pad = (n) => String(n).padStart(2, "0");
          const dateLabel = `${year}-${pad(month)}-${pad(day)}`;
          return (
            `Schedule ${name}is set to fire at ${pad(h)}:${pad(m)}; on ` +
            `${dateLabel}, ${timezone} springs forward and that local time ` +
            "does not occur -- that day's run will be silently skipped. " +
            "This is a limitation of the underlying scheduler (node-cron), " +
            "not a bug in the panel."
          );
        }
      }
    }
  }
  return null;
}
