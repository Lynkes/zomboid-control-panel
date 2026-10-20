// Which mods of one Workshop item are variants of each other (alternative
// versions: only one should be enabled), from the conflict scan's pairs.
//
// Sharing files is not enough. A base mod and its add-on (one require=s,
// loadModAfter=s the other, or the other declares loadModBefore= it,
// directly or through other mods) share files on purpose: the add-on
// overrides the base, which the scan rates as an intended patch. Mods that
// only ship the same translation keys (an item's name strings) are not
// alternatives either: the game merges translations key by key.

import type { ConflictPair } from '@/types'

export interface VariantModInfo {
  id: string
  require?: string[]
  loadAfter?: string[]
  loadBefore?: string[]
}

// The ids of a mod.info list as the game matches them (server
// utils/modLoadOrder.js normaliseModInfoList): trimmed, ";" splits, exact case.
function idsOf(list: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const entry of list ?? []) {
    if (typeof entry !== 'string') continue
    for (const part of entry.split(';')) {
      const id = part.trim()
      if (id) out.push(id)
    }
  }
  return out
}

/**
 * `dependsOn(a, b)`: a declared, directly or through other mods, that it
 * builds on b (the server's createDependencyRelation, exact ids).
 */
export function createDependsOn(mods: Iterable<VariantModInfo>): (a: string, b: string) => boolean {
  const catalog = new Map<string, VariantModInfo>()
  for (const mod of mods) if (mod?.id && !catalog.has(mod.id)) catalog.set(mod.id, mod)
  const direct = new Map<string, Set<string>>()
  const link = (from: string, to: string) => {
    if (!from || !to || from === to || !catalog.has(from) || !catalog.has(to)) return
    if (!direct.has(from)) direct.set(from, new Set())
    direct.get(from)!.add(to)
  }
  for (const mod of catalog.values()) {
    for (const dep of idsOf(mod.require)) link(mod.id, dep)
    for (const dep of idsOf(mod.loadAfter)) link(mod.id, dep)
    for (const next of idsOf(mod.loadBefore)) link(next, mod.id)
  }
  const closure = new Map<string, Set<string>>()
  const reach = (id: string) => {
    let seen = closure.get(id)
    if (seen) return seen
    seen = new Set()
    const pending = [...(direct.get(id) ?? [])]
    while (pending.length) {
      const next = pending.pop()!
      if (seen.has(next)) continue
      seen.add(next)
      for (const further of direct.get(next) ?? []) pending.push(further)
    }
    closure.set(id, seen)
    return seen
  }
  return (a, b) => reach(a).has(b)
}

/** A shared file that says two mods are alternatives (not an intended or a translation-only overlap). */
function isVariantEvidence(file: ConflictPair['files'][number]): boolean {
  if (file.kind === 'declared-incompatible') return true
  if (file.severity === 'info' || file.intended) return false
  if (file.reason === 'intendedPatch' || file.reason === 'patchLoadsBeforeTarget') return false
  return file.kind !== 'translation-override'
}

/**
 * Per Workshop item, which of its mods are variants of which: Map<wsId,
 * Map<modId, Set<modId>>>. `groups` are the Active items with their mods,
 * `isPairIgnored` the pairs dismissed as "Not a conflict".
 */
export function computeVariantSiblings(
  pairs: readonly ConflictPair[] | undefined,
  groups: ReadonlyArray<{ wsId: string; mods: readonly VariantModInfo[] }>,
  isPairIgnored: (a: string, b: string) => boolean,
): Map<string, Map<string, Set<string>>> {
  const result = new Map<string, Map<string, Set<string>>>()
  if (!pairs?.length) return result
  const modToWs = new Map<string, string>()
  for (const g of groups) for (const m of g.mods) modToWs.set(m.id, g.wsId)
  const dependsOn = createDependsOn(groups.flatMap((g) => g.mods))
  const add = (map: Map<string, Set<string>>, a: string, b: string) => {
    const set = map.get(a) ?? new Set<string>()
    set.add(b)
    map.set(a, set)
  }
  for (const pair of pairs) {
    const a = pair.modA.modId
    const b = pair.modB.modId
    const ws = modToWs.get(a)
    if (!ws || ws !== modToWs.get(b) || a === b) continue
    if (isPairIgnored(a, b)) continue
    if (dependsOn(a, b) || dependsOn(b, a)) continue
    if (!pair.files.some(isVariantEvidence)) continue
    let groupMap = result.get(ws)
    if (!groupMap) { groupMap = new Map(); result.set(ws, groupMap) }
    add(groupMap, a, b)
    add(groupMap, b, a)
  }
  return result
}
