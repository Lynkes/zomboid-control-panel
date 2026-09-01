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
export function isValidIanaTimezone(tz) {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
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

function expandCronField(field, max) {
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