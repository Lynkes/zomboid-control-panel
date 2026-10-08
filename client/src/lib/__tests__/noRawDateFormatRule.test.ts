import { describe } from 'vitest'
import { RuleTester } from 'eslint'
// @ts-expect-error -- plain JS rule module, no type declarations
import rule from '../../../../eslint-rules/no-raw-date-format.js'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

// eslint-rules/no-raw-date-format.js: every date goes through
// client/src/lib/dateFormat.ts, so the format chosen in Settings applies
// everywhere and one date never shows two ways.
describe('local/no-raw-date-format', () => {
  ruleTester.run('no-raw-date-format', rule, {
    valid: [
      // The shared formatter, plain and through the hook.
      'formatDateTime(backup.created)',
      "const { formatDate } = useDateFormat(); formatDate(row.at, { style: 'medium' })",

      // Numbers use toLocaleString too: counts and sizes stay allowed.
      'count.toLocaleString(i18n.language)',
      'items.length.toLocaleString(i18n.language)',
      "total.toLocaleString(i18n.language, { maximumFractionDigits: 1 })",

      // Reading the browser's zone formats nothing.
      'const zone = Intl.DateTimeFormat().resolvedOptions().timeZone',
      'const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone',
      'Intl.DateTimeFormat.supportedLocalesOf(["en"])',

      // Other Intl formatters.
      'new Intl.NumberFormat(language).format(n)',
      'new Intl.RelativeTimeFormat(language).format(-1, "day")',

      // Machine-readable stamps and file names.
      'const name = `logs-${new Date().toISOString().split("T")[0]}.txt`',
    ],
    invalid: [
      {
        // Backups.tsx before the change: always the US order for 'en'.
        code: "date.toLocaleDateString(i18n.language) + ' ' + date.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })",
        errors: [{ messageId: 'raw' }, { messageId: 'raw' }],
      },
      {
        code: 'const el = <span>{new Date(entry.executed_at).toLocaleString(i18n.language)}</span>',
        errors: [{ messageId: 'raw' }],
      },
      {
        // A Date in a variable is caught by its options.
        code: "started.toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })",
        errors: [{ messageId: 'raw' }],
      },
      {
        code: "new Date(iso).toLocaleString(i18n.language, { timeZone, timeZoneName: 'short' })",
        errors: [{ messageId: 'raw' }],
      },
      {
        code: "new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(value))",
        errors: [{ messageId: 'raw' }],
      },
      {
        code: 'Intl.DateTimeFormat(language).format(date)',
        errors: [{ messageId: 'raw' }],
      },
      {
        code: 'msg.timestamp?.toLocaleTimeString()',
        errors: [{ messageId: 'raw' }],
      },
    ],
  })
})
