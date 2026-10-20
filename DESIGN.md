# DESIGN.md

How the panel's UI is built. The look (dark, olive and amber, an operator tool) comes from V1 and
stays; what this file pins is **one way of doing each thing**: one name per page, one header, one
sub-navigation, one save affordance. The shared parts live in `client/src/components/ui/` and
`client/src/components/`; the route facts live in `client/src/lib/navigation.ts`. A page that
needs something the kit doesn't do extends the kit rather than growing a local copy.

## Routes, names and the sidebar

`lib/navigation.ts` is the one route registry. Each `RouteMeta` holds the path, the sidebar
section (`server` · `players` · `world` · `panel`, or `home` for the Dashboard), the short sidebar
label (`labelKey`, `shell:nav.*`), the full title (`titleKey`, the page header's own key), the
icon, the gates (`capability`, `requiresServer`, `requiresLocal`, `allowRemoteConfigMirror`), the
digit shortcut, the container width (`layout`: `default` max-w-7xl, `wide` full width, `narrow`
max-w-3xl), the loading skeleton (`loader`), the palette's deep links and the lazy page module.
The sidebar, App's routes and loading skeleton, route preloading, the keyboard shortcuts, the
command palette, `PageHeader` and `document.title` all read it. Add a page there, never in one of
those consumers.

- **One concept, one word.** A page's title equals its sidebar label, or the label plus its
  section noun ("Configuration" → "Server Configuration", "Backups" → "World Backups"). Copy that
  sends the operator somewhere names the screen by that title.
- **Sections:** SERVER is exactly "the server chosen in the strip above"; PLAYERS before WORLD
  (moderation is the most frequent crisis task); PANEL holds what spans servers or concerns the
  panel. Section accents: server = primary, players = success, world = warning, panel = muted.
- **Gates** come from `routeAvailability()`: a missing capability hides the row (`can()` fails
  open while capabilities load); needing a server, or a local one, disables it and says why.
  The sidebar and the palette use the same function.
- **Command palette** (`Ctrl/⌘+K`, or the "Search…" button under the active-server strip): pages,
  page sections (`deepLinks`, shown once something is typed) and "Switch to <server>".
- **Keyboard:** digits 1–9 open the registry's `shortcut` pages, `?` lists shortcuts, `/` focuses
  a page's search (`Toolbar` `slashToFocus`), `Ctrl/⌘+S` saves (`SaveBar`).

## Page header

Every routed page opens with `<PageHeader>` (`components/PageHeader.tsx`), in every state
(loading, error, denied, empty): render it outside the state switch.

- `title` (the registry title), `description` (one sentence, about 90 characters, saying what can
  be done here), `icon` (defaults to the registry icon; drawn at h-5).
- `status`: live state next to the title (`StatusPill`, `BridgeStatusBadge`, "Updated 11:47").
  Never put live state in `actions`. `badge` is a deprecated alias.
- `meta`: one row of facts under the description (active server, path, counts).
- `breadcrumb`: `{ label, to? }[]` for child flows ("Settings ›", "Servers ›").
- `section`: the accent wash (`data-tone`); defaults to the route's registry section.
- `actions`, left to right: an optional icon-only ghost Refresh (with `aria-label`), at most one
  `outline` secondary, a "More" (`MoreHorizontal`) menu for everything else (destructive items
  last, after a separator), and at most one `variant="command"` primary, last. Always
  `size="sm"`. Below `sm`, secondaries show only their icon and keep their `aria-label`.
- **No eyebrow.** A heading carries its own weight; `eyebrow`, `tone` and `displayFont` are
  deprecated and ignored (tone still maps to a section outside a known route).

The Dashboard uses `ServerHeader` instead: the h1 is the active server's name at page-title size,
in sans, with a `StatusPill`, a `meta` row, an outline `secondary`, the "More" menu and the
contextual `primary` (Start when stopped, Restart when running). Loading uses
`RoutePageSkeleton`, which mirrors the header with the registry's translated title.

## Alerts and saving

- **`PageAlerts`** comes right after the header and takes every page-level message:
  `{ id, tone: 'error'|'warning'|'info', title, description?, action?: { label, onClick?|to? },
  onDismiss? }[]`. Errors sort first; two show, the rest wait behind "Show N more". An alert names
  its fix: "Bridge offline" links to `/settings?tab=bridge`, "RCON not configured" to `/servers`.
- **`SaveBar`** is the one save affordance of a form: `{ dirty, saving, onSave, onDiscard?,
  changeCount?, disabledReason?, saveLabel? }`. It sticks to the bottom while there are unsaved
  edits ("Unsaved changes · Discard · Save"), saves on `Ctrl/⌘+S`, explains a disabled Save, and
  registers the unsaved-changes guard itself. Render it as the page's last child; remove the
  page's own header/section Save buttons and its own Ctrl+S handler; pass `saveLabel` with the
  page's existing Save key so tests keep their accessible name.
- **Unsaved-changes guard** (`contexts/UnsavedChangesContext.tsx`): `useUnsavedChangesGuard(dirty,
  { message? })` makes every in-app link, the palette, the digit shortcuts and
  `useGuardedNavigate()` ask before leaving the page, and adds the browser's beforeunload prompt.
  Changing `?tab=` on the same page doesn't ask. Use `useGuardedNavigate()` instead of
  `useNavigate()` for buttons that leave the page.

## Headings

- Page title: set by `PageHeader` itself (`text-xl sm:text-2xl font-semibold`). Don't re-declare an
  `<h1>` inside the page body.
- Section title: `SectionCard`'s `title` (`text-base font-semibold`, an h2 by default, `h-4 w-4
  text-primary` icon) with a one-sentence `description`. The content heading shows the active
  section once: no h2 above a card that repeats it.
- In-card subsection heading: `text-sm font-medium`, sometimes with icon, paired with a
  `text-xs text-muted-foreground` description line directly below.
- Micro-label above a small block, a sub-nav group or a stat: `.label-micro` (`text-micro
  font-semibold uppercase text-muted-foreground`). Sans, never mono, never a `// prefix`.
- Large in-page state heading (e.g. "No Servers Configured"): `text-xl font-semibold text-foreground`.

## Cards and grouped blocks

`SectionCard` (`components/ui/section-card.tsx`) is the container for a block of a page: `{ title,
description?, icon?, status?, actions?, footer?, density?: 'default'|'compact' (p-5 / p-4), flush?
(no body padding: tables, terminals), headingLevel?: 2|3, collapsible?, defaultOpen?, storageKey?,
id? }`. A collapsible card's title is the toggle; `storageKey` remembers it. It replaces local
`TacticalPanel`/`SectionHeader` strips and hand-rolled `Card` sections.

**Never nest a SectionCard (or a Card) in another.** Inside one, a related group of fields gets the
grouped block: `rounded-xl border border-border/70 bg-background/40 p-4 space-y-4`, with the
subsection heading pair at the top.

A single toggle-style setting (label + description + control) is its own row:
`flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 p-3` — label and
description on the left, the control (`Switch`, button) on the right.

Stacked subsections within one card/body are separated by a plain `border-t` divider
(`border-t border-border/40` or `/60`, `pt-3`–`pt-6` depending on the gap needed) rather than extra
cards.

## Sub-navigation

A page with its own sections (Settings, Mods, Events, Diagnostics, ServerConfig categories) uses
`SubNav` inside `SubNavLayout` (`components/ui/sub-nav.tsx`):

- `SubNav { kind, groups: { id, label?, items }[], value, onValueChange, ariaLabel, mobile?,
  footer? }`, items `{ id, label, icon?, badge?, tone?: 'default'|'warning'|'danger', dirty?,
  disabled?, disabledReason? }`. `SubNavLayout { nav, children }` is the
  `lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-6` grid; the rail is sticky and scrolls on its own.
- `kind="tabs"`: Radix tab triggers (`role=tab`), for pages whose tests and panels are tabs
  (Settings, Diagnostics, Console). Wrap the layout in the page's own
  `<Tabs value onValueChange orientation="vertical">` so `TabsContent` links up.
  `kind="nav"`: buttons with `aria-current`, for views the page swaps itself (Mods, Events,
  ServerConfig categories).
- The active row looks like the main sidebar's: `bg-primary/10`, medium weight, a 2px start bar.
  **Style selection from the value or from `aria-selected`/`aria-current`, never from Radix
  `data-state`**: a Tooltip wrapped around a trigger overwrites `data-state` (that hid the
  selected Settings tab).
- Below `lg`: a full-width native select with the groups as option groups (`mobile="select"`,
  the default), or a chip strip for 5 items or fewer (`mobile="scroll"`).
- The selection lives in the URL with `useUrlParamState(param, allowed, fallback)`
  (`hooks/useUrlParamState.ts`): a reload or a link opens the same section, unknown values read as
  the fallback, writes `replace` and keep the other parameters. Parameters are a shared contract:
  `/settings?tab=`, `/debug?tab=`, `/console?tab=`, `/server-config?tab=`, `/mods?view=`,
  `/events?section=`, `/players?list=&player=`, `/backups?panel=`, `/server-setup?mode=`.
- Horizontal Radix tabs stay for in-content switches of 5 options or fewer, with the default
  `TabsList` look and sentence-case labels.

## Status, numbers and lists

- **`StatusPill`** `{ tone: 'ok'|'warn'|'error'|'info'|'idle'|'busy', label, detail?, pulse?, size?:
  'sm'|'md', to?, title? }`: one live state. The colour sits in the dot, tint and border; the label
  stays in the foreground colour (red text is too faint on the dark theme). `busy` shows a spinner,
  `pulse` a state about to change, `to` makes it a link to the fix. `StatusIndicator`,
  `ServerStatusBadge` and `BridgeStatusBadge` render through it.
- **`StatStrip`** `{ items: { id, label, value, detail?, icon?, tone?, onClick?, to?, ariaLabel? }[] }`:
  a page's summary numbers as one bordered row (1px dividers from `sm`, two columns on phones). No
  tile rows of cards, no hero metric.
- **`Toolbar`** `{ search?: { value, onChange(value), placeholder, ariaLabel, inputRef?,
  slashToFocus? }, children (filters), end?, sticky? }`: the row above a list. Escape clears the
  search.
- **`Segmented`** `{ value, onValueChange, items: { value, label, count? }[], ariaLabel, size? }`: a
  small one-of-n filter (All / Modified / Unsaved); a radio group with arrow keys.
- **`RowActions`** `{ primary?, items: { label, icon?, onSelect, destructive?, disabled?, reason? }[],
  ariaLabel }`: a row's one visible action plus a "…" menu; destructive items last after a
  separator; a disabled item shows its reason under the label.
- **`Stepper`** `{ steps: { id, label, status: 'done'|'current'|'upcoming'|'locked',
  lockedReason? }[], onStepClick? }`: where a wizard is (ServerSetup, the Discord wizard).

## Forms

`Label` sits directly above its `Input`/`Switch`/`Select`. Helper/explanatory text goes *below* the
control, not next to the label: `text-xs text-muted-foreground mt-1`. Numeric inputs that shouldn't
scroll-scrub get `onWheel={(e) => e.currentTarget.blur()}`.

## Loading state

A page that is still loading renders its `PageHeader` and a skeleton of its content (`PageSkeleton`
with a matching `variant`), not a spinner in the middle of the page. While a route's code loads,
`RoutePageSkeleton` shows the registry title, icon and description. `Loader2` with `animate-spin`
replaces the icon of a button whose action is in flight (`w-4 h-4`).

## Empty state

Use the shared `EmptyState` component (`components/EmptyState.tsx`), not a one-off `<div>`. It has
typed presets (`noData`, `noResults`, `serverOffline`, `noPlayers`, ...) that pick an icon and an
eyebrow automatically; pass `title` and optionally `description`/`action`. Use `compact` for an
empty state nested inside a smaller area (e.g. a filtered list with zero matches) versus full-page.

## Destructive actions

Two steps, not one. First, the triggering `Button` is `variant="destructive"`. Then confirmation is
a dedicated `AlertDialog` (not the same dialog the operator was already in) titled literally
**"Are you absolutely sure?"**, with an `AlertDialogDescription` that names the specific target and
consequence in plain language (who/what gets banned, wiped, deleted — not a generic "this cannot be
undone"). The confirming button is `AlertDialogAction` styled
`bg-destructive text-destructive-foreground hover:bg-destructive/90`; `AlertDialogCancel` is the
escape hatch, always present.

**"Are you absolutely sure?" is the default title, not the only allowed one.** A typed-confirmation
flow (`useConfirm`'s `requireTypedConfirmation` — the admin must type the exact target name before the
confirm button un-disables, reserved for actions with no undo that harm someone other than the admin
clicking) may title itself with the specific irreversible consequence instead — e.g. Players.tsx's
Kill confirmation: **"Kill Kate?"**, not the generic phrase. The generic title exists to force a beat
before a habituated operator clicks through; naming the target and the consequence does that same job
and does it better for the single most permanent action in the app, where a generic question is easier
to click past on autopilot than a sentence that says exactly who stops existing. This is a deliberate,
reviewed exception (2026-08-31 impeccable pass), not a drift to flag and "fix" back to the generic
phrase on a future pass — the rest of the destructive-action contract above (two steps, specific
consequence in the description, destructive styling, an always-present cancel) still applies in full.

## Callouts

Inside a page's content (page-level messages go through `PageAlerts`, which uses the same
treatments), chosen by severity, not interchangeable:
- **Error** (something failed, e.g. "RCON is not configured"): `border-destructive/40
  bg-destructive/10`, `AlertCircle` icon in `text-destructive`, title in the foreground colour.
- **Warning** (something needs attention, e.g. "Restart Required"): `border-warning/40 bg-warning/10`,
  `AlertTriangle` icon, `text-warning` title.
- **Neutral/instructional** (e.g. a "Quick Start" walkthrough): `border-border/60 bg-muted/40`, an
  on-theme icon (not `AlertTriangle`), no warning color.

No coloured `border-left`/`border-right` thicker than 1px on callouts, cards or list items.

## Type, colour and icons

- **Type scale:** `text-micro` (11px, tracked) for `.label-micro` and kbd hints, then `text-xs`,
  `text-sm`, `text-base` (section titles), `text-xl sm:text-2xl` (page titles). No `text-[8px]` or
  `text-[9px]`; `text-[10px]` only inside badges.
- **Mono is for data only:** paths, IDs, ports, versions, coordinates, logs, commands
  (`font-mono` maps to `--font-mono`). Never labels, buttons, headings or error text.
- **Colour roles:** section accents as above; status uses success, warning, destructive and info
  only; `variant="command"` is the single primary action of a view; badges are tinted (the
  `warning` badge too: a solid amber fill reads as a button).
- **Opacity steps must be on Tailwind's scale** (`/5`, `/10`, `/15` … `/95`). An off-scale step
  such as `bg-primary/12` or `text-foreground/86` compiles to nothing; use an arbitrary value
  (`bg-[hsl(var(--success)/0.12)]`) when a step in between is really needed.
- **Icons:** `lucide-react`, `h-4 w-4` in nav, cards and buttons, `h-5 w-5` in page headers. The
  same icon for a page in the sidebar, its header and the palette (the registry's).
- **Container width** comes from the registry `layout`; don't add a page-level `max-w-*`.

## Spacing rhythm

`space-y-6` between a page's top-level blocks. `SectionCard` bodies and grouped blocks use
`space-y-4`; SectionCard padding `p-5` (compact `p-4`), grouped blocks `p-4`, compact rows (toggle
rows, list items) `p-3`; toolbars `gap-2`. Don't invent a new gap value where one of these fits.
