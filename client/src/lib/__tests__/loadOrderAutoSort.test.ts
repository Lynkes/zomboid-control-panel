import { describe, expect, it } from 'vitest'
import { autoSortLoadOrder, hasSortIssues, hasSortRules, type AutoSortGroup, type AutoSortInput } from '../loadOrderAutoSort'

const requires = (entries: Record<string, string[]>) => new Map(Object.entries(entries))
const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`)
// Seeds per property; `AUTOSORT_SEEDS=5000 npx vitest run <this file>` for a long run.
const SEEDS = Number(process.env.AUTOSORT_SEEDS ?? 250)

// Deterministic PRNG (mulberry32), so a failing property names its seed.
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T,>(random: () => number, list: readonly T[]) => list[Math.floor(random() * list.length)]
function shuffle<T>(random: () => number, list: readonly T[]): T[] {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

describe('autoSortLoadOrder: dependencies', () => {
  it('leaves an order without rules untouched', () => {
    const result = autoSortLoadOrder({ order: ['B', 'A', 'C'] })
    expect(result.order).toEqual(['B', 'A', 'C'])
    expect(result.moves).toEqual([])
    expect(hasSortRules(result)).toBe(false)
  })

  it('moves a library appended at the end up to its first dependent: one move, not one per dependent', () => {
    const result = autoSortLoadOrder({
      order: ['M1', 'a', 'b', 'c', 'd', 'M5', 'Lib'],
      requires: requires({ M1: ['Lib'], M5: ['Lib'] }),
    })
    expect(result.order).toEqual(['Lib', 'M1', 'a', 'b', 'c', 'd', 'M5'])
    expect(result.moves).toEqual([
      { modId: 'Lib', from: 7, to: 1, reasons: [{ kind: 'requiredBy', modId: 'M1' }, { kind: 'requiredBy', modId: 'M5' }] },
    ])
  })

  it('moves a dependent placed above its library with a single move', () => {
    const result = autoSortLoadOrder({
      order: ['Overhaul', 'A', 'B', 'BaseLibrary', 'C'],
      requires: requires({ Overhaul: ['BaseLibrary'] }),
    })
    expect(result.moves).toHaveLength(1)
    expect(result.order.indexOf('BaseLibrary')).toBeLessThan(result.order.indexOf('Overhaul'))
    // Unrelated mods keep their order.
    expect(result.order.filter((id) => ['A', 'B', 'C'].includes(id))).toEqual(['A', 'B', 'C'])
  })

  it('explains a move by the requirement it now loads after', () => {
    const result = autoSortLoadOrder({ order: ['Patch', 'Core'], requires: requires({ Patch: ['Core'] }) })
    expect(result.order).toEqual(['Core', 'Patch'])
    expect(result.moves).toHaveLength(1)
    const [move] = result.moves
    expect(move.reasons).toContainEqual(move.modId === 'Core' ? { kind: 'requiredBy', modId: 'Patch' } : { kind: 'requires', modId: 'Core' })
  })

  it('reports a dependency cycle and still enforces everything around it', () => {
    const result = autoSortLoadOrder({
      order: ['Downstream', 'A', 'B', 'Lib'],
      requires: requires({ A: ['B'], B: ['A'], Downstream: ['A'] }),
    })
    expect(result.cycles).toEqual([['A', 'B']])
    expect(result.order.indexOf('A')).toBeLessThan(result.order.indexOf('Downstream'))
    expect(hasSortIssues(result)).toBe(true)
  })

  it('reports requirements that are not enabled, without failing', () => {
    const result = autoSortLoadOrder({ order: ['A'], requires: requires({ A: ['Missing', 'Missing'] }) })
    expect(result.missing).toEqual([{ modId: 'A', requires: 'Missing' }])
    expect(result.order).toEqual(['A'])
  })

  it('resolves forks and case like the missing-dependency report does', () => {
    const result = autoSortLoadOrder({
      order: ['User', 'tchernolib_B42'],
      requires: requires({ User: ['TchernoLib'] }),
    })
    expect(result.order).toEqual(['tchernolib_B42', 'User'])
  })

  it('counts a repeated mod ID once', () => {
    const result = autoSortLoadOrder({ order: ['A', 'B', 'A'], requires: requires({ A: ['B'] }) })
    expect(result.order).toEqual(['B', 'A'])
  })
})

describe('autoSortLoadOrder: groups', () => {
  const ki5: AutoSortGroup = { id: 'ki5', modIds: ['KI5Lib', 'KI5Core', 'KI5AddOn', 'KI5Fix'] }

  it('keeps every group in its own order, moving as few mods as possible', () => {
    const result = autoSortLoadOrder({ order: ['KI5Core', 'X', 'KI5Lib', 'Y', 'KI5AddOn', 'KI5Fix'], groups: [ki5] })
    expect(result.order.filter((id) => id.startsWith('KI5'))).toEqual(['KI5Lib', 'KI5Core', 'KI5AddOn', 'KI5Fix'])
    expect(result.moves).toHaveLength(1)
    expect(result.moves[0].reasons).toContainEqual({ kind: 'groupOrder', groupId: 'ki5' })
  })

  it('a keep-together group becomes one block at its first member, the mods in between follow it', () => {
    const result = autoSortLoadOrder({
      order: ['A', 'KI5Lib', 'B', 'KI5Core', 'C', 'KI5AddOn', 'D', 'KI5Fix', 'E'],
      groups: [{ ...ki5, keepTogether: true }],
    })
    expect(result.order).toEqual(['A', 'KI5Lib', 'KI5Core', 'KI5AddOn', 'KI5Fix', 'B', 'C', 'D', 'E'])
    expect(result.constraints.together).toBe(1)
    const moved = result.moves.map((move) => move.modId)
    expect(moved).toEqual(['KI5Core', 'KI5AddOn', 'KI5Fix'])
    for (const move of result.moves) expect(move.reasons).toContainEqual({ kind: 'together', groupId: 'ki5' })
  })

  it('a block is one node: a mod that needs one member loads after the whole block', () => {
    const result = autoSortLoadOrder({
      order: ['User', 'A', 'KI5Lib', 'KI5Core'],
      requires: requires({ User: ['KI5Lib'] }),
      groups: [{ id: 'g', modIds: ['KI5Lib', 'KI5Core'], keepTogether: true }],
    })
    // One move (User) beats moving the two-mod block.
    expect(result.order).toEqual(['A', 'KI5Lib', 'KI5Core', 'User'])
    expect(result.moves.map((move) => move.modId)).toEqual(['User'])
  })

  it('reports a keep-together group that a dependency splits, and keeps the dependency', () => {
    const result = autoSortLoadOrder({
      order: ['G1', 'Mid', 'G2'],
      requires: requires({ Mid: ['G1'], G2: ['Mid'] }),
      groups: [{ id: 'g', modIds: ['G1', 'G2'], keepTogether: true }],
    })
    expect(result.splitGroups).toEqual([{ groupIds: ['g'], between: ['Mid'] }])
    expect(result.order).toEqual(['G1', 'Mid', 'G2'])
  })

  it('a dependency wins over a group order that contradicts it, and says so', () => {
    const result = autoSortLoadOrder({
      order: ['AddOn', 'Lib'],
      requires: requires({ AddOn: ['Lib'] }),
      groups: [{ id: 'g', modIds: ['AddOn', 'Lib'] }],
    })
    expect(result.order).toEqual(['Lib', 'AddOn'])
    expect(result.groupOrderConflicts).toEqual([{ groupId: 'g', before: 'AddOn', after: 'Lib', cause: 'dependency' }])
  })

  it('two groups that contradict each other: the first listed wins, the other is reported', () => {
    const result = autoSortLoadOrder({
      order: ['B', 'A'],
      groups: [{ id: 'one', modIds: ['A', 'B'] }, { id: 'two', modIds: ['B', 'A'] }],
    })
    expect(result.order).toEqual(['A', 'B'])
    expect(result.groupOrderConflicts).toEqual([{ groupId: 'two', before: 'B', after: 'A', cause: 'group' }])
  })

  it('ignores group members that are not in the load order', () => {
    const result = autoSortLoadOrder({ order: ['KI5Core', 'KI5Lib'], groups: [ki5] })
    expect(result.order).toEqual(['KI5Lib', 'KI5Core'])
  })
})

describe('autoSortLoadOrder: placement', () => {
  it('a "first" group loads before everything else, with what it requires', () => {
    const result = autoSortLoadOrder({
      order: ['A', 'B', 'Needed', 'Fw1', 'C', 'Fw2'],
      requires: requires({ Fw2: ['Needed'] }),
      groups: [{ id: 'fw', modIds: ['Fw1', 'Fw2'], placement: 'first' }],
    })
    expect(result.order.slice(0, 3).sort()).toEqual(['Fw1', 'Fw2', 'Needed'])
    expect(result.order.indexOf('Needed')).toBeLessThan(result.order.indexOf('Fw2'))
    expect(result.order.slice(3)).toEqual(['A', 'B', 'C'])
    const fw1 = result.moves.find((move) => move.modId === 'Fw1')
    expect(fw1?.reasons).toContainEqual({ kind: 'placement', groupId: 'fw', placement: 'first' })
  })

  it('a "last" group loads after everything else, with what requires it', () => {
    const result = autoSortLoadOrder({
      order: ['Fix1', 'A', 'NeedsFix', 'B', 'Fix2', 'C'],
      requires: requires({ NeedsFix: ['Fix1'] }),
      groups: [{ id: 'fixes', modIds: ['Fix1', 'Fix2'], placement: 'last' }],
    })
    expect(result.order.slice(0, 3)).toEqual(['A', 'B', 'C'])
    expect(result.order.slice(3).sort()).toEqual(['Fix1', 'Fix2', 'NeedsFix'])
    expect(result.order.indexOf('Fix1')).toBeLessThan(result.order.indexOf('NeedsFix'))
  })

  it('a "last" mod that a "first" mod requires loads first, and the conflict is reported', () => {
    const result = autoSortLoadOrder({
      order: ['A', 'Early', 'Late'],
      requires: requires({ Early: ['Late'] }),
      groups: [
        { id: 'first', modIds: ['Early'], placement: 'first' },
        { id: 'last', modIds: ['Late'], placement: 'last' },
      ],
    })
    expect(result.order).toEqual(['Late', 'Early', 'A'])
    expect(result.placementConflicts).toEqual([{ groupIds: ['last', 'first'], modIds: ['Late'] }])
  })
})

describe('autoSortLoadOrder: conflict winners', () => {
  it('keeps the current winner of a file conflict while moving a mod for a dependency', () => {
    // Patch needs Lib (at the end). Patch currently beats Rival (loads after it):
    // moving Lib up keeps that, moving Patch to the end would too, but nothing may
    // put Patch before Rival.
    const result = autoSortLoadOrder({
      order: ['Rival', 'Patch', 'X', 'Lib'],
      requires: requires({ Patch: ['Lib'] }),
      conflictPairs: [['Rival', 'Patch']],
    })
    expect(result.order.indexOf('Rival')).toBeLessThan(result.order.indexOf('Patch'))
    expect(result.order.indexOf('Lib')).toBeLessThan(result.order.indexOf('Patch'))
    expect(result.winnersChanged).toEqual([])
  })

  it('keeps a winner by moving its loser along', () => {
    // Lib has to load before User. Lib loads after Other today, so Lib wins
    // their file conflict: pulling Lib up alone would hand the win to Other.
    const result = autoSortLoadOrder({
      order: ['User', 'Other', 'Lib'],
      requires: requires({ User: ['Lib'] }),
      conflictPairs: [['Other', 'Lib']],
    })
    expect(result.order).toEqual(['Other', 'Lib', 'User'])
    expect(result.winnersChanged).toEqual([])
  })

  it('reports a winner that a dependency forces to change', () => {
    const result = autoSortLoadOrder({
      order: ['Base', 'Addon'],
      requires: requires({ Base: ['Addon'] }),
      conflictPairs: [['Base', 'Addon']],
    })
    expect(result.order).toEqual(['Addon', 'Base'])
    expect(result.winnersChanged).toEqual([{ previousWinner: 'Addon', newWinner: 'Base', cause: 'dependency' }])
  })

  it('reports a winner that a "last" placement changes', () => {
    const result = autoSortLoadOrder({
      order: ['Fix', 'Content'],
      groups: [{ id: 'fixes', modIds: ['Fix'], placement: 'last' }],
      conflictPairs: [['Fix', 'Content']],
    })
    expect(result.order).toEqual(['Content', 'Fix'])
    expect(result.winnersChanged).toEqual([{ previousWinner: 'Content', newWinner: 'Fix', cause: 'placement' }])
  })
})

// ── Property tests ───────────────────────────────────────────────────────────

interface Scenario {
  input: AutoSortInput
  target: string[]
}

/**
 * A scenario every rule of which can be met: a hidden target order T, rules
 * read off T (dependencies point forward in T, group orders are T's order,
 * keep-together groups are runs of T, "first" groups sit in T's front third
 * and "last" groups in its back third), and a shuffled current order.
 */
function satisfiableScenario(seed: number): Scenario {
  const random = rng(seed)
  const count = 8 + Math.floor(random() * 40)
  const target = ids('m', count)
  const front = Math.floor(count / 3)
  const back = count - Math.floor(count / 3)
  const deps = new Map<string, string[]>()
  const edgeCount = Math.floor(random() * count * 1.2)
  for (let e = 0; e < edgeCount; e++) {
    const i = Math.floor(random() * count)
    const j = Math.floor(random() * count)
    if (i === j) continue
    // A dependency always loads earlier in T than the mod requiring it.
    const [a, b] = i < j ? [i, j] : [j, i]
    const list = deps.get(target[b]) ?? []
    list.push(target[a])
    deps.set(target[b], list)
  }
  const groups: AutoSortGroup[] = []
  const used = new Set<string>()
  const groupCount = Math.floor(random() * 5)
  for (let g = 0; g < groupCount; g++) {
    const keepTogether = random() < 0.4
    if (keepTogether) {
      // A run of T inside one third, not touching another block.
      const third = Math.floor(random() * 3)
      const [lo, hi] = third === 0 ? [0, front] : third === 1 ? [front, back] : [back, count]
      if (hi - lo < 2) continue
      const start = lo + Math.floor(random() * (hi - lo - 1))
      const length = 2 + Math.floor(random() * Math.min(4, hi - start - 1))
      const members = target.slice(start, Math.min(hi, start + length))
      if (members.some((m) => used.has(m))) continue
      members.forEach((m) => used.add(m))
      groups.push({ id: `kt${g}`, modIds: members, keepTogether: true })
    } else {
      const members = target.filter(() => random() < 0.15)
      if (members.length < 2) continue
      groups.push({ id: `g${g}`, modIds: members })
    }
  }
  // Placement groups: members of the front (first) or back (last) third only.
  if (random() < 0.6) {
    const members = target.slice(0, front).filter((m) => !used.has(m) && random() < 0.4)
    if (members.length > 0) groups.push({ id: 'first', modIds: members, placement: 'first' })
  }
  if (random() < 0.6) {
    const members = target.slice(back).filter((m) => !used.has(m) && random() < 0.4)
    if (members.length > 0) groups.push({ id: 'last', modIds: members, placement: 'last' })
  }
  // What a "first" mod needs sits earlier in T (so in the front third) and what
  // needs a "last" mod sits later (the back third): every placement can hold.
  return { input: { order: shuffle(random, target), requires: deps, groups }, target }
}

function satisfiedEverywhere(input: AutoSortInput, order: string[]) {
  const at = new Map(order.map((id, i) => [id, i]))
  for (const [modId, list] of input.requires ?? []) {
    for (const dep of list) expect(at.get(dep)!, `${dep} before ${modId}`).toBeLessThan(at.get(modId)!)
  }
  for (const group of input.groups ?? []) {
    const positions = group.modIds.map((id) => at.get(id)!).filter((p) => p !== undefined)
    expect(positions, `group ${group.id} order`).toEqual([...positions].sort((a, b) => a - b))
    if (group.keepTogether && positions.length > 1) {
      expect(Math.max(...positions) - Math.min(...positions), `group ${group.id} together`).toBe(positions.length - 1)
    }
  }
}

/** Ancestors (dependencies and group orders) of `seeds`, with a keep-together block counting as one. */
function closure(input: AutoSortInput, seeds: string[], direction: 'up' | 'down'): Set<string> {
  const edges: Array<[string, string]> = []
  for (const [modId, list] of input.requires ?? []) for (const dep of list) edges.push([dep, modId])
  for (const group of input.groups ?? []) {
    for (let i = 0; i + 1 < group.modIds.length; i++) edges.push([group.modIds[i], group.modIds[i + 1]])
  }
  const blockOf = new Map<string, string[]>()
  for (const group of input.groups ?? []) {
    if (!group.keepTogether) continue
    for (const id of group.modIds) blockOf.set(id, [...group.modIds])
  }
  const found = new Set<string>()
  const stack = [...seeds]
  const visit = (id: string) => {
    for (const member of blockOf.get(id) ?? [id]) {
      if (found.has(member)) continue
      found.add(member)
      stack.push(member)
    }
  }
  seeds.forEach(visit)
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const [from, to] of edges) {
      if (direction === 'up' && to === id) visit(from)
      if (direction === 'down' && from === id) visit(to)
    }
  }
  return found
}

describe('autoSortLoadOrder: properties', () => {
  it('meets every rule when the rules can all be met, and reports nothing', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { input } = satisfiableScenario(seed)
      const result = autoSortLoadOrder(input)
      expect(result.order.slice().sort(), `seed ${seed}: same mods`).toEqual([...input.order].sort())
      satisfiedEverywhere(input, result.order)
      expect(result.cycles, `seed ${seed}`).toEqual([])
      expect(result.groupOrderConflicts, `seed ${seed}`).toEqual([])
      expect(result.splitGroups, `seed ${seed}`).toEqual([])
      expect(result.placementConflicts, `seed ${seed}`).toEqual([])

      // Placement: what "first" needs is ahead of everything else; what needs "last" is behind it.
      const at = new Map(result.order.map((id, i) => [id, i]))
      const first = input.groups?.find((g) => g.placement === 'first')
      const last = input.groups?.find((g) => g.placement === 'last')
      const front = first ? closure(input, [...first.modIds], 'up') : new Set<string>()
      const rear = last ? closure(input, [...last.modIds], 'down') : new Set<string>()
      for (const id of result.order) {
        for (const f of front) if (!front.has(id)) expect(at.get(f)!, `seed ${seed}: ${f} first, before ${id}`).toBeLessThan(at.get(id)!)
        for (const l of rear) if (!rear.has(id)) expect(at.get(l)!, `seed ${seed}: ${l} last, after ${id}`).toBeGreaterThan(at.get(id)!)
      }
    }
  })

  it('is idempotent: sorting the result again moves nothing', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { input } = satisfiableScenario(seed)
      const random = rng(seed * 7)
      const pairs = Array.from({ length: Math.floor(random() * 10) }, () => [pick(random, input.order), pick(random, input.order)] as [string, string])
      const first = autoSortLoadOrder({ ...input, conflictPairs: pairs })
      const again = autoSortLoadOrder({ ...input, order: first.order, conflictPairs: pairs })
      expect(again.order, `seed ${seed}`).toEqual(first.order)
      expect(again.moves, `seed ${seed}`).toEqual([])
    }
  })

  it('never moves or reorders a mod no rule mentions', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { input } = satisfiableScenario(seed)
      const random = rng(seed * 13)
      const pairs = Array.from({ length: Math.floor(random() * 6) }, () => [pick(random, input.order), pick(random, input.order)] as [string, string])
      const mentioned = new Set<string>()
      for (const [modId, list] of input.requires ?? []) {
        if (list.length > 0) mentioned.add(modId)
        list.forEach((id) => mentioned.add(id))
      }
      for (const group of input.groups ?? []) group.modIds.forEach((id) => mentioned.add(id))
      for (const [a, b] of pairs) { mentioned.add(a); mentioned.add(b) }
      const result = autoSortLoadOrder({ ...input, conflictPairs: pairs })
      const unrelatedBefore = input.order.filter((id) => !mentioned.has(id))
      const unrelatedAfter = result.order.filter((id) => !mentioned.has(id))
      expect(unrelatedAfter, `seed ${seed}`).toEqual(unrelatedBefore)
      for (const move of result.moves) expect(mentioned.has(move.modId), `seed ${seed}: ${move.modId} moved`).toBe(true)
    }
  })

  it('keeps every conflict winner it does not report as changed', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { input } = satisfiableScenario(seed)
      const random = rng(seed * 31)
      const pairs = Array.from({ length: 1 + Math.floor(random() * 12) }, () => [pick(random, input.order), pick(random, input.order)] as [string, string])
      const result = autoSortLoadOrder({ ...input, conflictPairs: pairs })
      const before = new Map(input.order.map((id, i) => [id, i]))
      const after = new Map(result.order.map((id, i) => [id, i]))
      const changed = new Set(result.winnersChanged.map((w) => `${w.newWinner}>${w.previousWinner}`))
      for (const [a, b] of pairs) {
        if (a === b) continue
        const [loser, winner] = before.get(a)! < before.get(b)! ? [a, b] : [b, a]
        const kept = after.get(loser)! < after.get(winner)!
        expect(kept || changed.has(`${loser}>${winner}`), `seed ${seed}: ${winner} over ${loser}`).toBe(true)
      }
      // Every reported change really happened: the new winner loads later now.
      for (const w of result.winnersChanged) expect(after.get(w.newWinner)!, `seed ${seed}`).toBeGreaterThan(after.get(w.previousWinner)!)
    }
  })

  it('with contradictory rules: never throws, keeps every dependency outside a reported cycle, and stays idempotent', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = rng(seed * 101)
      const count = 4 + Math.floor(random() * 30)
      const order = ids('x', count)
      const deps = new Map<string, string[]>()
      for (let e = 0; e < count; e++) {
        const a = pick(random, order)
        const b = pick(random, order)
        if (a === b) continue
        deps.set(b, [...(deps.get(b) ?? []), a])
      }
      const groups: AutoSortGroup[] = Array.from({ length: Math.floor(random() * 4) }, (_, g) => ({
        id: `g${g}`,
        modIds: shuffle(random, order).slice(0, 2 + Math.floor(random() * 5)),
        keepTogether: random() < 0.4,
        placement: random() < 0.3 ? (random() < 0.5 ? 'first' : 'last') : null,
      }))
      const pairs = Array.from({ length: Math.floor(random() * 8) }, () => [pick(random, order), pick(random, order)] as [string, string])
      const input: AutoSortInput = { order: shuffle(random, order), requires: deps, groups, conflictPairs: pairs }
      const result = autoSortLoadOrder(input)
      expect(result.order.slice().sort()).toEqual([...order].sort())
      const at = new Map(result.order.map((id, i) => [id, i]))
      const inCycle = new Set(result.cycles.flat())
      const cycleIndex = new Map<string, number>()
      result.cycles.forEach((cycle, i) => cycle.forEach((id) => cycleIndex.set(id, i)))
      for (const [modId, list] of deps) {
        for (const dep of list) {
          if (inCycle.has(dep) && cycleIndex.get(dep) === cycleIndex.get(modId)) continue
          expect(at.get(dep)!, `seed ${seed}: ${dep} before ${modId}`).toBeLessThan(at.get(modId)!)
        }
      }
      const again = autoSortLoadOrder({ ...input, order: result.order })
      expect(again.order, `seed ${seed}: idempotent`).toEqual(result.order)
    }
  })

  it('sorts 600 mods with dense rules quickly', () => {
    const random = rng(600)
    const order = ids('mod', 600)
    const deps = new Map<string, string[]>()
    for (let i = 0; i < 700; i++) {
      const a = Math.floor(random() * 600)
      const b = Math.floor(random() * 600)
      if (a === b) continue
      const [lo, hi] = a < b ? [a, b] : [b, a]
      deps.set(order[hi], [...(deps.get(order[hi]) ?? []), order[lo]])
    }
    const groups: AutoSortGroup[] = Array.from({ length: 40 }, (_, g) => ({
      id: `g${g}`,
      modIds: order.slice(g * 15, g * 15 + 6),
      keepTogether: g % 3 === 0,
      placement: g === 1 ? 'first' : g === 39 ? 'last' : null,
    }))
    const pairs = Array.from({ length: 400 }, () => [pick(random, order), pick(random, order)] as [string, string])
    const input: AutoSortInput = { order: shuffle(random, order), requires: deps, groups, conflictPairs: pairs }
    const started = performance.now()
    const result = autoSortLoadOrder(input)
    const elapsed = performance.now() - started
    expect(result.order).toHaveLength(600)
    // Generous for a loaded CI machine; it takes a few milliseconds locally.
    expect(elapsed).toBeLessThan(1500)
  })
})
