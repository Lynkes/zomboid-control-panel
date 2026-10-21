// Demo mode (VITE_DEMO_MODE) answers for smart sort v2's routes
// (server/routes/modsSmart.js): the plan, insights, the health check with its
// fixes and the order rules, so the public demo shows them working. A small
// planner of its own: each mod placed right after what it must follow
// (require=, group order, pinned rules, patches), groups placed first/last,
// optionally by kind; the fewest moves explain the change.

import type {
  LoadOrderPlan,
  LoadOrderPlanMove,
  ModHealth,
  ModHealthIssue,
  ModInsight,
  ModKind,
  ModOrderRule,
  SmartConfidence,
  SmartConstraintReason,
  SmartReason,
} from './api'

export interface DemoSmartItem {
  workshopId: string
  name: string
  mods: Array<{ id: string; name?: string; require?: string[] }>
  active?: boolean
}

export interface DemoSmartGroup {
  id: string
  name: string
  modIds: string[]
  keepTogether: boolean
  placement?: 'first' | 'last' | null
}

export interface DemoSmartContext {
  getOrder: () => string[]
  setOrder: (order: string[]) => void
  items: readonly DemoSmartItem[]
  getGroups: () => readonly DemoSmartGroup[]
}

type Kinded = { kind: ModKind; confidence: SmartConfidence; reasons: ModInsight['kindReasons']; patchOf?: string[] }

// What the demo classifier "found" for some mods; the rest are content.
const DEMO_KINDS: Record<string, Kinded> = {
  TchernoLib: { kind: 'library', confidence: 'high', reasons: [{ code: 'libraryName' }, { code: 'dependents', params: { count: 2 } }] },
  KI5Library: { kind: 'library', confidence: 'high', reasons: [{ code: 'manyDependents', params: { count: 4 } }] },
  ModOptions: { kind: 'framework', confidence: 'high', reasons: [{ code: 'steamTag', params: { tag: 'Framework' } }, { code: 'dependents', params: { count: 2 } }] },
  RavenCreek: { kind: 'map', confidence: 'high', reasons: [{ code: 'mapFolder', params: { folders: ['RavenCreek'] } }] },
  BedfordFalls: { kind: 'map', confidence: 'high', reasons: [{ code: 'mapFolder', params: { folders: ['BedfordFalls'] } }] },
  FortRockRidge: { kind: 'map', confidence: 'high', reasons: [{ code: 'mapFolder', params: { folders: ['FortRockRidge'] } }] },
  Pitstop: { kind: 'map', confidence: 'high', reasons: [{ code: 'mapFolder', params: { folders: ['Pitstop'] } }] },
  BetterSorting_AuthZ_Compat: { kind: 'patch', confidence: 'high', reasons: [{ code: 'namedForTarget', params: { targets: ['BetterSorting', 'AuthenticZLite'] } }], patchOf: ['BetterSorting', 'AuthenticZLite'] },
  KI5Fixes: { kind: 'patch', confidence: 'medium', reasons: [{ code: 'patchNamed', params: { targets: ['KI5Library'] } }], patchOf: ['KI5Library'] },
  truemusic_retro: { kind: 'patch', confidence: 'medium', reasons: [{ code: 'patchNamed', params: { targets: ['truemusic'] } }], patchOf: ['truemusic'] },
  ClothingFixPatch: { kind: 'tweak', confidence: 'low', reasons: [{ code: 'tweakName' }] },
  CommonSense: { kind: 'tweak', confidence: 'medium', reasons: [{ code: 'steamTag', params: { tag: 'QoL' } }] },
  MapLegendUI: { kind: 'ui', confidence: 'medium', reasons: [{ code: 'steamTag', params: { tag: 'Interface' } }] },
  MinimalDisplayBars: { kind: 'ui', confidence: 'medium', reasons: [{ code: 'steamTag', params: { tag: 'Interface' } }] },
  ErisMinimap: { kind: 'ui', confidence: 'low', reasons: [{ code: 'clientLuaOnly' }, { code: 'uiName' }] },
  AuthenticZ_ES: { kind: 'translation', confidence: 'high', reasons: [{ code: 'translationFilesOnly', params: { files: 14 } }] },
  SuperbSurvivors: { kind: 'unknown', confidence: 'low', reasons: [{ code: 'noSignal' }] },
}
const TIER: Record<ModKind, number> = { library: 0, framework: 0, map: 1, content: 1, ui: 2, unknown: 2, patch: 3, tweak: 3, translation: 4 }

const kindOf = (id: string): Kinded => DEMO_KINDS[id] ?? { kind: 'content', confidence: 'low', reasons: [{ code: 'assetsContent' }] }

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

let demoRules: ModOrderRule[] = [
  { id: 'demo-rule-1', before: 'KI5_M35A2', after: 'KI5Fixes', note: 'The fixes must win the M35A2 scripts.', source: 'conflictResolve', createdBy: 'rowan', createdAt: '2026-06-18T08:20:00.000Z' },
  { id: 'demo-rule-2', before: 'BetterSorting', after: 'BetterSorting_AuthZ_Compat', note: '', source: 'manual', createdBy: 'admin', createdAt: '2026-06-19T10:00:00.000Z' },
  { id: 'demo-rule-3', before: 'ExpandedHelicopterEvents', after: 'SuperbSurvivors', note: 'Only matters when the helicopter events are on.', source: 'healthFix', createdBy: 'admin', createdAt: '2026-06-20T21:05:00.000Z' },
]
let demoRuleSeq = demoRules.length
const fixedIssues = new Set<string>()
const demoSnapshots = new Map<string, string[]>()
let demoSnapshotSeq = 0

function steamStatus(total: number) {
  return { source: 'api' as const, fetchedAt: hoursAgo(3), stale: false, failed: false, pending: false, known: total, total }
}

function requiresOf(ctx: DemoSmartContext): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const item of ctx.items) for (const mod of item.mods) map.set(mod.id, mod.require ?? [])
  return map
}

interface Edge { before: string; after: string; reason: SmartConstraintReason; group?: string; groupName?: string; ruleId?: string; source?: 'classification' }

const STRONG: ReadonlySet<string> = new Set(['require', 'rule', 'groupOrder', 'keepTogether', 'groupPlacement', 'loadAfter'])

/** The demo plan of `order` (see the header). */
export function demoPlan(ctx: DemoSmartContext, order: string[], mode: 'minimal' | 'tiered', extraRules: ReadonlyArray<[string, string]> = []): LoadOrderPlan {
  const ids = [...new Set(order)]
  const present = new Set(ids)
  const requires = requiresOf(ctx)
  const groups = ctx.getGroups()
  const edges: Edge[] = []
  const unsatisfied: LoadOrderPlan['unsatisfied'] = []
  const key = new Set<string>()
  const add = (edge: Edge) => {
    const k = `${edge.before}>${edge.after}`
    if (!present.has(edge.before) || !present.has(edge.after) || edge.before === edge.after || key.has(k)) return
    key.add(k)
    edges.push(edge)
  }
  for (const id of ids) {
    for (const dep of requires.get(id) ?? []) {
      if (present.has(dep)) add({ before: dep, after: id, reason: 'require' })
      else unsatisfied.push({ before: dep, after: id, reason: 'require', why: 'missingMod' })
    }
  }
  for (const rule of demoRules) add({ before: rule.before, after: rule.after, reason: 'rule', ruleId: rule.id })
  extraRules.forEach(([before, after], i) => add({ before, after, reason: 'rule', ruleId: `candidate-${i}` }))
  for (const group of groups) {
    const members = group.modIds.filter((id) => present.has(id))
    for (let i = 0; i + 1 < members.length; i++) add({ before: members[i], after: members[i + 1], reason: 'groupOrder', group: group.id, groupName: group.name })
  }
  for (const id of ids) for (const target of kindOf(id).patchOf ?? []) add({ before: target, after: id, reason: 'patch', source: 'classification' })

  const preds = new Map<string, Edge[]>()
  for (const edge of edges) {
    if (!preds.has(edge.after)) preds.set(edge.after, [])
    preds.get(edge.after)!.push(edge)
  }
  const placementOf = new Map<string, { rank: number; group: DemoSmartGroup }>()
  for (const group of groups) {
    if (!group.placement) continue
    for (const id of group.modIds) if (present.has(id) && !placementOf.has(id)) placementOf.set(id, { rank: group.placement === 'first' ? 0 : 2, group })
  }
  const index = new Map(ids.map((id, i) => [id, i]))
  const base = [...ids].sort((a, b) =>
    (placementOf.get(a)?.rank ?? 1) - (placementOf.get(b)?.rank ?? 1) ||
    (mode === 'tiered' ? TIER[kindOf(a).kind] - TIER[kindOf(b).kind] : 0) ||
    index.get(a)! - index.get(b)!,
  )
  const result: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const cycles: LoadOrderPlan['cycles'] = []
  const place = (id: string, path: string[]) => {
    if (state.get(id) === 'done') return
    state.set(id, 'visiting')
    for (const edge of [...(preds.get(id) ?? [])].sort((a, b) => index.get(a.before)! - index.get(b.before)!)) {
      if (state.get(edge.before) === 'visiting') {
        const start = path.indexOf(edge.before)
        cycles.push({ mods: [...path.slice(start), id], droppedEdge: { before: edge.before, after: edge.after, reason: edge.reason } })
        continue
      }
      place(edge.before, [...path, id])
    }
    state.set(id, 'done')
    result.push(id)
  }
  for (const id of base) place(id, [])

  const position = new Map(result.map((id, i) => [id, i]))
  const describe = (edge: Edge, modId: string): SmartReason => ({
    code: edge.reason,
    params: {
      relation: modId === edge.after ? 'after' : 'before',
      other: modId === edge.after ? edge.before : edge.after,
      ...(edge.group ? { group: edge.group, groupName: edge.groupName } : {}),
      ...(edge.ruleId ? { ruleId: edge.ruleId } : {}),
      ...(edge.source ? { source: edge.source, confidence: kindOf(edge.after).confidence } : {}),
    },
  })
  const explanations: Record<string, SmartReason[]> = Object.create(null)
  for (const edge of edges) {
    if (position.get(edge.before)! > position.get(edge.after)!) continue
    for (const id of [edge.after, edge.before]) {
      ;(explanations[id] ??= []).push(describe(edge, id))
    }
  }
  const notesFor = (id: string): SmartReason[] => {
    const notes: SmartReason[] = []
    const placed = placementOf.get(id)
    if (placed) notes.push({ code: 'groupPlacement', params: { group: placed.group.id, groupName: placed.group.name, placement: placed.group.placement ?? undefined } })
    if (mode === 'tiered') notes.push({ code: 'tier', params: { tier: TIER[kindOf(id).kind], kind: kindOf(id).kind } })
    return notes
  }
  for (const id of result) for (const note of notesFor(id)) (explanations[id] ??= []).push(note)

  // Fewest moves: keep the longest run of mods already in order.
  const seq = result.map((id) => index.get(id)!)
  const tails: number[] = []
  const tailAt: number[] = []
  const prev = new Array<number>(seq.length).fill(-1)
  seq.forEach((value, i) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < value) lo = mid + 1
      else hi = mid
    }
    tails[lo] = value
    tailAt[lo] = i
    prev[i] = lo > 0 ? tailAt[lo - 1] : -1
  })
  const kept = new Set<number>()
  for (let i = tails.length ? tailAt[tails.length - 1] : -1; i >= 0; i = prev[i]) kept.add(i)
  const moves: LoadOrderPlanMove[] = []
  result.forEach((id, to) => {
    if (kept.has(to)) return
    const reasons = [
      ...edges.filter((e) => (e.after === id || e.before === id)).filter((e) => position.get(e.before)! < position.get(e.after)!).map((e) => describe(e, id)).slice(0, 4),
      ...notesFor(id),
    ]
    if (reasons.length === 0) reasons.push({ code: 'displaced', params: {} })
    const confidence: SmartConfidence = reasons.some((r) => STRONG.has(r.code)) ? 'high' : reasons.some((r) => r.code === 'patch' || r.code === 'tier') ? 'medium' : 'low'
    moves.push({ modId: id, from: index.get(id)!, to, reasons, confidence })
  })
  return {
    order: result,
    changed: result.some((id, i) => id !== ids[i]) || ids.length !== order.length,
    moves,
    explanations,
    satisfied: edges.length - cycles.length,
    unsatisfied,
    cycles,
    winnersChanged: [],
    implicit: [],
    warnings: [],
    stats: { constraints: edges.length, hard: edges.filter((e) => e.reason !== 'patch').length, strong: edges.filter((e) => e.reason === 'patch').length, soft: ids.length, ms: 42 },
    steamStatus: steamStatus(ctx.items.length),
  }
}

export function demoInsights(ctx: DemoSmartContext) {
  const order = ctx.getOrder()
  const enabled = new Set(order)
  const requires = requiresOf(ctx)
  const requiredBy = new Map<string, string[]>()
  for (const id of order) for (const dep of requires.get(id) ?? []) if (enabled.has(dep)) requiredBy.set(dep, [...(requiredBy.get(dep) ?? []), id])
  const mods: Record<string, ModInsight> = {}
  for (const item of ctx.items) {
    if (item.active === false) continue
    for (const mod of item.mods) {
      if (!enabled.has(mod.id)) continue
      const kinded = kindOf(mod.id)
      mods[mod.id] = {
        workshopId: item.workshopId,
        source: 'workshop',
        name: mod.name ?? item.name,
        enabled: true,
        kind: kinded.kind,
        kindConfidence: kinded.confidence,
        kindReasons: kinded.reasons,
        tier: TIER[kinded.kind],
        patchOf: kinded.patchOf ?? [],
        dependents: requiredBy.get(mod.id)?.length ?? 0,
        requires: (requires.get(mod.id) ?? []).filter((dep) => enabled.has(dep)),
        requiredBy: requiredBy.get(mod.id) ?? [],
        steamTags: [],
      }
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    steamStatus: steamStatus(ctx.items.length),
    mods,
    workshopRequirements: [
      {
        workshopId: '2169435993',
        title: "Brita's Weapon Pack",
        requires: [
          { workshopId: '2392709985', title: "Tsar's Common Library 2.0", installed: true, enabled: true },
          { workshopId: '2297098490', title: 'Arsenal(26) GunFighter', installed: false, enabled: false },
        ],
      },
      {
        workshopId: '2169435928',
        title: 'Autotsar Trailers',
        requires: [
          { workshopId: '2392709985', title: "Tsar's Common Library 2.0", installed: true, enabled: true },
          { workshopId: '2875848298', title: 'Autotsar Tuning Atelier', installed: false, enabled: false },
        ],
      },
    ],
    constraints: [],
  }
}

function issue(kind: ModHealthIssue['kind'], severity: ModHealthIssue['severity'], rest: Partial<ModHealthIssue>): ModHealthIssue {
  return { id: `${kind}-${(rest.modIds?.[0] ?? rest.workshopIds?.[0] ?? kind).toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(16, '0').slice(0, 16)}`, kind, severity, modIds: [], workshopIds: [], params: {}, fixes: [], ...rest }
}

export function demoHealth(ctx: DemoSmartContext): ModHealth {
  const order = ctx.getOrder()
  const has = (id: string) => order.includes(id)
  const issues: ModHealthIssue[] = []
  if (has('Brita')) {
    issues.push(issue('requiredNotInstalled', 'critical', {
      modIds: ['Brita'],
      workshopIds: ['2169435993'],
      params: { missing: 'Arsenal(26)GunFighter', requiredBy: ['Brita'], affected: ['Brita', 'Brita_2'] },
      fixes: [{ action: 'addWorkshopItems', params: { workshopIds: ['2297098490'], modIds: ['Arsenal(26)GunFighter'], before: 'Brita' }, label: 'Add Workshop item 2297098490' }],
    }))
  }
  if (has('SuperbSurvivors')) {
    issues.push(issue('modInfoBroken', 'critical', {
      modIds: ['SuperbSurvivors'],
      workshopIds: ['2169435919'],
      params: { modId: 'SuperbSurvivors', field: 'require', entry: ' ModOptions', issue: 'whitespace', affected: ['SuperbSurvivors'] },
    }))
  }
  if (has('autotsartrailers')) {
    issues.push(issue('requiredWorkshopItemMissing', 'warning', {
      workshopIds: ['2875848298', '2169435928'],
      params: { workshopId: '2875848298', title: 'Autotsar Tuning Atelier', requiredBy: ['2169435928'], downloaded: false },
      fixes: [{ action: 'addWorkshopItems', params: { workshopIds: ['2875848298'] }, label: 'Add Workshop item 2875848298' }],
    }))
  }
  if (has('Pitstop')) {
    issues.push(issue('mapNotInMapLine', 'warning', {
      modIds: ['Pitstop'],
      workshopIds: ['2169435918'],
      params: { modId: 'Pitstop', folders: ['Pitstop'] },
      fixes: [{ action: 'addMapFolders', params: { folders: ['Pitstop'] }, label: 'Add Pitstop to Map=' }],
    }))
  }
  if (has('CommonSense') && has('BetterContainers')) {
    issues.push(issue('incompatibleEnabled', 'warning', {
      modIds: ['CommonSense', 'BetterContainers'],
      workshopIds: ['2169435905', '2169435903'],
      params: { modId: 'CommonSense', other: 'BetterContainers', declaredBy: 'CommonSense' },
      fixes: [
        { action: 'removeMods', params: { modIds: ['CommonSense'] }, label: 'Remove CommonSense from Mods=' },
        { action: 'removeMods', params: { modIds: ['BetterContainers'] }, label: 'Remove BetterContainers from Mods=' },
      ],
    }))
  }
  const plan = demoPlan(ctx, order, 'minimal')
  const real = plan.moves.filter((m) => m.reasons.some((r) => r.code !== 'displaced' && r.code !== 'tier'))
  if (real.length > 0) {
    issues.push(issue('orderProblems', 'warning', {
      modIds: real.map((m) => m.modId),
      params: { moves: real.length, changesLoading: true, sample: real.slice(0, 10).map((m) => ({ modId: m.modId, from: m.from, to: m.to, reasons: [...new Set(m.reasons.map((r) => r.code))] })) },
      fixes: [{ action: 'applyPlan', params: {}, label: 'Apply the suggested load order' }],
    }))
  }
  issues.push(issue('duplicateModId', 'warning', {
    modIds: ['AuthenticZLite'],
    workshopIds: ['2849247394', '3000000001'],
    params: { modId: 'AuthenticZLite', modIds: ['AuthenticZLite'], workshopIds: ['2849247394', '3000000001'], loads: null },
    fixes: [
      { action: 'removeWorkshopItems', params: { workshopIds: ['3000000001'], keep: '2849247394' }, label: 'Keep Workshop item 2849247394: remove 3000000001' },
      { action: 'removeWorkshopItems', params: { workshopIds: ['2849247394'], keep: '3000000001' }, label: 'Keep Workshop item 3000000001: remove 2849247394' },
    ],
  }))
  issues.push(issue('updatesAvailable', 'info', {
    workshopIds: ['2169435993', '2730000105', '2169435922'],
    params: { count: 3, items: [{ workshopId: '2169435993', title: "Brita's Weapon Pack" }, { workshopId: '2730000105', title: '[KI5] Vehicle Fixes' }, { workshopId: '2169435922', title: 'Lifestyle: Hobbies' }] },
  }))
  const shown = issues.filter((i) => !fixedIssues.has(i.id))
  const counts = { critical: 0, warning: 0, info: 0 }
  for (const i of shown) counts[i.severity]++
  return { checkedAt: new Date().toISOString(), counts, issues: shown, steamStatus: steamStatus(ctx.items.length) }
}

function demoApplyFix(ctx: DemoSmartContext, body: Record<string, unknown>) {
  const health = demoHealth(ctx)
  const found = health.issues.find((i) => i.id === body.issueId)
  if (!found) return { status: 404, payload: { error: 'This problem is gone or has changed', code: 'MODS_HEALTH_ISSUE_GONE' } }
  const fix = found.fixes.find((f) => f.action === body.action)
  if (!fix) return { status: 400, payload: { error: 'This fix is not offered for that problem', code: 'MODS_HEALTH_FIX_NOT_OFFERED' } }
  const order = ctx.getOrder()
  if (fix.action === 'removeMods') ctx.setOrder(order.filter((id) => !(fix.params.modIds ?? []).includes(id)))
  if (fix.action === 'applyPlan') ctx.setOrder(demoPlan(ctx, order, 'minimal').order)
  fixedIssues.add(found.id)
  return { status: 200, payload: { applied: true, health: demoHealth(ctx) } }
}

function demoAddRule(ctx: DemoSmartContext, body: Record<string, unknown>) {
  const before = typeof body.before === 'string' ? body.before.trim() : ''
  const after = typeof body.after === 'string' ? body.after.trim() : ''
  if (!before || !after || before === after) {
    return { status: 400, payload: { error: 'Invalid order rule: before', code: 'MODS_ORDER_RULE_INVALID', params: { field: 'before' } } }
  }
  const same = demoRules.find((r) => r.before === before && r.after === after)
  if (same) return { status: 200, payload: { rule: same, existing: true, replaced: [] } }
  const opposite = demoRules.filter((r) => r.before === after && r.after === before)
  const requiresLoop = (requiresOf(ctx).get(before) ?? []).includes(after)
  if ((opposite.length > 0 && body.replaceOpposite !== true) || requiresLoop) {
    const edge = requiresLoop ? { before: after, after: before, reason: 'require' } : { before: after, after: before, reason: 'rule', ruleId: opposite[0].id }
    return {
      status: 409,
      payload: {
        error: 'This rule would make a loop with other rules or required mods',
        code: 'MODS_ORDER_RULE_CYCLE',
        params: { count: 2 },
        details: { cycle: [before, after, before], edges: [{ before, after, reason: 'new' }, edge] },
      },
    }
  }
  const replaced = body.replaceOpposite === true ? opposite.map((r) => r.id) : []
  demoRules = demoRules.filter((r) => !replaced.includes(r.id))
  const source = body.source === 'conflictResolve' || body.source === 'healthFix' ? body.source : 'manual'
  const rule: ModOrderRule = {
    id: `demo-rule-${++demoRuleSeq}`,
    before,
    after,
    note: typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '',
    source,
    createdBy: 'admin',
    createdAt: new Date().toISOString(),
  }
  demoRules = [...demoRules, rule]
  return { status: 201, payload: { rule, existing: false, replaced } }
}

/** The answer for a smart-sort route, or null when `path` is not one. */
export function demoSmartResponse(ctx: DemoSmartContext, path: string, method: string, body: Record<string, unknown>): { status: number; payload: unknown } | null {
  if (path === '/api/mods/insights' && method === 'GET') return { status: 200, payload: demoInsights(ctx) }
  if (path === '/api/mods/health' && method === 'GET') return { status: 200, payload: demoHealth(ctx) }
  if (path === '/api/mods/health/fix' && method === 'POST') return demoApplyFix(ctx, body)
  if (path === '/api/mods/load-order/plan' && method === 'POST') {
    const order = Array.isArray(body.order) ? body.order.filter((id): id is string => typeof id === 'string') : ctx.getOrder()
    const rules = Array.isArray(body.rules)
      ? body.rules.filter((r): r is [string, string] => Array.isArray(r) && r.length === 2 && r.every((id) => typeof id === 'string'))
      : []
    return { status: 200, payload: demoPlan(ctx, order, body.mode === 'tiered' ? 'tiered' : 'minimal', rules) }
  }
  // "Fix everything": the demo keeps the order before a run for its Undo.
  if (path === '/api/mods/autofix/snapshot' && method === 'POST') {
    const snapshotId = `demo-snapshot-${++demoSnapshotSeq}`
    demoSnapshots.set(snapshotId, ctx.getOrder())
    return { status: 200, payload: { snapshotId } }
  }
  if (path === '/api/mods/autofix/restore' && method === 'POST') {
    const order = typeof body.snapshotId === 'string' ? demoSnapshots.get(body.snapshotId) : undefined
    if (!order) return { status: 404, payload: { error: 'Nothing to undo', code: 'MODS_AUTOFIX_SNAPSHOT_NOT_FOUND' } }
    demoSnapshots.delete(body.snapshotId as string)
    ctx.setOrder(order)
    fixedIssues.clear()
    return { status: 200, payload: { restored: true } }
  }
  if (path === '/api/mods/order-rules' && method === 'GET') return { status: 200, payload: { rules: demoRules, max: 2000 } }
  if (path === '/api/mods/order-rules' && method === 'POST') return demoAddRule(ctx, body)
  if (path.startsWith('/api/mods/order-rules/') && method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/mods/order-rules/'.length))
    if (!demoRules.some((r) => r.id === id)) return { status: 404, payload: { error: 'Order rule not found', code: 'MODS_ORDER_RULE_NOT_FOUND' } }
    demoRules = demoRules.filter((r) => r.id !== id)
    return { status: 200, payload: { success: true } }
  }
  return null
}

/** The suggested winners the demo conflict scan shows on its pairs (by "modA|modB"). */
export function demoConflictSuggestion(modA: string, modB: string) {
  const ruleFor = (before: string, after: string) => demoRules.find((r) => r.before === before && r.after === after)
  switch (`${modA}|${modB}`) {
    case 'Brita|AuthenticZLite':
      return { winner: 'Brita', confidence: 'medium' as const, reason: 'smallOverride' as const, alreadyWinning: false, params: { files: 12, conflicting: 8, otherFiles: 640 } }
    case 'TchernoLib|Brita':
      return { winner: 'Brita', confidence: 'high' as const, reason: 'requiresOther' as const, alreadyWinning: true }
    case 'KI5_M35A2|KI5Fixes': {
      const rule = ruleFor('KI5_M35A2', 'KI5Fixes')
      return rule
        ? { winner: 'KI5Fixes', confidence: 'high' as const, reason: 'rule' as const, alreadyWinning: true, params: { ruleId: rule.id } }
        : { winner: 'KI5Fixes', confidence: 'medium' as const, reason: 'patchOfOther' as const, alreadyWinning: true }
    }
    case 'truemusic|truemusic_retro': {
      const rule = ruleFor('truemusic', 'truemusic_retro')
      return rule
        ? { winner: 'truemusic_retro', confidence: 'high' as const, reason: 'rule' as const, alreadyWinning: false, params: { ruleId: rule.id } }
        : { winner: 'truemusic_retro', confidence: 'high' as const, reason: 'requiresOther' as const, alreadyWinning: false }
    }
    default:
      return undefined
  }
}
