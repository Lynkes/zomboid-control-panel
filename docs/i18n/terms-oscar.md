# i18n terms — Oscar

Non-obvious French term choices for the server-configuration cluster
(Mods.tsx, ServerConfig.tsx, Servers.tsx, Templates.tsx). Reconciled by god
against terms-<other translators>.md at the end.

## Reused from the existing glossary (do not re-derive)
- "template" → **modèle** (confirmed via `shell.json` nav item "Modèles" and
  `roles.json` "modèles de configuration" — do not use "gabarit" or "patron").
- "Save" (verb, button) → **Enregistrer** (per `players.json` saveButton).
- "current config" → **configuration actuelle**.
- Destructive confirm phrasing "This can't be undone." → **Cette action est
  irréversible.** (matches the tone of existing destructive-confirm strings).

## Servers.tsx
- "server instance" / "managed server" → **serveur** (no separate word for
  "instance" — French UI text just says "serveur", matches shell.json nav
  "Serveurs").
- "Start"/"Stop"/"Restart" (server lifecycle verbs) → **Démarrer** /
  **Arrêter** / **Redémarrer** (confirmed from dashboard.json — do not
  invent "Lancer" or "Stopper").
- "RCON host/port/password" → kept RCON untranslated (it's a PZ/Steam
  protocol acronym operators already know); "host" → **hôte**, standard.
- "SteamCMD", "Docker", "branch" (Steam beta channel) → SteamCMD and Docker
  stay as product names; "branch" → **branche**.
- "install path" / "data path" → **chemin d'installation** / **chemin des
  données** (Chemin is the established word for "Path" across the app).
- Distinctness check: ran an automated pass diffing which English source
  strings collapse to the same French value across servers.json. Every
  collision traced back to the *same* English source string reused in two
  legitimate places (e.g. "Cancel" used in 5 dialogs, "RCON Port" used in
  both the tandem-conflict label and the edit dialog) -- none were two
  *different* English concepts flattened into one French phrase, which is
  the failure mode Angela flagged. Recommend the other translators run the
  same kind of check on their namespaces before final reconciliation.
- Scope note: server status labels ("Host", "Process", "RCON",
  "Not configured", "Authentication failed", "Unavailable") are literal
  strings *constructed in Servers.tsx* and passed as props into
  `<ServerStatusBadge>` (client/src/components/ServerStatusBadge.tsx, not
  mine). Translated them since I own the call site; did not touch the
  component itself.

## ServerConfig.tsx
(Converted by a forked sub-agent under my direction, reviewed and verified
by me before commit: independent key-parity check, i18n-check.mjs run,
both gates re-run clean, `t`-shadowing fix spot-checked, French read as
prose. Term choices below as reported by the fork.)
- Reused rather than invented: "template" → **modèle** (servers.json/
  roles.json); "Backup" → **Sauvegarde**, "Restore" → **Restaurer**,
  "Refresh" → **Actualiser** (settings.json); "Reset" → **Réinitialiser**
  (dashboard.json/login.json).
- "discard" (changes, distinct from Cancel) → **ignorer** — no prior
  precedent existed anywhere in the glossary for this concept; chose it
  specifically to avoid colliding with "Annuler" (Cancel), already
  established elsewhere and meaning something different (closing a dialog
  vs. throwing away edits).
- Lowercase command-style micro-buttons ("save", "discard", "expand all",
  "refresh"/"load") are a deliberate terse-console register in the English
  source on this page — kept that register in French ("enregistrer",
  "ignorer", "tout développer", "actualiser"/"charger") rather than
  capitalizing to normal French UI case, to preserve the visual/tonal
  distinction from the page's other, normally-cased buttons.
- Mod-settings "modified count" badge → **"{{count}} modif."**, not
  "{{count}} mod." — this whole tab already says "mod" to mean "game
  modification" constantly; an abbreviated "mod." for "modifié" would read
  as a mod-count to a French speaker. "modif." is unambiguous.
- Two *distinct* toggle-label registers, kept deliberately separate rather
  than collapsed to one key: **ACTIVÉ/DÉSACTIVÉ** (all-caps, matches PZ's
  own in-game convention) for the mod-settings sandbox switches, vs.
  sentence-case **Activé/Désactivé** for the plain INI/Sandbox setting-row
  toggles — the two appear in visually distinct contexts and use PZ's own
  in-game casing convention only where the option is itself a PZ/mod
  sandbox value.
- SCOPE BOUNDARY (important, affects how "done" this page really is): the
  hundreds of individual INI/Sandbox *setting names and descriptions*
  (`setting.label`/`setting.description` in `IniSettingRow`/
  `SandboxSettingRow`) are sourced from `client/src/lib/serverConfigSchema.ts`
  (`INI_SCHEMA`/`SANDBOX_SCHEMA`), NOT from ServerConfig.tsx itself. That
  file is out of my exclusive-ownership scope and was not touched. Result:
  all page chrome (tabs, dialogs, toasts, search/filter, backups,
  templates, mod-settings furniture, row furniture) is bilingual, but the
  actual PZ setting names/descriptions throughout the INI and Sandbox tabs
  stay English-only.
  RULING FROM GOD (2026-08-22, do not re-litigate): this is a deliberate
  SPLIT, not all-or-nothing, and it is a separate task assigned to someone
  else, not me.
    - `setting.label` (the setting NAME, e.g. "PVP", "PauseEmpty") stays in
      English PERMANENTLY AND DELIBERATELY, on both languages. These
      mirror Project Zomboid's own INI/sandbox keys; an operator comparing
      the panel against their servertest.ini file, or following any guide
      on the internet, needs the exact same word in both places.
      Translating the setting name would actively harm the person we are
      translating for.
    - `setting.description` (the explanatory prose under each setting)
      SHOULD be translated -- that's exactly the "what does this setting
      actually do" text a non-technical French operator needs in their own
      language, and is the whole point of the exercise. This is a
      sizeable, separate task god will staff, not part of tonight's four
      pages.
- Two real bugs found and fixed (not translation issues — code bugs the
  translation pass surfaced): (1) a `.map((t) => (...))` inside the tab
  strip's `TabsList` render used `t` as its lambda parameter, silently
  shadowing the `useTranslation` `t` for every `t(...)` call inside that
  JSX block — renamed to `tabDef`. Same latent-shadow pattern fixed in
  `handleDeleteTemplate`'s `.filter(t => ...)`, renamed to `tpl`. (2) None
  found beyond that on this page — no comment/code mismatch like the
  Mods.tsx:911 one.
- The `.map((t) => ...)` shadowing bug turned out to be a class, not a
  one-off: god swept all 42 translated files for it after seeing this
  report. Both of mine were confirmed fixed. Five more live candidates
  found, all in Phyllis's in-flight Debug.tsx/WorldMap.tsx. Two
  already-committed instances (Players.tsx:186, and ServerConfig.tsx:1083
  itself) were read personally by god and confirmed SAFE -- a local `t` in
  a scope that never calls the translator `t()`, just confusingly named,
  not actually broken. CreateTemplateDialog.tsx:59 is a live one for
  whoever converts that component later (Jim notified).
- i18n-check.mjs flagged 2 remaining "duplicate" French pairs after fixing
  2 real ones (see verification note above): an aria-label paired with its
  own button's visible tooltip, deliberately worded identically so a
  screen-reader user and a sighted user get the same message (e.g.
  "Télécharger la sauvegarde des points de spawn" for both
  `downloadSpawnPointsAria` and `downloadSpawnPointsTooltip`) — checked
  against the English source, which is itself duplicated the same way by
  design. Not a bug.

## Mods.tsx
(Converted by a forked sub-agent under my direction, reviewed and verified
by me before commit: independent key-parity check [627/627], i18n-check.mjs
run [clean, 4 flagged pairs all benign], both gates re-run clean [server
gate's only failure across two runs was the known pre-existing
supervisor-restart flake, unrelated], tsc clean for Mods.tsx, the line-911
comment-bug fix cross-checked by me directly against
server/routes/mods.js:4570-4610, and the page read as prose. Term choices
below as reported by the fork.)

- **THE COMMENT BUG (line ~911, `handleApplyPreset`)**: the original
  comment on the `fetchData()` resync call read `// Always resync state —
  preset may have partially applied`, implying `POST /presets/:id/apply`
  can fail halfway through. Verified against the actual route
  (`server/routes/mods.js:4570-4610`): it merges both the `WorkshopItems=`
  and `Mods=` INI lines into one in-memory string and calls
  `fs.writeFileSync` exactly once — genuinely all-or-nothing, so "may have
  partially applied" was never possible for this endpoint. Comment fixed
  to explain the real reason for the resync (reflect confirmed
  server-side state, not a local guess) instead of a failure mode that
  doesn't exist. Code (the resync call itself) was correct and unchanged
  — only the comment's reasoning was wrong.
- "mod" → **mod** (untranslated, reused from roles.json: "les mods du
  Workshop" — never "modification" or "extension").
- "Workshop" (Steam Workshop) → **Workshop**, untranslated proper noun.
- "workshop ID" → **ID Workshop**; "mod ID" (PZ's own per-mod identifier,
  distinct from workshop ID — one Workshop item can expose several mod
  IDs) → **ID de mod**. Kept this distinction sharp since the whole page's
  mental model depends on workshop-ID vs. mod-ID being two different
  things.
- "Enable"/"Disable" → **Activer**/**Désactiver** (reused from
  players.json).
- "duplicate" → **doublon** (noun, e.g. a badge) vs. **en double**
  (adjectival, e.g. "{{count}} ID en double") — used contextually, not
  interchangeably.
- Destructive confirm "This cannot be undone" → **Cette action est
  irréversible** (same precedent as Servers.tsx/Templates.tsx).
- Real French-grammar bug caught and fixed during the pass (not from the
  automated checker): `genericNameNotice` originally shared one
  `{{plural}}` interpolation token between a noun ("mod{{plural}}") and a
  verb ("affiche{{plural}}") — French verb agreement doesn't take a bare
  "s" the way the noun does ("affiches" is wrong, "affichent" is
  correct). Rewritten as proper i18next `_one`/`_other` plural keys in
  both languages instead of one shared token.
- SCOPE GAP (bigger than the Templates.tsx one, worth a deliberate
  decision): three substantial rendering surfaces reached from Mods.tsx
  are page-adjacent components, not the page file itself, so they're
  untouched and still English-only even though Mods.tsx is now bilingual:
  `client/src/components/mods/ConflictsPanel.tsx` (1675 lines — the
  entire Conflicts tab body), `client/src/components/mods/ModRow.tsx`
  (158 lines — the shared row primitive every mod list uses), and
  `client/src/components/WorkshopCollectionPanel.tsx` (1074 lines — the
  entire Collection tab body). Together ~2900 lines. Two of Mods.tsx's
  nine nav destinations (Conflicts, Collection) are effectively still
  fully English for a French operator. Per god's heads-up earlier
  tonight, these are expected to come to me as a follow-up task rather
  than to Jim, since I already hold the mod/workshop-ID vocabulary.

## Templates.tsx
- Page title "Simulation Templates" → **Modèles de simulation**.
- Scope note: TemplateCard, TemplatePreviewDialog, CreateTemplateDialog,
  ImportTemplateDialog, TemplateApplyPanel, TemplateDiffList
  (client/src/components/templates/*.tsx) are NOT page files and are out of
  my exclusive-ownership scope per the task brief. They hold their own
  hardcoded English strings (dialog titles, form labels, diff view). The
  Templates page itself is now fully bilingual, but a French operator will
  still see English inside those dialogs. Flagged to god — not fixed here,
  scope was explicit.
