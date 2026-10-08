/**
 * 2026-10-08 date format preference (Discord, MrBrain: "Can we have an option
 * for backups to show the date as day/month/year"): every page used to format
 * its own dates with the UI language alone, and 'en' carries no region, so an
 * English UI always printed the US month/day/year. client/src/lib/dateFormat.ts
 * now owns the formatting -- the saved order (Settings > General >
 * Appearance), and Automatic's browser region -- and every date-bearing site
 * was moved onto it so one date never shows two ways. This rule keeps a new
 * site from formatting on its own again.
 *
 * It flags:
 *   1. any `.toLocaleDateString(...)` / `.toLocaleTimeString(...)` call (only
 *      Date has them);
 *   2. `new Intl.DateTimeFormat(...)` / `Intl.DateTimeFormat(...)`, except a
 *      call whose only use is `.resolvedOptions()` (reading the browser's
 *      zone or locale formats nothing);
 *   3. `.toLocaleString(...)` on a `new Date(...)`, or with an options object
 *      that names a date or time field (dateStyle, month, hour, timeZone...).
 *
 * Not caught: a Date held in a variable and formatted with
 * `x.toLocaleString(lang)` and no options -- numbers use that exact shape
 * (counts, sizes), and the rule can't tell them apart without types.
 *
 * lib/dateFormat.ts itself and the tests (which build expected strings with
 * raw Intl on purpose) are exempted in client/eslint.config.js.
 */

const DATE_ONLY_METHODS = new Set(["toLocaleDateString", "toLocaleTimeString"]);

const DATE_OPTION_KEYS = new Set([
  "dateStyle",
  "timeStyle",
  "weekday",
  "era",
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
  "fractionalSecondDigits",
  "dayPeriod",
  "hour12",
  "hourCycle",
  "timeZone",
  "timeZoneName",
]);

function propertyName(member) {
  if (member.type !== "MemberExpression") return null;
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  if (member.computed && member.property.type === "Literal") return String(member.property.value);
  return null;
}

function isIntlDateTimeFormat(callee) {
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "Intl" &&
    propertyName(callee) === "DateTimeFormat"
  );
}

function isNewDate(node) {
  return node.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === "Date";
}

function hasDateOptions(args) {
  return args.some(
    (arg) =>
      arg.type === "ObjectExpression" &&
      arg.properties.some(
        (prop) =>
          prop.type === "Property" &&
          !prop.computed &&
          ((prop.key.type === "Identifier" && DATE_OPTION_KEYS.has(prop.key.name)) ||
            (prop.key.type === "Literal" && DATE_OPTION_KEYS.has(String(prop.key.value)))),
      ),
  );
}

function onlyReadsResolvedOptions(node) {
  const parent = node.parent;
  return parent && parent.type === "MemberExpression" && parent.object === node && propertyName(parent) === "resolvedOptions";
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow formatting a date outside client/src/lib/dateFormat.ts",
    },
    schema: [],
    messages: {
      raw:
        "Format dates with formatDate/formatDateTime/formatTime from '@/lib/dateFormat' (or its useDateFormat() hook), not {{what}}: a raw call ignores the date format chosen in Settings and Automatic's browser region, so this date would show differently from every other one in the panel.",
    },
  },

  create(context) {
    function report(node, what) {
      context.report({ node, messageId: "raw", data: { what } });
    }

    function checkIntl(node) {
      if (isIntlDateTimeFormat(node.callee) && !onlyReadsResolvedOptions(node)) report(node, "Intl.DateTimeFormat");
    }

    return {
      NewExpression: checkIntl,
      CallExpression(node) {
        checkIntl(node);
        const method = propertyName(node.callee);
        if (!method) return;
        if (DATE_ONLY_METHODS.has(method)) {
          report(node, `${method}()`);
          return;
        }
        if (method === "toLocaleString" && (isNewDate(node.callee.object) || hasDateOptions(node.arguments))) {
          report(node, "Date#toLocaleString()");
        }
      },
    };
  },
};
