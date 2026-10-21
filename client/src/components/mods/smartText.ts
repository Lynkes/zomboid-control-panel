import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  LoadOrderPlan,
  ModHealth,
  ModHealthFix,
  ModHealthIssue,
  LoadOrderPlanUnsatisfied,
  LoadOrderPlanWarning,
  ModInsight,
  ModKind,
  SmartConstraintReason,
  SmartReason,
} from '@/lib/api'

/** The kinds that get a chip (content and unknown say nothing useful). */
export const SHOWN_KINDS: readonly ModKind[] = ['library', 'framework', 'map', 'translation', 'patch', 'tweak', 'ui']

export function isShownKind(kind: ModKind | undefined | null): kind is ModKind {
  return !!kind && SHOWN_KINDS.includes(kind)
}

const listOf = (values: readonly string[], max = 4) =>
  values.length > max ? `${values.slice(0, max).join(', ')} +${values.length - max}` : values.join(', ')

/**
 * Plain-language text for everything the planner and the classifier say:
 * reasons (why a mod is where it is), kinds, problems the plan could not
 * meet. `name` turns a mod ID into what the user sees; `groupName` a group ID.
 */
export function useSmartText(name: (modId: string) => string, groupName: (groupId: string, fallback?: string) => string) {
  const { t } = useTranslation('modsSmart')

  const ruleName = useCallback(
    (reason: SmartConstraintReason | 'groupPlacement' | string) => t(`ruleName.${reason}`, { defaultValue: reason }),
    [t],
  )

  const reasonText = useCallback(
    (reason: SmartReason): string => {
      const p = reason.params ?? {}
      const other = p.other ? name(p.other) : ''
      const group = p.group !== undefined ? groupName(p.group, p.groupName) : (p.groupName ?? '')
      const side = p.relation === 'before' ? 'before' : 'after'
      switch (reason.code) {
        case 'require':
          return p.via ? t(`reason.requireVia_${side}`, { other, via: name(p.via) }) : t(`reason.require_${side}`, { other })
        case 'rule':
        case 'loadAfter':
        case 'loadBefore':
        case 'steamRequired':
        case 'patch':
        case 'conflictWinner':
          return t(`reason.${reason.code === 'loadBefore' ? 'loadAfter' : reason.code}_${side}`, { other })
        case 'groupOrder':
          return t(`reason.groupOrder_${side}`, { other, group })
        case 'keepTogether':
          return t('reason.keepTogether', { group })
        case 'groupPlacement':
          return t(p.placement === 'first' ? 'reason.placementFirst' : 'reason.placementLast', { group })
        case 'tier':
          return t(`reason.tier${Math.min(4, Math.max(0, p.tier ?? 2))}`)
        case 'displaced':
        default:
          return t('reason.displaced')
      }
    },
    [t, name, groupName],
  )

  const kindLabel = useCallback((kind: ModKind) => t(`kind.${kind}`), [t])

  const kindReasonText = useCallback(
    (reason: ModInsight['kindReasons'][number]): string => {
      const p = (reason.params ?? {}) as Record<string, unknown>
      const targets = Array.isArray(p.targets) ? listOf((p.targets as string[]).map(name)) : ''
      const folders = Array.isArray(p.folders) ? listOf(p.folders as string[]) : ''
      return t(`kindReason.${reason.code}`, {
        defaultValue: t('kindReason.noSignal'),
        count: typeof p.count === 'number' ? p.count : typeof p.files === 'number' ? p.files : 0,
        files: typeof p.files === 'number' ? p.files : 0,
        tag: typeof p.tag === 'string' ? p.tag : '',
        targets,
        folders,
      })
    },
    [t, name],
  )

  const unsatisfiedText = useCallback(
    (entry: LoadOrderPlanUnsatisfied): string => {
      const values = { before: name(entry.before), after: name(entry.after), rule: ruleName(entry.reason), by: entry.by ? ruleName(entry.by) : '' }
      if (entry.why === 'missingMod') return t('problem.missingMod', values)
      if (entry.why === 'cycle') return t('problem.cycle', values)
      return t('problem.conflictsWithHarder', values)
    },
    [t, name, ruleName],
  )

  const cycleText = useCallback(
    (cycle: LoadOrderPlan['cycles'][number]): string => {
      const mods = listOf(cycle.mods.map(name), 6)
      if (cycle.gameCrash) return t('problem.loopCrash', { mods })
      return t('problem.loop', {
        mods,
        rule: ruleName(cycle.droppedEdge.reason),
        before: name(cycle.droppedEdge.before),
        after: name(cycle.droppedEdge.after),
      })
    },
    [t, name, ruleName],
  )

  const warningText = useCallback(
    (warning: LoadOrderPlanWarning): string => {
      switch (warning.code) {
        case 'keepTogetherBroken':
          return t('problem.keepTogetherBroken', { group: groupName(warning.params.group, warning.params.groupName), mods: listOf(warning.params.mods.map(name)) })
        case 'placementConflict':
          return t('problem.placementConflict', { groups: listOf(warning.params.groups.map((g) => groupName(g))), mods: listOf(warning.params.mods.map(name)) })
        case 'inTwoKeepTogetherGroups':
          return t('problem.inTwoGroups', { mod: name(warning.params.modId), group: groupName(warning.params.group), other: groupName(warning.params.otherGroup) })
        default:
          return ''
      }
    },
    [t, name, groupName],
  )

  const winnerChangedText = useCallback(
    (entry: LoadOrderPlan['winnersChanged'][number]): string =>
      t(entry.why === 'cycle' ? 'problem.winnerLoop' : 'problem.winnerChanged', {
        newWinner: name(entry.newWinner),
        previousWinner: name(entry.previousWinner),
        by: entry.by ? ruleName(entry.by) : ruleName('rule'),
      }),
    [t, name, ruleName],
  )

  const implicitText = useCallback(
    (entry: LoadOrderPlan['implicit'][number]): string =>
      t('problem.implicit', { mod: name(entry.modId), requiredBy: listOf(entry.requiredBy.map(name), 3), count: entry.requiredBy.length }),
    [t, name],
  )

  return useMemo(
    () => ({ t, ruleName, reasonText, kindLabel, kindReasonText, unsatisfiedText, cycleText, warningText, winnerChangedText, implicitText }),
    [t, ruleName, reasonText, kindLabel, kindReasonText, unsatisfiedText, cycleText, warningText, winnerChangedText, implicitText],
  )
}

export type SmartText = ReturnType<typeof useSmartText>

export const AGE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

/** "3 hr. ago" in the formatting locale; null for a missing or invalid time. */
export function formatAge(iso: string | null | undefined, locale: string, now = Date.now()): string | null {
  const time = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(time)) return null
  const elapsed = Math.max(0, now - time)
  let format: Intl.RelativeTimeFormat
  try {
    format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
  } catch {
    format = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' })
  }
  for (const [unit, ms] of AGE_UNITS) {
    if (elapsed >= ms) return format.format(-Math.floor(elapsed / ms), unit)
  }
  return format.format(0, 'minute')
}


/** The health issue (and its add fix) for a missing required Workshop item, if the check found one. */
export function missingRequirementFix(health: ModHealth | null | undefined, workshopId: string): { issue: ModHealthIssue; fix: ModHealthFix } | null {
  for (const issue of health?.issues ?? []) {
    if (issue.kind !== 'requiredWorkshopItemMissing' || issue.params?.workshopId !== workshopId) continue
    const fix = issue.fixes.find((f) => f.action === 'addWorkshopItems')
    if (fix) return { issue, fix }
  }
  return null
}

