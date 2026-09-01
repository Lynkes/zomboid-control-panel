import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import noRawErrorMessage from '../eslint-rules/no-raw-error-message.js'
import noDuplicateInterfaceName from '../eslint-rules/no-duplicate-interface-name.js'
import noDeadDisabledTitle from '../eslint-rules/no-dead-disabled-title.js'
import noUnguardedCapabilityMenuItem from '../eslint-rules/no-unguarded-capability-menu-item.js'

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules'],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      local: {
        rules: {
          'no-raw-error-message': noRawErrorMessage,
          'no-duplicate-interface-name': noDuplicateInterfaceName,
          'no-dead-disabled-title': noDeadDisabledTitle,
          'no-unguarded-capability-menu-item': noUnguardedCapabilityMenuItem,
        },
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-case-declarations': 'off',
      'no-extra-boolean-cast': 'off',
      'no-useless-escape': 'off',

      // 2026-08-26 errorMessage.ts coverage audit's structural half: forbids
      // a NEW `x instanceof Error ? x.message : fallback` toast/error-state
      // site anywhere. See eslint-rules/no-raw-error-message.js for what it
      // does and does not catch, and errorMessage.ts's own comment above
      // rawErrorMessageIntentional() for the (rare) escape hatch.
      'local/no-raw-error-message': 'error',

      // 2026-08-27 api.ts type-architecture survey: api.ts had `BackupFile`
      // declared twice for two genuinely different real shapes (config-file
      // backups vs full server backups), and tsc's declaration merging
      // silently unioned them into a type requiring fields neither producer
      // returns. See eslint-rules/no-duplicate-interface-name.js.
      'local/no-duplicate-interface-name': 'error',

      // 2026-08-27 disabled-reason sweep (Dashboard/Players/Events): a
      // `title` on an element that can be `disabled` is invisible while
      // disabled (Chromium shows no native tooltip there, confirmed
      // empirically) -- see eslint-rules/no-dead-disabled-title.js. `warn`,
      // not `error`: the tree had dozens of hits the night this landed,
      // split across a confirmed-defect shape and an ambiguous shape the
      // rule honestly can't resolve without a human reading the copy. An
      // `error` here would force either fixing all of them immediately or
      // maintaining a per-file exemption list -- the exact grandfather-list
      // liability already removed elsewhere in this file tonight.
      'local/no-dead-disabled-title': 'warn',

      // 2026-08-27 Players.tsx Radix-onClick sweep: Radix runs a
      // DropdownMenuItem/ContextMenuItem/MenubarItem/SelectItem/CommandItem's
      // onClick unconditionally, regardless of `disabled` -- these render a
      // <div>, not a native <button>, so `disabled` is CSS/unfocusability,
      // not a code-level gate. See eslint-rules/no-unguarded-capability-menu-item.js.
      // `warn`, not `error`, until the full-client count from this rule's
      // first run is triaged across every page it touches -- same reasoning
      // as no-dead-disabled-title above: this file only owns Players.tsx,
      // and forcing every other page's owner to fix on this commit isn't
      // this rule's call to make.
      'local/no-unguarded-capability-menu-item': 'warn',
    },
  },
)
