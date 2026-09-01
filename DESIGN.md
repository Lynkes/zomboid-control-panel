# DESIGN.md

Conventions extracted from V1 (`Settings.tsx`, `Servers.tsx`, `Players.tsx`, `Mods.tsx`). Nothing
here is invented — every rule below is something those pages already do, repeatedly. `index.css`
and `tailwind.config.js` are already shared with V1 byte-for-byte, and `PageHeader.tsx` is already
identical in this repo — the design system is not something to design, it's something to keep
following.

## Page header

Every page opens with `<PageHeader>` (`components/PageHeader.tsx`): `title`, `description`, `icon`,
optional `eyebrow`, `tone`, `actions`. `eyebrow` is a small uppercase label naming *that page*, not
a shared section header — 6 V1 pages pass one (`Settings.tsx` → "Configuration",
`Servers.tsx` → "Fleet", `Mods.tsx` → "Workshop", `Scheduler.tsx` → "Maintenance",
`Events.tsx` → "world control", `ServerConfig.tsx` → "config") and every single value is distinct.
Even the two conceptually closest pages, `Settings.tsx` and `ServerConfig.tsx`, use "Configuration"
and "config" rather than sharing one string. **Don't reuse an eyebrow across sibling pages** — each
page names itself; there is no grouping label meant to appear on more than one page's header. Not
every page needs an eyebrow at all (`Players.tsx`'s header has none).
`tone` (`'ops' | 'world' | 'maintain' | 'config' | 'servers'`) sets the header's accent per page
type via `data-tone`. Primary page action (Save, Refresh) goes in `actions`, right-aligned.

## Headings

- Page title: set by `PageHeader` itself (`text-xl sm:text-2xl font-semibold`). Don't re-declare an
  `<h1>` inside the page body.
- Card-level heading: `CardTitle`, usually with a small `lucide-react` icon (`w-4 h-4 text-primary`)
  and `CardDescription` underneath explaining the card in one sentence.
- In-card subsection heading: `text-sm font-medium`, sometimes with icon, paired with a
  `text-xs text-muted-foreground` description line directly below.
- Micro-label above a small block (e.g. "What it unlocks", "Setup"): reuse the literal utility
  string `text-xs font-semibold uppercase tracking-wider text-muted-foreground`, not a class name —
  there is no dedicated `.section-label` class, this exact string is just repeated inline.
- Large in-page state heading (e.g. "No Servers Configured"): `text-xl font-semibold text-foreground`.

## Cards and grouped blocks

Standard card shape: `Card` > `CardHeader className="pb-4"` (icon + `CardTitle`, `CardDescription`)
> `CardContent className="space-y-4"`. This is the default container for a whole settings section
or a whole page's primary content.

Inside a card, a related group of fields that isn't its own card gets a lighter wrapper:
`rounded-xl border border-border/70 bg-background/40 p-4 space-y-4`, with the subsection
heading pair (above) at the top.

A single toggle-style setting (label + description + control) is its own row:
`flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 p-3` — label and
description on the left, the control (`Switch`, button) on the right.

Stacked subsections within one card/body are separated by a plain `border-t` divider
(`border-t border-border/40` or `/60`, `pt-3`–`pt-6` depending on the gap needed) rather than extra
cards. `border-t` appears this way 14 times in V1's `Settings.tsx` alone — it's the default divider,
not a special case.

## Forms

`Label` sits directly above its `Input`/`Switch`/`Select`. Helper/explanatory text goes *below* the
control, not next to the label: `text-xs text-muted-foreground mt-1`. Numeric inputs that shouldn't
scroll-scrub get `onWheel={(e) => e.currentTarget.blur()}`.

## Loading state

`Loader2` from `lucide-react` with `animate-spin`, always paired with the icon it's replacing rather
than a separate spinner region: inline in a button (`w-4 h-4`) while an action is in flight, or
centered page-level (`w-8 h-8 text-muted-foreground`) while a whole page's data is first loading.

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

Two distinct `Alert` treatments, chosen by severity, not interchangeable:
- **Warning** (something needs attention, e.g. "Restart Required"): `border-warning/40 bg-warning/10`,
  `AlertTriangle` icon, `text-warning` title.
- **Neutral/instructional** (e.g. a "Quick Start" walkthrough): `border-border/60 bg-muted/40`, an
  on-theme icon (not `AlertTriangle`), no warning color.

## Spacing rhythm

`CardContent` and grouped blocks use `space-y-4`. Compact rows (toggle rows, list items) use `p-3`;
grouped blocks use `p-4`. Between stacked top-level cards on a page, `space-y-5`–`6`. Don't invent a
new gap value where one of these already fits.
