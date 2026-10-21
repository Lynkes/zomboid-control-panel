// "Problems found" fixes: which existing panel action a finding's fix runs,
// what "Fix all safe issues" offers, the run (stops at the first error) and
// its Undo. Every action goes through the route that already does it (Mods
// health, the mod list, the server record, server power), with that route's
// own checks; nothing here edits a file directly.

import { ApiError, type ModHealth, type ModHealthFix, type ModHealthFixResult, type ModHealthIssue, type ServerProblem, type ServerProblemFix } from '@/lib/api'
import { isSafeFix } from '@/components/mods/healthText'

export type ActionFix = Extract<ServerProblemFix, { type: 'action' }>
export type LinkFix = Extract<ServerProblemFix, { type: 'link' }>

export const isActionFix = (fix: ServerProblemFix): fix is ActionFix => fix.type === 'action'
export const isLinkFix = (fix: ServerProblemFix): fix is LinkFix => fix.type === 'link'

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export interface ResolvedHealthFix {
  issue: ModHealthIssue
  fix: ModHealthFix
  /** A fix the Mods page's "Fix everything" applies without asking. */
  safe: boolean
}

/**
 * The live Mods health issue a finding's "modsHealthFix" points at (one of
 * its kinds, naming its mod or Workshop item) and that issue's fix: a safe
 * one first. Null when Mods health has nothing for it (any more).
 */
export function resolveHealthFix(fix: ActionFix, health: ModHealth | null): ResolvedHealthFix | null {
  if (fix.action !== 'modsHealthFix' || !health || !Array.isArray(health.issues)) return null
  const kinds = Array.isArray(fix.params.kinds) ? (fix.params.kinds as unknown[]).filter((k): k is string => typeof k === 'string') : []
  const modId = str(fix.params.modId)
  const workshopId = str(fix.params.workshopId)
  if (!modId && !workshopId) return null
  for (const issue of health.issues) {
    if (!kinds.includes(issue.kind)) continue
    // A missing required mod is the issue's params.missing (its modIds are
    // the mods that need it).
    const names =
      (modId && (issue.modIds.includes(modId) || issue.params.missing === modId || issue.params.modId === modId)) ||
      (workshopId && (issue.workshopIds.includes(workshopId) || issue.params.workshopId === workshopId))
    if (!names) continue
    const usable = issue.fixes.filter((f) => f.action !== 'applyPlan')
    const safe = usable.find(isSafeFix)
    if (safe) return { issue, fix: safe, safe: true }
    if (usable[0]) return { issue, fix: usable[0], safe: false }
  }
  return null
}

export type FixAllItem =
  | { id: string; type: 'healthFix'; finding: ServerProblem; issue: ModHealthIssue; fix: ModHealthFix }
  | { id: string; type: 'raiseMemory'; finding: ServerProblem; serverId: string | number; currentGb: number; nextGb: number }

export interface FixAllPreview {
  items: FixAllItem[]
  /** Findings whose fixes ask first (disable a mod, restart): left to their own buttons. */
  needsDecision: number
}

/** The safe fixes "Fix all safe issues" offers, one per thing it changes. */
export function buildFixAllPreview(
  findings: readonly ServerProblem[],
  health: ModHealth | null,
  can: (capability: string) => boolean,
): FixAllPreview {
  const items: FixAllItem[] = []
  const seen = new Set<string>()
  let needsDecision = 0
  for (const finding of findings) {
    let offered = false
    for (const fix of finding.fixes) {
      if (!isActionFix(fix) || !fix.safe || !can(fix.capability)) continue
      if (fix.action === 'modsHealthFix') {
        const resolved = resolveHealthFix(fix, health)
        if (!resolved || !resolved.safe) continue
        const id = `health:${resolved.issue.id}:${resolved.fix.action}`
        if (!seen.has(id)) {
          seen.add(id)
          items.push({ id, type: 'healthFix', finding, issue: resolved.issue, fix: resolved.fix })
        }
        offered = true
        break
      }
      if (fix.action === 'raiseMemory') {
        const serverId = fix.params.serverId as string | number | undefined
        const currentGb = num(fix.params.currentGb)
        const nextGb = num(fix.params.nextGb)
        if (serverId === undefined || serverId === null || currentGb === null || nextGb === null || nextGb <= currentGb) continue
        const id = `memory:${serverId}`
        if (!seen.has(id)) {
          seen.add(id)
          items.push({ id, type: 'raiseMemory', finding, serverId, currentGb, nextGb })
        }
        offered = true
        break
      }
    }
    if (!offered && finding.fixes.some((fix) => isActionFix(fix) && !fix.safe && can(fix.capability))) needsDecision++
  }
  return { items, needsDecision }
}

export interface FixAllApi {
  snapshot: () => Promise<{ snapshotId: string }>
  applyHealthFix: (issue: ModHealthIssue, fix: ModHealthFix) => Promise<ModHealthFixResult>
  setMaxMemory: (serverId: string | number, gb: number) => Promise<unknown>
}

export interface FixAllUndo {
  /** The mods autofix snapshot taken before the first mod list change. */
  snapshotId: string | null
  /** Memory values to put back, in the order they were changed. */
  memory: { serverId: string | number; previousGb: number }[]
}

export interface FixAllRunResult {
  applied: number
  /** Solved meanwhile (Mods health no longer has that problem). */
  skipped: number
  failed: { item: FixAllItem | null; error: unknown } | null
  undo: FixAllUndo
}

const SKIPPABLE = new Set(['MODS_HEALTH_ISSUE_GONE', 'MODS_HEALTH_FIX_NOT_OFFERED'])

export const hasUndo = (undo: FixAllUndo | null): boolean => !!undo && (!!undo.snapshotId || undo.memory.length > 0)

/**
 * Applies `items` one by one and stops at the first error. The mod list is
 * kept first (when a mod fix is checked) so Undo can put it back whatever
 * happens; a memory change is undone by setting the old value again.
 */
export async function runFixAll(
  items: readonly FixAllItem[],
  api: FixAllApi,
  onStep: (index: number, item: FixAllItem | null) => void,
): Promise<FixAllRunResult> {
  const result: FixAllRunResult = { applied: 0, skipped: 0, failed: null, undo: { snapshotId: null, memory: [] } }
  if (items.some((item) => item.type === 'healthFix')) {
    onStep(-1, null)
    try {
      result.undo.snapshotId = (await api.snapshot()).snapshotId
    } catch (error) {
      result.failed = { item: null, error }
      return result
    }
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    onStep(i, item)
    try {
      if (item.type === 'healthFix') {
        const outcome = await api.applyHealthFix(item.issue, item.fix)
        if (outcome.applied) result.applied++
        else result.skipped++
      } else {
        await api.setMaxMemory(item.serverId, item.nextGb)
        result.undo.memory.push({ serverId: item.serverId, previousGb: item.currentGb })
        result.applied++
      }
    } catch (error) {
      if (item.type === 'healthFix' && error instanceof ApiError && error.code && SKIPPABLE.has(error.code)) {
        result.skipped++
        continue
      }
      result.failed = { item, error }
      return result
    }
  }
  return result
}

export interface UndoApi {
  restore: (snapshotId: string) => Promise<unknown>
  setMaxMemory: (serverId: string | number, gb: number) => Promise<unknown>
}

/** Undo of a run (or of one fix): the mod list back, then each memory value, newest first. */
export async function undoFixAll(undo: FixAllUndo, api: UndoApi): Promise<void> {
  if (undo.snapshotId) await api.restore(undo.snapshotId)
  for (const change of [...undo.memory].reverse()) await api.setMaxMemory(change.serverId, change.previousGb)
}

export const SEVERITY_ORDER = ['critical', 'warning', 'info'] as const
export const CATEGORY_ORDER = ['mods', 'server', 'network', 'panel'] as const

/** Findings by category, in the page's order, each list as the server sorted it. */
export function groupFindings(findings: readonly ServerProblem[]): { category: (typeof CATEGORY_ORDER)[number]; findings: ServerProblem[] }[] {
  return CATEGORY_ORDER.map((category) => ({ category, findings: findings.filter((f) => f.category === category) })).filter((g) => g.findings.length > 0)
}
