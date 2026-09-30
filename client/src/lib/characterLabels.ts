import type { TFunction } from 'i18next'

// Names for skills, skill categories, traits and professions on the
// Character tab. Each one tries, in order: the game's own name in the
// panel's language (the pzCharacter namespace, generated from the game's
// translation files by client/scripts/extract-pz-character-names.mjs), then
// the name PanelBridge sent (the game's English, or a mod's own name), then
// the raw id. `t` must be bound to the pzCharacter namespace.

// A key segment has to be a plain identifier: an id with ':' or '.' would be
// read as a namespace or a nested key.
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/

function lookup(t: TFunction, group: string, segment: string | undefined, fallback: string): string {
  if (!segment || !SAFE_SEGMENT.test(segment)) return fallback
  const key = `${group}.${segment}`
  const value = t(key, { defaultValue: fallback })
  return typeof value === 'string' && value && value !== key ? value : fallback
}

// Vanilla ids arrive as "base:athletic"; the generated keys drop "base:".
function vanillaPath(id: string | undefined): string | undefined {
  if (!id) return undefined
  return id.startsWith('base:') ? id.slice('base:'.length) : id.includes(':') ? undefined : id
}

export function perkLabel(t: TFunction, perk: { id: string; name?: string }): string {
  return lookup(t, 'perks', perk.id, perk.name || perk.id)
}

export function categoryLabel(t: TFunction, category: { id: string; name?: string }): string {
  return lookup(t, 'perkCategories', category.id, category.name || category.id)
}

export function traitLabel(t: TFunction, trait: { id: string; label?: string }): string {
  return lookup(t, 'traits', vanillaPath(trait.id), trait.label || trait.id)
}

export function professionLabel(t: TFunction, profession: { id?: string; label?: string } | undefined): string | undefined {
  if (!profession) return undefined
  const fallback = profession.label || profession.id
  if (!fallback) return undefined
  return lookup(t, 'professions', vanillaPath(profession.id), fallback)
}

export function makeCollator(language: string): Intl.Collator {
  try {
    return new Intl.Collator(language, { sensitivity: 'base', numeric: true })
  } catch {
    return new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
  }
}

/** A sorted copy, ordered by each item's displayed label. */
export function sortByLabel<T>(items: T[], label: (item: T) => string, collator: Intl.Collator): T[] {
  return items
    .map((item) => ({ item, text: label(item) }))
    .sort((a, b) => collator.compare(a.text, b.text))
    .map(({ item }) => item)
}
