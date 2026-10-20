import type { ModGroup, ModGroupColorName } from '@/lib/api'
import { createRequirementResolver } from './modLoadOrder'

// Helpers for mod groups as the Mod Manager's organising layer: colours,
// "which groups is this mod in", the group dialog's "Auto-order members", and
// the Load order list's group blocks (move a whole group as one unit, gather a
// keep-together group). Pure; the components own the state.

/** The colours a group can have (the server accepts exactly these, or null). */
export const MOD_GROUP_COLORS: readonly ModGroupColorName[] = ['slate', 'red', 'orange', 'amber', 'lime', 'green', 'teal', 'sky', 'blue', 'violet', 'pink']
export type ModGroupColor = ModGroupColorName

const DOT_CLASS: Record<ModGroupColor, string> = {
  slate: 'bg-slate-400',
  red: 'bg-red-400',
  orange: 'bg-orange-400',
  amber: 'bg-amber-400',
  lime: 'bg-lime-400',
  green: 'bg-green-500',
  teal: 'bg-teal-400',
  sky: 'bg-sky-400',
  blue: 'bg-blue-400',
  violet: 'bg-violet-400',
  pink: 'bg-pink-400',
}

export function isGroupColor(value: unknown): value is ModGroupColor {
  return typeof value === 'string' && (MOD_GROUP_COLORS as readonly string[]).includes(value)
}

/** Background class for a group's colour dot; a group without a colour gets a hollow ring. */
export function groupDotClass(color: string | null | undefined): string {
  return isGroupColor(color) ? DOT_CLASS[color] : 'bg-transparent ring-1 ring-inset ring-muted-foreground/70'
}

// ── Membership ───────────────────────────────────────────────────────────────

// A group's place in the list it was indexed from, so a mix of mods lists its
// groups in that same order.
const groupRank = new WeakMap<ModGroup, number>()

/** Mod ID to the groups listing it, in the groups' list order. */
export function buildGroupMembership(groups: readonly ModGroup[]): Map<string, ModGroup[]> {
  const membership = new Map<string, ModGroup[]>()
  groups.forEach((group, rank) => {
    groupRank.set(group, rank)
    for (const modId of new Set(group.modIds)) {
      const list = membership.get(modId)
      if (list) list.push(group)
      else membership.set(modId, [group])
    }
  })
  return membership
}

/** The groups any of `modIds` belongs to, once each, in the groups' list order. */
export function groupsOfMods(modIds: readonly string[], membership: ReadonlyMap<string, readonly ModGroup[]>): ModGroup[] {
  const found = new Map<string, ModGroup>()
  for (const modId of modIds) for (const group of membership.get(modId) ?? []) found.set(group.id, group)
  return [...found.values()].sort((a, b) => (groupRank.get(a) ?? 0) - (groupRank.get(b) ?? 0))
}

// ── Conflicts per group ──────────────────────────────────────────────────────

export interface GroupConflictSummary {
  /** File conflicts between two members of the group. */
  internal: number
  /** File conflicts between a member and a mod outside the group. */
  external: number
  /** Every mod involved (members and their opponents), for the Conflicts view filter. */
  modIds: string[]
}

/** File conflicts touching each group, from the conflict scan's pairs. Groups without any are left out. */
export function summarizeGroupConflicts(
  groups: readonly ModGroup[],
  pairs: ReadonlyArray<{ modA: { modId: string }; modB: { modId: string } }>,
): Map<string, GroupConflictSummary> {
  const summary = new Map<string, GroupConflictSummary>()
  for (const group of groups) {
    const members = new Set(group.modIds)
    let internal = 0
    let external = 0
    const involved = new Set<string>()
    for (const pair of pairs) {
      const a = members.has(pair.modA.modId)
      const b = members.has(pair.modB.modId)
      if (!a && !b) continue
      if (a && b) internal++
      else external++
      involved.add(pair.modA.modId)
      involved.add(pair.modB.modId)
    }
    if (internal + external > 0) summary.set(group.id, { internal, external, modIds: [...involved] })
  }
  return summary
}

// ── Auto-order members ───────────────────────────────────────────────────────

/**
 * A member's tier from its ID and name: 0 library/framework/core/API, 1 main
 * mod, 2 add-on/expansion/pack, 3 patch/fix/compat/tweak. A heuristic: the dialog
 * shows the result before anything is saved.
 */
export type MemberTier = 0 | 1 | 2 | 3

const LIBRARY_WORDS = new Set([
  'lib', 'libs', 'library', 'libraries', 'framework', 'frameworks', 'core', 'api', 'common', 'shared',
  'util', 'utils', 'utility', 'utilities', 'dependency', 'dependencies', 'resource', 'resources', 'assets',
])
const ADDON_WORDS = new Set([
  'addon', 'addons', 'add', 'expansion', 'expansions', 'expanded', 'extra', 'extras', 'dlc', 'plugin', 'plugins',
  'extension', 'extensions', 'pack', 'packs',
])
const FIX_WORDS = new Set([
  'patch', 'patches', 'patched', 'fix', 'fixes', 'fixed', 'hotfix', 'compat', 'compatibility', 'tweak', 'tweaks',
  'bridge', 'override', 'overrides', 'integration',
])

/** "KI5LibraryB42 - Core_Fix" -> ["ki5", "library", "b42", "core", "fix"]. */
export function nameWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

export function memberTier(modId: string, name?: string): MemberTier {
  const words = new Set([...nameWords(modId), ...nameWords(name ?? '')])
  const has = (set: Set<string>) => [...words].some((word) => set.has(word))
  if (has(FIX_WORDS)) return 3
  if (has(ADDON_WORDS)) return 2
  if (has(LIBRARY_WORDS)) return 0
  return 1
}

export interface AutoOrderResult {
  order: string[]
  changed: boolean
  tiers: Record<string, MemberTier>
  /** How many `require=` links between members were applied. */
  requirements: number
}

/**
 * Orders a group's members: requirements between members first (a required
 * mod loads before the one needing it), then by tier (libraries, main mods,
 * add-ons, fixes), and otherwise as they are now.
 */
export function autoOrderMembers(
  members: readonly string[],
  options: { requires?: ReadonlyMap<string, readonly string[]>; names?: Readonly<Record<string, string>> } = {},
): AutoOrderResult {
  const list = [...new Set(members)]
  const index = new Map(list.map((id, i) => [id, i]))
  const tiers: Record<string, MemberTier> = {}
  for (const id of list) tiers[id] = memberTier(id, options.names?.[id])

  const resolve = createRequirementResolver(list)
  const succ: number[][] = list.map(() => [])
  const indegree = new Array<number>(list.length).fill(0)
  const reaches = (from: number, to: number) => {
    const seen = new Set<number>([from])
    const stack = [from]
    while (stack.length > 0) {
      const node = stack.pop() as number
      if (node === to) return true
      for (const next of succ[node]) if (!seen.has(next)) { seen.add(next); stack.push(next) }
    }
    return false
  }
  let requirements = 0
  list.forEach((id, v) => {
    for (const declared of options.requires?.get(id) ?? []) {
      const dependency = resolve(declared)
      if (!dependency || dependency === id) continue
      const u = index.get(dependency) as number
      // A cycle between members: the edge that would close it is left out.
      if (succ[u].includes(v) || reaches(v, u)) continue
      succ[u].push(v)
      indegree[v]++
      requirements++
    }
  })

  const before = (a: number, b: number) => (tiers[list[a]] !== tiers[list[b]] ? tiers[list[a]] < tiers[list[b]] : a < b)
  const ready = list.map((_, i) => i).filter((i) => indegree[i] === 0)
  const order: string[] = []
  while (ready.length > 0) {
    let best = 0
    for (let i = 1; i < ready.length; i++) if (before(ready[i], ready[best])) best = i
    const [node] = ready.splice(best, 1)
    order.push(list[node])
    for (const next of succ[node]) if (--indegree[next] === 0) ready.push(next)
  }
  return { order, changed: order.some((id, i) => id !== list[i]), tiers, requirements }
}

// ── Group blocks in the load order ───────────────────────────────────────────

export type BlockMove = 'top' | 'up' | 'down' | 'bottom'

/** Where a group's present members are in `order`, ascending. */
export function memberPositions(order: readonly string[], modIds: readonly string[]): number[] {
  const wanted = new Set(modIds)
  const positions: number[] = []
  order.forEach((id, i) => { if (wanted.has(id)) positions.push(i) })
  return positions
}

export function isContiguous(positions: readonly number[]): boolean {
  return positions.length > 0 && positions[positions.length - 1] - positions[0] === positions.length - 1
}

/**
 * Moves a contiguous run of members as one unit. `unitAt(index)` names the
 * unit an index belongs to (a shown block jumps over a neighbouring block as
 * a whole); by default every row is its own unit. Null when the move does
 * nothing or the members are not one run.
 */
export function moveGroupBlock(
  order: readonly string[],
  modIds: readonly string[],
  move: BlockMove,
  unitAt?: (index: number) => readonly [number, number] | null,
): string[] | null {
  const positions = memberPositions(order, modIds)
  if (!isContiguous(positions)) return null
  const start = positions[0]
  const end = positions[positions.length - 1]
  const block = order.slice(start, end + 1)
  const last = order.length - 1
  if (move === 'top') return start === 0 ? null : [...block, ...order.slice(0, start), ...order.slice(end + 1)]
  if (move === 'bottom') return end === last ? null : [...order.slice(0, start), ...order.slice(end + 1), ...block]
  if (move === 'up') {
    if (start === 0) return null
    const [unitStart] = unitAt?.(start - 1) ?? [start - 1, start - 1]
    return [...order.slice(0, unitStart), ...block, ...order.slice(unitStart, start), ...order.slice(end + 1)]
  }
  if (end === last) return null
  const [, unitEnd] = unitAt?.(end + 1) ?? [end + 1, end + 1]
  return [...order.slice(0, start), ...order.slice(end + 1, unitEnd + 1), ...block, ...order.slice(unitEnd + 1)]
}

/**
 * Moves a contiguous run of members so it starts at `target` (an index in the
 * order without the block): a dragged group header.
 */
export function moveGroupBlockTo(order: readonly string[], modIds: readonly string[], target: number): string[] | null {
  const positions = memberPositions(order, modIds)
  if (!isContiguous(positions)) return null
  const start = positions[0]
  const end = positions[positions.length - 1]
  const block = order.slice(start, end + 1)
  const rest = [...order.slice(0, start), ...order.slice(end + 1)]
  const at = Math.max(0, Math.min(rest.length, target))
  if (at === start) return null
  return [...rest.slice(0, at), ...block, ...rest.slice(at)]
}

/**
 * Puts a group's present members together at the slot of its first member, in
 * the group's order; the mods that were between them follow the block in
 * their own order (what the server does for a keep-together group).
 */
export function gatherGroup(order: readonly string[], groupModIds: readonly string[]): string[] {
  const present = new Set(order)
  const members = [...new Set(groupModIds)].filter((id) => present.has(id))
  if (members.length < 2) return [...order]
  const memberSet = new Set(members)
  const first = order.findIndex((id) => memberSet.has(id))
  const rest = order.filter((id) => !memberSet.has(id))
  return [...rest.slice(0, first), ...members, ...rest.slice(first)]
}
