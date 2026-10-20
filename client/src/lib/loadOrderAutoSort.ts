// Group-aware Auto-sort for the Mods > Load order list.
//
// Project Zomboid loads mods in their `Mods=` order: a mod that declares
// `require=` in its mod.info expects those mods to be loaded first, and when
// two mods ship the same file the one loaded later wins. This module proposes
// a new order that
//
//   1. satisfies every `require=` dependency (dependency cycles are reported
//      and only the edges inside a cycle are dropped);
//   2. keeps every mod group's own order, and loads a "keep together" group as
//      one contiguous block (the block is one node of the sort);
//   3. honours a group's placement: "first" groups (and what they need) load
//      before everything else, "last" groups (and what needs them) after;
//   4. keeps the current winner of every file conflict (the later mod) unless
//      a dependency, a group order or a placement says otherwise;
//   5. otherwise keeps the current order: unrelated mods keep their relative
//      order, and the order with the fewest moved mods is chosen.
//
// Nothing here throws on a contradiction: a group order that a dependency
// contradicts, a block that cannot stay together, a placement that cannot
// hold or a conflict winner that has to change are all reported, with the
// mods and groups involved, and the next-priority rule gives way.
//
// Priority, highest first: dependencies, group order and blocks, placement,
// conflict winners, stability. Pure and synchronous; 600 mods sort in a few
// milliseconds.

import { createRequirementResolver } from './modLoadOrder'

export type GroupPlacement = 'first' | 'last'

export interface AutoSortGroup {
  id: string
  /** Ordered: the load order the members keep relative to each other. */
  modIds: readonly string[]
  /** The members load as one contiguous block. */
  keepTogether?: boolean
  placement?: GroupPlacement | null
}

export interface AutoSortInput {
  /** The current load order (Mods=). A repeated ID counts once. */
  order: readonly string[]
  /** Mod ID to its declared `require=` entries (buildRequiresMap). */
  requires?: ReadonlyMap<string, readonly string[]>
  groups?: readonly AutoSortGroup[]
  /** Pairs of mods that ship the same files (the conflict scan's pairs). */
  conflictPairs?: ReadonlyArray<readonly [string, string]>
}

/** Why a mod moved. */
export type AutoSortReason =
  /** Loads after `modId`, which it requires. */
  | { kind: 'requires'; modId: string }
  /** Loads before `modId`, which requires it. */
  | { kind: 'requiredBy'; modId: string }
  /** Keeps the order of group `groupId`. */
  | { kind: 'groupOrder'; groupId: string }
  /** Loads together with the rest of group `groupId`. */
  | { kind: 'together'; groupId: string }
  /** Its group loads first or last. */
  | { kind: 'placement'; groupId: string; placement: GroupPlacement }
  /** Still loads after `over`, so it keeps winning their file conflict. */
  | { kind: 'winner'; over: string }
  /** Still loads before `winner`, which keeps winning their file conflict. */
  | { kind: 'keepsWinner'; winner: string }

export interface AutoSortMove {
  modId: string
  /** 1-based positions. */
  from: number
  to: number
  reasons: AutoSortReason[]
}

export type ConstraintCause = 'dependency' | 'group'

export interface AutoSortResult {
  order: string[]
  /** The fewest mods that explain the change; everything else only drifted. */
  moves: AutoSortMove[]
  /** How many rules of each kind applied. */
  constraints: { dependencies: number; groupOrder: number; together: number; placement: number; winners: number }
  /** Mods that require each other; no order satisfies them, they keep their order. */
  cycles: string[][]
  /** A group lists `before` ahead of `after`, but a dependency (or another group) needs the opposite. */
  groupOrderConflicts: Array<{ groupId: string; before: string; after: string; cause: ConstraintCause }>
  /** Keep-together groups that cannot be one block: `between` must load among their members. */
  splitGroups: Array<{ groupIds: string[]; between: string[] }>
  /** A "last" group's mod must load before a "first" group's mod (it is loaded first). */
  placementConflicts: Array<{ groupIds: string[]; modIds: string[] }>
  /** File conflicts whose winner changes (the other mod now loads later), and why. */
  winnersChanged: Array<{ previousWinner: string; newWinner: string; cause: ConstraintCause | 'placement' }>
  /** Declared requirements that are not in the load order at all. */
  missing: Array<{ modId: string; requires: string }>
}

const MAX_WINNER_ROUNDS = 8
const MAX_LISTED = 8

// ── Small binary heap (no dependency) ─────────────────────────────────────────

class Heap {
  private items: number[] = []
  constructor(private readonly before: (a: number, b: number) => boolean) {}
  get size() {
    return this.items.length
  }
  push(value: number) {
    const items = this.items
    items.push(value)
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.before(items[i], items[parent])) break
      ;[items[i], items[parent]] = [items[parent], items[i]]
      i = parent
    }
  }
  pop(): number {
    const items = this.items
    const top = items[0]
    const last = items.pop() as number
    if (items.length > 0) {
      items[0] = last
      let i = 0
      for (;;) {
        const left = 2 * i + 1
        const right = left + 1
        let best = i
        if (left < items.length && this.before(items[left], items[best])) best = left
        if (right < items.length && this.before(items[right], items[best])) best = right
        if (best === i) break
        ;[items[i], items[best]] = [items[best], items[i]]
        i = best
      }
    }
    return top
  }
}

// ── Graph helpers over integer nodes ──────────────────────────────────────────

/** Tarjan's strongly connected components, iterative (long chains can't overflow the stack). */
function stronglyConnected(n: number, succ: readonly (readonly number[])[]): number[][] {
  const index = new Int32Array(n).fill(-1)
  const low = new Int32Array(n)
  const onStack = new Uint8Array(n)
  const stack: number[] = []
  const components: number[][] = []
  let counter = 0
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue
    const frames: Array<{ node: number; cursor: number }> = [{ node: root, cursor: 0 }]
    index[root] = low[root] = counter++
    stack.push(root)
    onStack[root] = 1
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]
      const next = succ[frame.node]
      if (frame.cursor < next.length) {
        const to = next[frame.cursor++]
        if (index[to] === -1) {
          index[to] = low[to] = counter++
          stack.push(to)
          onStack[to] = 1
          frames.push({ node: to, cursor: 0 })
        } else if (onStack[to]) {
          low[frame.node] = Math.min(low[frame.node], index[to])
        }
        continue
      }
      frames.pop()
      if (low[frame.node] === index[frame.node]) {
        const component: number[] = []
        for (;;) {
          const member = stack.pop() as number
          onStack[member] = 0
          component.push(member)
          if (member === frame.node) break
        }
        components.push(component)
      }
      const parent = frames[frames.length - 1]
      if (parent) low[parent.node] = Math.min(low[parent.node], low[frame.node])
    }
  }
  return components
}

/** Reusable "can `from` reach `to`" over a set of adjacency lists, with a generation-stamped visited array. */
class Reach {
  private seen: Int32Array
  private stamp = 0
  private readonly stack: number[] = []
  constructor(size: number) {
    this.seen = new Int32Array(size)
  }
  /** Every node reachable from `starts` (starts excluded unless reached again) through `lists`. */
  collect(starts: Iterable<number>, lists: ReadonlyArray<readonly (readonly number[])[]>, skip?: (node: number) => boolean): Set<number> {
    const stamp = ++this.stamp
    const found = new Set<number>()
    const stack = this.stack
    stack.length = 0
    for (const start of starts) stack.push(start)
    for (const start of stack) this.seen[start] = stamp
    while (stack.length > 0) {
      const node = stack.pop() as number
      for (const adjacency of lists) {
        for (const next of adjacency[node] ?? []) {
          if (this.seen[next] === stamp) continue
          this.seen[next] = stamp
          if (skip?.(next)) continue
          found.add(next)
          stack.push(next)
        }
      }
    }
    return found
  }
  /** Whether `to` is reachable from `from`. */
  reaches(from: number, to: number, lists: ReadonlyArray<readonly (readonly number[])[]>): boolean {
    if (from === to) return true
    const stamp = ++this.stamp
    const stack = this.stack
    stack.length = 0
    stack.push(from)
    this.seen[from] = stamp
    while (stack.length > 0) {
      const node = stack.pop() as number
      for (const adjacency of lists) {
        for (const next of adjacency[node] ?? []) {
          if (next === to) return true
          if (this.seen[next] === stamp) continue
          this.seen[next] = stamp
          stack.push(next)
        }
      }
    }
    return false
  }
}

function addEdge(lists: number[][], from: number, to: number) {
  const list = lists[from]
  if (!list.includes(to)) list.push(to)
}

// ── Weighted longest increasing subsequence ──────────────────────────────────

/**
 * Indices (into `values`) of the increasing subsequence with the largest total
 * weight. With unrelated mods weighted far above the others, every unrelated
 * mod stays "in place" and the rest are the fewest mods that explain the change.
 */
function heaviestIncreasing(values: readonly number[], weights: readonly number[]): Set<number> {
  const size = values.length
  // Fenwick tree over the value domain storing (best weight, index of its end).
  const maxValue = values.reduce((max, v) => Math.max(max, v), -1) + 1
  const treeWeight = new Float64Array(maxValue + 1)
  const treeIndex = new Int32Array(maxValue + 1).fill(-1)
  const best = new Float64Array(size)
  const previous = new Int32Array(size).fill(-1)
  const query = (limit: number): [number, number] => {
    let weight = 0
    let index = -1
    for (let i = limit; i > 0; i -= i & -i) {
      if (treeWeight[i] > weight) {
        weight = treeWeight[i]
        index = treeIndex[i]
      }
    }
    return [weight, index]
  }
  const update = (at: number, weight: number, index: number) => {
    for (let i = at; i <= maxValue; i += i & -i) {
      if (weight > treeWeight[i]) {
        treeWeight[i] = weight
        treeIndex[i] = index
      }
    }
  }
  let bestEnd = -1
  let bestWeight = 0
  for (let i = 0; i < size; i++) {
    const [weight, index] = query(values[i]) // strictly smaller values
    best[i] = weight + weights[i]
    previous[i] = index
    update(values[i] + 1, best[i], i)
    if (best[i] > bestWeight) {
      bestWeight = best[i]
      bestEnd = i
    }
  }
  const kept = new Set<number>()
  for (let i = bestEnd; i !== -1; i = previous[i]) kept.add(i)
  return kept
}

// ── The sort ─────────────────────────────────────────────────────────────────

interface Variant {
  order: number[] // mod indices
  kept: Set<number> // mod indices that did not move
}

export function autoSortLoadOrder(input: AutoSortInput): AutoSortResult {
  // Mods, deduplicated: index = original position.
  const order: string[] = []
  const position = new Map<string, number>()
  for (const id of input.order) {
    if (typeof id !== 'string' || !id || position.has(id)) continue
    position.set(id, order.length)
    order.push(id)
  }
  const n = order.length
  const reach = new Reach(n)

  // ── 1. Dependencies ────────────────────────────────────────────────────────
  const missing: AutoSortResult['missing'] = []
  const resolve = createRequirementResolver(order)
  const rawDeps: Array<[number, number]> = []
  for (let v = 0; v < n; v++) {
    const modId = order[v]
    const seen = new Set<string>()
    const reported = new Set<string>()
    for (const declared of input.requires?.get(modId) ?? []) {
      const requirement = typeof declared === 'string' ? declared.trim() : ''
      if (!requirement) continue
      const dependency = resolve(requirement)
      if (!dependency) {
        if (!reported.has(requirement)) {
          reported.add(requirement)
          missing.push({ modId, requires: requirement })
        }
        continue
      }
      if (dependency === modId || seen.has(dependency)) continue
      seen.add(dependency)
      rawDeps.push([position.get(dependency) as number, v])
    }
  }
  const rawDepSucc: number[][] = Array.from({ length: n }, () => [])
  for (const [u, v] of rawDeps) rawDepSucc[u].push(v)
  const cycleOf = new Int32Array(n).fill(-1)
  const cycles: number[][] = []
  for (const component of stronglyConnected(n, rawDepSucc)) {
    if (component.length < 2) continue
    component.sort((a, b) => a - b)
    for (const member of component) cycleOf[member] = cycles.length
    cycles.push(component)
  }
  cycles.sort((a, b) => a[0] - b[0])
  cycles.forEach((cycle, i) => cycle.forEach((member) => { cycleOf[member] = i }))

  // Mod-level graph: dependency edges, then group-order edges.
  const depSucc: number[][] = Array.from({ length: n }, () => [])
  const depPred: number[][] = Array.from({ length: n }, () => [])
  let dependencyCount = 0
  for (const [u, v] of rawDeps) {
    if (cycleOf[u] !== -1 && cycleOf[u] === cycleOf[v]) continue
    if (depSucc[u].includes(v)) continue
    depSucc[u].push(v)
    depPred[v].push(u)
    dependencyCount++
  }

  // ── 2. Group order ─────────────────────────────────────────────────────────
  const groups = (input.groups ?? []).filter((group) => group && typeof group.id === 'string')
  const presentMembers = new Map<string, number[]>()
  for (const group of groups) {
    const seen = new Set<number>()
    const members: number[] = []
    for (const id of group.modIds ?? []) {
      const index = position.get(id)
      if (index === undefined || seen.has(index)) continue
      seen.add(index)
      members.push(index)
    }
    presentMembers.set(group.id, members)
  }

  const grpSucc: number[][] = Array.from({ length: n }, () => [])
  const groupEdges: Array<{ from: number; to: number; groupId: string }> = []
  const groupOrderConflicts: AutoSortResult['groupOrderConflicts'] = []
  for (const group of groups) {
    const members = presentMembers.get(group.id) ?? []
    for (let i = 0; i + 1 < members.length; i++) {
      const a = members[i]
      const b = members[i + 1]
      if (grpSucc[a].includes(b) || depSucc[a].includes(b)) {
        groupEdges.push({ from: a, to: b, groupId: group.id })
        continue
      }
      if (reach.reaches(b, a, [depSucc, grpSucc])) {
        groupOrderConflicts.push({
          groupId: group.id,
          before: order[a],
          after: order[b],
          cause: reach.reaches(b, a, [depSucc]) ? 'dependency' : 'group',
        })
        continue
      }
      grpSucc[a].push(b)
      groupEdges.push({ from: a, to: b, groupId: group.id })
    }
  }
  const grpPred: number[][] = Array.from({ length: n }, () => [])
  for (let a = 0; a < n; a++) for (const b of grpSucc[a]) grpPred[b].push(a)

  // ── 3. Keep-together blocks ────────────────────────────────────────────────
  // Groups that share a member are one block (union-find over mods).
  const parent = Int32Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const inBlockGroup = new Uint8Array(n)
  for (const group of groups) {
    if (!group.keepTogether) continue
    const members = presentMembers.get(group.id) ?? []
    if (members.length < 2) continue
    for (const member of members) inBlockGroup[member] = 1
    for (let i = 1; i < members.length; i++) {
      const a = find(members[0])
      const b = find(members[i])
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
    }
  }
  const components = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    if (!inBlockGroup[i]) continue
    const root = find(i)
    const list = components.get(root)
    if (list) list.push(i)
    else components.set(root, [i])
  }
  const componentGroups = new Map<number, string[]>()
  for (const group of groups) {
    if (!group.keepTogether) continue
    const members = presentMembers.get(group.id) ?? []
    if (members.length < 2) continue
    const root = find(members[0])
    const list = componentGroups.get(root)
    if (list) list.push(group.id)
    else componentGroups.set(root, [group.id])
  }

  // nodeOf[mod] = the node it belongs to (itself, or its block's first member).
  const nodeOf = Int32Array.from({ length: n }, (_, i) => i)
  const blockMembers = new Map<number, number[]>() // node -> members (blocks only)
  const blockGroups = new Map<number, string[]>()
  const splitGroups: AutoSortResult['splitGroups'] = []

  const buildNodeGraph = (lists: ReadonlyArray<readonly (readonly number[])[]>) => {
    const succ: number[][] = Array.from({ length: n }, () => [])
    for (const adjacency of lists) {
      for (let u = 0; u < n; u++) {
        const nu = nodeOf[u]
        for (const v of adjacency[u]) {
          const nv = nodeOf[v]
          if (nu !== nv) addEdge(succ, nu, nv)
        }
      }
    }
    const pred: number[][] = Array.from({ length: n }, () => [])
    for (let u = 0; u < n; u++) for (const v of succ[u]) pred[v].push(u)
    return { succ, pred }
  }

  // Blocks are tried in the groups' own list order, never by where their mods
  // sit now: when two blocks exclude each other the same one wins every time,
  // so sorting a sorted order changes nothing.
  const groupRank = new Map(groups.map((group, i) => [group.id, i]))
  const rankOf = (members: number[]) =>
    Math.min(...(componentGroups.get(find(members[0])) ?? []).map((id) => groupRank.get(id) ?? Infinity))
  const orderedComponents = [...components.values()].sort((a, b) => rankOf(a) - rankOf(b))
  let nodeGraph = buildNodeGraph([depSucc, grpSucc])
  for (const members of orderedComponents) {
    members.sort((a, b) => a - b)
    const memberNodes = new Set(members.map((m) => nodeOf[m]))
    const isMember = (node: number) => memberNodes.has(node)
    const descendants = reach.collect(memberNodes, [nodeGraph.succ], isMember)
    const ancestors = reach.collect(memberNodes, [nodeGraph.pred], isMember)
    const between: number[] = []
    for (const node of descendants) if (ancestors.has(node)) between.push(node)
    const root = find(members[0])
    const groupIds = componentGroups.get(root) ?? []
    if (between.length > 0) {
      const mods = between.flatMap((node) => blockMembers.get(node) ?? [node]).sort((a, b) => a - b)
      splitGroups.push({ groupIds, between: mods.slice(0, MAX_LISTED).map((m) => order[m]) })
      continue
    }
    const node = members[0]
    for (const member of members) nodeOf[member] = node
    blockMembers.set(node, members)
    blockGroups.set(node, groupIds)
    nodeGraph = buildNodeGraph([depSucc, grpSucc])
  }
  const depNodeGraph = buildNodeGraph([depSucc])
  const isNode = (i: number) => nodeOf[i] === i

  // Each block's own order: its members by their dependencies and group order, else as they are.
  const blockOrder = new Map<number, number[]>()
  for (const [node, members] of blockMembers) {
    const inside = new Set(members)
    const indegree = new Map<number, number>(members.map((m) => [m, 0]))
    for (const m of members) {
      for (const next of [...depSucc[m], ...grpSucc[m]]) {
        if (inside.has(next)) indegree.set(next, (indegree.get(next) ?? 0) + 1)
      }
    }
    const heap = new Heap((a, b) => a < b)
    for (const m of members) if (indegree.get(m) === 0) heap.push(m)
    const result: number[] = []
    while (heap.size > 0) {
      const m = heap.pop()
      result.push(m)
      for (const next of [...depSucc[m], ...grpSucc[m]]) {
        if (!inside.has(next)) continue
        const left = (indegree.get(next) ?? 0) - 1
        indegree.set(next, left)
        if (left === 0) heap.push(next)
      }
    }
    blockOrder.set(node, result.length === members.length ? result : members)
  }

  // ── 4. Placement tiers ─────────────────────────────────────────────────────
  // "first" seeds and everything they need load first (an ancestor-closed set);
  // "last" seeds and everything that needs them load last (descendant-closed),
  // except what a "first" mod needs: that is reported and loads first.
  const preference = new Int8Array(n) // 0 none, 1 first, 2 last, 3 both
  const placementGroupsOfNode = new Map<number, Array<{ groupId: string; placement: GroupPlacement }>>()
  let placementCount = 0
  for (const group of groups) {
    if (group.placement !== 'first' && group.placement !== 'last') continue
    const members = presentMembers.get(group.id) ?? []
    if (members.length === 0) continue
    placementCount++
    for (const member of members) {
      const node = nodeOf[member]
      preference[node] |= group.placement === 'first' ? 1 : 2
      const list = placementGroupsOfNode.get(node)
      const entry = { groupId: group.id, placement: group.placement }
      if (list) {
        if (!list.some((e) => e.groupId === group.id)) list.push(entry)
      } else placementGroupsOfNode.set(node, [entry])
    }
  }
  const firstSeeds: number[] = []
  const lastSeeds: number[] = []
  const placementConflictNodes = new Set<number>()
  for (let node = 0; node < n; node++) {
    if (!isNode(node)) continue
    if (preference[node] === 3) placementConflictNodes.add(node)
    else if (preference[node] === 1) firstSeeds.push(node)
    else if (preference[node] === 2) lastSeeds.push(node)
  }
  const tier = new Int8Array(n).fill(1)
  const firstSet = new Set(firstSeeds)
  for (const node of reach.collect(firstSeeds, [nodeGraph.pred])) firstSet.add(node)
  const lastStarts = lastSeeds.filter((node) => {
    if (!firstSet.has(node)) return true
    placementConflictNodes.add(node)
    return false
  })
  const lastSet = new Set(lastStarts)
  for (const node of reach.collect(lastStarts, [nodeGraph.succ])) lastSet.add(node)
  for (const node of firstSet) tier[node] = 0
  for (const node of lastSet) tier[node] = 2

  const placementConflicts: AutoSortResult['placementConflicts'] = []
  if (placementConflictNodes.size > 0) {
    const groupIds = new Set<string>()
    const modIds: number[] = []
    for (const node of placementConflictNodes) {
      for (const entry of placementGroupsOfNode.get(node) ?? []) groupIds.add(entry.groupId)
      // The "first" groups it has to load before.
      for (const below of reach.collect([node], [nodeGraph.succ])) {
        for (const entry of placementGroupsOfNode.get(below) ?? []) if (entry.placement === 'first') groupIds.add(entry.groupId)
      }
      modIds.push(...(blockMembers.get(node) ?? [node]))
    }
    modIds.sort((a, b) => a - b)
    placementConflicts.push({ groupIds: [...groupIds], modIds: modIds.slice(0, MAX_LISTED).map((m) => order[m]) })
  }

  // ── 5. Ordering ────────────────────────────────────────────────────────────
  const nodes: number[] = []
  for (let i = 0; i < n; i++) if (isNode(i)) nodes.push(i)

  const expand = (nodeOrder: number[]): number[] => nodeOrder.flatMap((node) => blockOrder.get(node) ?? [node])

  const kahn = (succ: number[][], pred: number[][], forward: boolean): number[] => {
    const remaining = new Int32Array(n)
    // Forward builds from the top: lowest tier, then earliest position, first.
    // Backward builds from the bottom: highest tier, then latest position.
    const heap = forward
      ? new Heap((a, b) => (tier[a] !== tier[b] ? tier[a] < tier[b] : a < b))
      : new Heap((a, b) => (tier[a] !== tier[b] ? tier[a] > tier[b] : a > b))
    const next = forward ? succ : pred
    const prev = forward ? pred : succ
    for (const node of nodes) {
      remaining[node] = prev[node].length
      if (remaining[node] === 0) heap.push(node)
    }
    const result: number[] = []
    while (heap.size > 0) {
      const node = heap.pop()
      result.push(node)
      for (const other of next[node]) {
        if (--remaining[other] === 0) heap.push(other)
      }
    }
    if (!forward) result.reverse()
    return result
  }

  // Unrelated mods weigh far more than constrained ones: they never count as moved.
  const constrained = new Uint8Array(n)
  const markConstrained = () => {
    for (let i = 0; i < n; i++) {
      if (depSucc[i].length || depPred[i].length || grpSucc[i].length || grpPred[i].length) constrained[i] = 1
      if (blockMembers.has(nodeOf[i]) || tier[nodeOf[i]] !== 1) constrained[i] = 1
    }
  }
  markConstrained()
  const UNRELATED_WEIGHT = n + 1

  const evaluate = (modOrder: number[]): Variant => {
    const weights = modOrder.map((m) => (constrained[m] ? 1 : UNRELATED_WEIGHT))
    const keptIndices = heaviestIncreasing(modOrder, weights)
    const kept = new Set<number>()
    keptIndices.forEach((i) => kept.add(modOrder[i]))
    return { order: modOrder, kept }
  }
  const movedCount = (variant: Variant) => variant.order.length - variant.kept.size

  const sortOnce = (succ: number[][], pred: number[][]): Variant => {
    const forward = evaluate(expand(kahn(succ, pred, true)))
    if (movedCount(forward) === 0) return forward
    const backward = evaluate(expand(kahn(succ, pred, false)))
    return movedCount(backward) <= movedCount(forward) ? backward : forward
  }

  // Conflict winners: keep the later mod of each pair later, unless a stronger rule says otherwise.
  const pairs: Array<[number, number]> = [] // [loser, winner] by the current order
  const seenPairs = new Set<string>()
  for (const pair of input.conflictPairs ?? []) {
    const a = position.get(pair?.[0])
    const b = position.get(pair?.[1])
    if (a === undefined || b === undefined || a === b) continue
    const loser = Math.min(a, b)
    const winner = Math.max(a, b)
    const key = `${loser}:${winner}`
    if (seenPairs.has(key)) continue
    seenPairs.add(key)
    pairs.push([loser, winner])
  }

  const winSucc: number[][] = Array.from({ length: n }, () => []) // node level
  const winPred: number[][] = Array.from({ length: n }, () => [])
  const acceptedWinners: Array<[number, number]> = [] // mod level [loser, winner]
  const decided = new Set<string>()
  const winnerCauses = new Map<string, ConstraintCause | 'placement'>()
  const combined = () => {
    const succ = nodeGraph.succ.map((list, i) => (winSucc[i].length ? [...list, ...winSucc[i]] : list))
    const pred = nodeGraph.pred.map((list, i) => (winPred[i].length ? [...list, ...winPred[i]] : list))
    return { succ, pred }
  }

  let graph = combined()
  let best = sortOnce(graph.succ, graph.pred)
  for (let round = 0; round < MAX_WINNER_ROUNDS && pairs.length > 0; round++) {
    const at = new Int32Array(n)
    best.order.forEach((m, i) => { at[m] = i })
    let added = 0
    for (const [loser, winner] of pairs) {
      const key = `${loser}:${winner}`
      if (decided.has(key) || at[loser] < at[winner]) continue
      decided.add(key)
      const u = nodeOf[loser]
      const v = nodeOf[winner]
      if (u === v) continue
      if (tier[u] > tier[v]) {
        winnerCauses.set(key, 'placement')
        continue
      }
      if (reach.reaches(v, u, [graph.succ])) {
        winnerCauses.set(key, reach.reaches(v, u, [depNodeGraph.succ]) ? 'dependency' : 'group')
        continue
      }
      winSucc[u].push(v)
      winPred[v].push(u)
      acceptedWinners.push([loser, winner])
      constrained[loser] = 1
      constrained[winner] = 1
      added++
      graph = combined()
    }
    if (added === 0) break
    best = sortOnce(graph.succ, graph.pred)
  }
  // Weigh the final order with every winner rule counted as a constraint.
  best = evaluate(best.order)

  // ── 6. Report ──────────────────────────────────────────────────────────────
  const finalOrder = best.order
  const finalAt = new Int32Array(n)
  finalOrder.forEach((m, i) => { finalAt[m] = i })
  const moved = new Set<number>()
  for (const m of finalOrder) if (!best.kept.has(m)) moved.add(m)

  const winnersChanged: AutoSortResult['winnersChanged'] = []
  for (const [loser, winner] of pairs) {
    if (finalAt[loser] < finalAt[winner]) continue
    winnersChanged.push({
      previousWinner: order[winner],
      newWinner: order[loser],
      cause: winnerCauses.get(`${loser}:${winner}`) ?? 'dependency',
    })
  }

  const groupEdgesOf = new Map<number, Array<{ partner: number; groupId: string; violated: boolean }>>()
  for (const edge of groupEdges) {
    const violated = edge.from > edge.to
    for (const [self, partner] of [[edge.from, edge.to], [edge.to, edge.from]] as const) {
      const list = groupEdgesOf.get(self)
      const entry = { partner, groupId: edge.groupId, violated }
      if (list) list.push(entry)
      else groupEdgesOf.set(self, [entry])
    }
  }
  const winnersOf = new Map<number, Array<{ partner: number; isWinner: boolean }>>()
  for (const [loser, winner] of acceptedWinners) {
    for (const [self, partner, isWinner] of [[winner, loser, true], [loser, winner, false]] as const) {
      const list = winnersOf.get(self)
      const entry = { partner, isWinner }
      if (list) list.push(entry)
      else winnersOf.set(self, [entry])
    }
  }
  const blockWasApart = new Map<number, boolean>()
  for (const [node, members] of blockMembers) {
    const sorted = [...members].sort((a, b) => a - b)
    blockWasApart.set(node, sorted[sorted.length - 1] - sorted[0] !== sorted.length - 1)
  }

  const reasonsFor = (m: number): AutoSortReason[] => {
    const reasons: AutoSortReason[] = []
    const relevant = (partner: number, violated: boolean) => violated || moved.has(partner)
    for (const r of depPred[m]) if (relevant(r, r > m)) reasons.push({ kind: 'requires', modId: order[r] })
    for (const d of depSucc[m]) if (relevant(d, m > d)) reasons.push({ kind: 'requiredBy', modId: order[d] })
    const groupsSeen = new Set<string>()
    for (const edge of groupEdgesOf.get(m) ?? []) {
      if (groupsSeen.has(edge.groupId) || !relevant(edge.partner, edge.violated)) continue
      groupsSeen.add(edge.groupId)
      reasons.push({ kind: 'groupOrder', groupId: edge.groupId })
    }
    const node = nodeOf[m]
    if (blockMembers.has(node) && blockWasApart.get(node)) {
      for (const groupId of blockGroups.get(node) ?? []) reasons.push({ kind: 'together', groupId })
    }
    if (tier[node] !== 1) {
      for (const entry of placementGroupsOfNode.get(node) ?? []) {
        if ((entry.placement === 'first') === (tier[node] === 0)) reasons.push({ kind: 'placement', groupId: entry.groupId, placement: entry.placement })
      }
    }
    for (const entry of winnersOf.get(m) ?? []) {
      if (!moved.has(entry.partner)) continue
      reasons.push(entry.isWinner ? { kind: 'winner', over: order[entry.partner] } : { kind: 'keepsWinner', winner: order[entry.partner] })
    }
    return reasons
  }

  const moves: AutoSortMove[] = []
  for (const m of finalOrder) {
    if (!moved.has(m)) continue
    moves.push({ modId: order[m], from: m + 1, to: finalAt[m] + 1, reasons: reasonsFor(m) })
  }

  return {
    order: finalOrder.map((m) => order[m]),
    moves,
    constraints: {
      dependencies: dependencyCount,
      groupOrder: groupEdges.length,
      together: blockMembers.size,
      placement: placementCount,
      winners: acceptedWinners.length,
    },
    cycles: cycles.map((cycle) => cycle.map((m) => order[m])),
    groupOrderConflicts,
    splitGroups,
    placementConflicts,
    winnersChanged,
    missing,
  }
}

/** Whether the sort had any rule to apply at all (dependencies, groups or placements). */
export function hasSortRules(result: AutoSortResult): boolean {
  const c = result.constraints
  return c.dependencies + c.groupOrder + c.together + c.placement > 0
}

/** Whether something could not be satisfied and the preview should say so. */
export function hasSortIssues(result: AutoSortResult): boolean {
  return (
    result.cycles.length > 0 ||
    result.groupOrderConflicts.length > 0 ||
    result.splitGroups.length > 0 ||
    result.placementConflicts.length > 0 ||
    result.winnersChanged.length > 0
  )
}
