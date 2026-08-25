# i18n terms — Jim

Non-obvious French term choices for the `client/src/components/**` audit (the
untranslated-shared-components gap Oscar found: pages translated, their
child dialogs/panels not) plus `client/src/hooks/useKeyboardShortcuts.ts`.
Scope was the ~15 small-to-medium files plus the six `templates/*.tsx`
dialogs god approved after the audit — NOT mods/ConflictsPanel,
WorkshopCollectionPanel, SpawnBrowser, ItemPicker, VehiclePicker or
FileDiffViewer, which go to translators by page affinity instead.

## Reused from the existing glossary (do not re-derive)
- "template" → **modèle** (Oscar's note, confirmed again via `shell.json`/`roles.json`).
- "Cancel" → **Annuler**, "Delete" → **Supprimer**, "Preview" → **Aperçu**,
  "Export" → **Exporter**, "Built-in" → **Intégré** (all confirmed exact
  matches already in `servers.json`/`roles.json`/`dashboard.json`/`debug.json`).
- "Save" (verb) → **Enregistrer** (per Oscar's note, reused for
  CreateTemplateDialog's "Save Template").
- Start/Stop/Restart → **Démarrer/Arrêter/Redémarrer** (Oscar's note),
  reused for BridgeStatusBadge's hint text.
- "Connected"/"Unknown" → **Connecté/Inconnu** (`settings.json`,
  `chunkCleaner.json`).
- "LIVE"/"OFFLINE" pattern → **EN DIRECT/HORS LIGNE** (Stanley's note),
  reused the underlying "Hors ligne" for ConnectionStatus/ServerStatusBadge/
  EmptyState's offline/disconnected states.
- "Players" → **Joueurs**, "Host"/"hôte" (Oscar's note).
- "Memory"/"Disk" as standalone metric words → **Mémoire/Disque**
  (`servers.json`'s card section), reused in DashboardPerformanceCharts.
- Nav item wording for `dashboard`/`modManager` → **Tableau de bord** /
  **Gestionnaire de mods** (`shell.json`), reused in FeatureErrorBoundary's
  "back to Dashboard" link and TemplateDiffList's "Mod Manager" reference.
- "PasswordInput" show/hide → **Afficher/Masquer le mot de passe** — exact
  match to `login.json`/`settings.json`/`setup.json`'s own show/hide-password
  strings, which turned out to duplicate this component's behavior with
  their own raw `<Input>` rather than using it. Not fixed (page-owned).

## New terms, not previously in the glossary
- "PanelBridge" stays **untranslated** in BridgeStatusBadge, same product-name
  treatment as RCON/SteamCMD/Docker (Oscar's note) — "Bridge connected" etc.
  became "PanelBridge connecté" rather than translating "Bridge" as a
  generic noun.
- Server-status words (Running/Stopped/Connecting/Not Installed) →
  **En cours/Arrêté/Connexion…/Non installé**. No prior exact precedent for
  these as standalone status-badge words; "En cours" over "En cours
  d'exécution" for badge-width concision.
- Relative-time strings in DashboardVerdict ("updated 5s ago") — did NOT
  reach for i18next `_one`/`_other` plural suffixes here. The English source
  already avoids grammatical pluralization by using bare unit letters (5s,
  not "5 seconds"), so there's no noun to inflect in either language. The
  actual i18n defect was word order — French puts "il y a" before the
  number, English puts "ago" after — fixed with one interpolated template
  per language, not plural forms. Used `_one`/`_other` for "and {{count}}
  more" instead (matches the existing `Backups.tsx` convention), even though
  neither language's phrasing changes shape by count there.
- Templates cluster (TemplateCard, TemplateApplyPanel, CreateTemplateDialog)
  DID need real `_one`/`_other` plural forms — "1 setting overridden" vs
  "3 settings overridden", "1 mod" vs "3 mods", "1 INI key updated" vs
  "3 INI keys updated" — French pluralizes these the same shape as English
  (unlike the relative-time case above), so this is genuine plural-form
  usage: `settingsOverridden_one/_other`, `modsCount_one/_other`,
  `iniKeysUpdated_one/_other`, `sandboxSettingsUpdated_one/_other`,
  `backupFilesCreated_one/_other`.
- KeyboardShortcutsHelp's nav-shortcut labels are deliberately terser than
  `shell.json`'s own sidebar labels for the same pages (e.g. "Server Config"
  here vs "Server Configuration" / "Configuration du serveur" in the
  sidebar) — kept that distinction since this is a compact reference list,
  not the primary nav; translated independently rather than forcing a match.

## Cross-file gaps found but NOT fixed here (flagged, out of my file scope)
- `client/src/pages/Settings.tsx` passes `label="SFTP password"` literally to
  `<PasswordInput>` (line ~3942) — the only caller that doesn't translate the
  custom label, unlike `Servers.tsx`'s four call sites which already pass
  `t('...PasswordAria')`. One-line fix for whoever owns Settings.tsx.
- `FeatureErrorBoundary`'s `featureName` prop is populated with literal
  English strings at every call site in `App.tsx` ("Dashboard", "Player
  Management", "Mod Manager", ...) — the boundary's own copy is now
  translated, but the feature name interpolated into it is not. `App.tsx` is
  outside both `components/` and `pages/`, so left as a scope note rather
  than an edit.
- `client/src/hooks/useKeyboardShortcuts.ts` was unowned and held the actual
  data KeyboardShortcutsHelp renders — translated it in the same batch as
  the dialog (god confirmed this explicitly) rather than leaving a
  cosmetic-only fix, same shape as the templates/hook gap Oscar found.

## Method note
Ran `npx vitest run src/locales/__tests__/localeParity.test.ts` after every
batch — confirmed my own namespaces green each time. Twice saw a transient
failure on a namespace I never touched (`scheduler.json`, `debug.json`) from
another translator's in-progress uncommitted edit on the same shared tree;
re-ran and it cleared once they landed. Not a real defect, just a live-tree
race — mentioning it here in case the pattern recurs for someone else.
