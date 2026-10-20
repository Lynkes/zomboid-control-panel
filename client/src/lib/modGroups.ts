import type { ModGroup, ModGroupDocument } from '@/lib/api'

// Pure helpers for the Mod Manager's "Mod groups" (components/mods/ModGroupsPanel
// and ModGroupDialog). A group is a named, ordered list of mod IDs; the list
// order is the load order those mods must keep relative to each other.

export const MOD_GROUP_KIND = 'zcp-mod-group' as const
export const MOD_GROUP_SCHEMA = 1 as const

// A group export is a few KB (a name and some mod IDs). Refuse anything much
// bigger before parsing it: it is not one.
export const MAX_GROUP_FILE_BYTES = 1_000_000

/** Same length limits the Save Preset dialog uses. */
export const GROUP_NAME_MAX = 60 // the server's limit (MOD_GROUP_LIMITS)
export const GROUP_DESCRIPTION_MAX = 300 // the server's limit (MOD_GROUP_LIMITS)

/** "KI5 Vehicles!" -> "ki5-vehicles". Keeps letters and digits of any script, so a Chinese name still names its file. */
export function slugifyGroupName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug || 'group'
}

export function groupExportFileName(name: string): string {
  return `zcp-mod-group-${slugifyGroupName(name)}.json`
}

/** The file Export writes and Import (here and in another panel) reads. */
export function buildGroupDocument(group: Pick<ModGroup, 'name' | 'description' | 'modIds'>): ModGroupDocument {
  const description = group.description?.trim()
  return {
    schema: MOD_GROUP_SCHEMA,
    kind: MOD_GROUP_KIND,
    name: group.name,
    ...(description ? { description } : {}),
    modIds: [...group.modIds],
  }
}

export type GroupDocumentProblem = 'tooLarge' | 'notJson' | 'wrongKind' | 'unsupportedSchema' | 'invalid'

export type ParsedGroupDocument =
  | { ok: true; document: ModGroupDocument }
  | { ok: false; problem: GroupDocumentProblem }

/**
 * Checks that file text is a mod group export before it is sent anywhere. The
 * server validates it again (and owns the limits); this only keeps an obviously
 * wrong file (a preset, a server .ini, a photo) from becoming a request. Returns
 * a clean copy holding only the known fields.
 */
export function parseGroupDocument(text: string): ParsedGroupDocument {
  if (text.length > MAX_GROUP_FILE_BYTES) return { ok: false, problem: 'tooLarge' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, problem: 'notJson' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, problem: 'notJson' }
  const doc = value as Record<string, unknown>
  if (doc.kind !== MOD_GROUP_KIND) return { ok: false, problem: 'wrongKind' }
  if (doc.schema !== MOD_GROUP_SCHEMA) return { ok: false, problem: 'unsupportedSchema' }
  const name = typeof doc.name === 'string' ? doc.name.trim() : ''
  const modIds = doc.modIds
  if (!name || !Array.isArray(modIds) || modIds.length === 0) return { ok: false, problem: 'invalid' }
  if (!modIds.every((id) => typeof id === 'string' && id.trim() !== '')) return { ok: false, problem: 'invalid' }
  const description = typeof doc.description === 'string' ? doc.description.trim() : ''
  return {
    ok: true,
    document: {
      schema: MOD_GROUP_SCHEMA,
      kind: MOD_GROUP_KIND,
      name,
      ...(description ? { description } : {}),
      modIds: (modIds as string[]).map((id) => id.trim()),
    },
  }
}

/** A copy of `list` with the entry at `from` moved to `to`; `list` itself when that is not a move. */
export function moveListEntry<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list as T[]
  const next = list.slice()
  const [entry] = next.splice(from, 1)
  next.splice(to, 0, entry)
  return next
}

/** Saves `data` as a pretty-printed JSON file through the browser's download. */
export function downloadJsonFile(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}
