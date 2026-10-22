import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModHealth, ModHealthFix, ModHealthFixAction, ModHealthIssue } from '@/lib/api'

/** Fixes that take something out of the server ini: they ask first. */
export const DESTRUCTIVE_FIX_ACTIONS: ReadonlySet<ModHealthFixAction> = new Set(['removeMods', 'removeWorkshopItems', 'removeMapFolders'])

/** Fixes that only add (or apply the suggested order): "Fix all safe issues" applies them. */
export const SAFE_FIX_ACTIONS: ReadonlySet<ModHealthFixAction> = new Set(['addMods', 'addWorkshopItems', 'addMapFolders', 'applyPlan'])

export function isDestructiveFix(fix: ModHealthFix): boolean {
  return DESTRUCTIVE_FIX_ACTIONS.has(fix.action)
}

export function isSafeFix(fix: ModHealthFix): boolean {
  return SAFE_FIX_ACTIONS.has(fix.action)
}

/** JSON with sorted keys: a fix's params, compared the way the server compares them. */
export function canonicalFixParams(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFixParams).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalFixParams(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export interface PlannedFix {
  issueId: string
  fix: ModHealthFix
  label: string
}

/** "Fix all safe issues": the first safe fix of every issue that has one, in the check's order. */
export function plannedSafeFixes(health: ModHealth | null, label: (fix: ModHealthFix) => string): PlannedFix[] {
  const planned: PlannedFix[] = []
  for (const issue of health?.issues ?? []) {
    const fix = issue.fixes.find(isSafeFix)
    if (fix) planned.push({ issueId: issue.id, fix, label: label(fix) })
  }
  return planned
}

/** Names listed in a sentence before "+N more". */
const LISTED = 5

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export interface HealthTextOptions {
  modName: (modId: string) => string | undefined
  itemTitle: (workshopId: string) => string | undefined
}

export interface HealthText {
  title: (issue: ModHealthIssue) => string
  /** The explanation, one sentence group per entry. */
  body: (issue: ModHealthIssue) => string[]
  fixLabel: (fix: ModHealthFix) => string
  /** What a destructive fix removes, one line per target (for the confirm dialog). */
  removedTargets: (fix: ModHealthFix) => string[]
  /** The confirm dialog's explanation of a destructive fix. */
  confirmDescription: (fix: ModHealthFix) => string
  /**
   * Workshop items that ship the same mods, in one sentence: which items,
   * which mods, that the server loads one copy of each and which one is not
   * defined, and to keep one item.
   */
  duplicateSentence: (workshopIds: readonly string[], modIds: readonly string[], titles?: Readonly<Record<string, unknown>>) => string
  mod: (modId: string) => string
  item: (workshopId: string, fallbackTitle?: string | null) => string
}

/**
 * Plain-language wording for the health check: a title and explanation per
 * issue kind (from its params), and each fix's label from its action and
 * params (the server's English `label` is only a fallback).
 */
export function useHealthText({ modName, itemTitle }: HealthTextOptions): HealthText {
  const { t, i18n } = useTranslation('modHealth')

  const listFormat = useMemo(() => {
    // Intl.ListFormat is ES2021: not in this project's TS lib, in every browser the panel supports.
    const ListFormat = (Intl as unknown as { ListFormat?: new (locale: string, options: object) => { format: (list: string[]) => string } }).ListFormat
    try {
      return ListFormat ? new ListFormat(i18n.language, { style: 'long', type: 'conjunction' }) : null
    } catch {
      return null
    }
  }, [i18n.language])

  const list = useCallback((names: string[]) => {
    const shown = names.slice(0, LISTED)
    if (names.length > LISTED) shown.push(t('andMore', { count: names.length - LISTED }))
    return listFormat ? listFormat.format(shown) : shown.join(', ')
  }, [listFormat, t])

  const mod = useCallback((modId: string) => modName(modId) || modId, [modName])
  const item = useCallback(
    (workshopId: string, fallbackTitle?: string | null) => itemTitle(workshopId) || fallbackTitle || workshopId,
    [itemTitle],
  )
  const mods = useCallback((ids: string[]) => list(ids.map(mod)), [list, mod])
  const items = useCallback((ids: string[]) => list(ids.map((id) => item(id))), [list, item])

  const title = useCallback((issue: ModHealthIssue) => t(`kind.${issue.kind}.title`), [t])

  const duplicateSentence = useCallback(
    (workshopIds: readonly string[], modIds: readonly string[], titles: Readonly<Record<string, unknown>> = {}) => {
      const names = list(workshopIds.map((ws) => item(ws, str(titles[ws]) || null)))
      return t(workshopIds.length > 2 ? 'duplicates.many' : 'duplicates.pair', { items: names, mods: list([...modIds]) })
    },
    [t, list, item],
  )

  const body = useCallback((issue: ModHealthIssue): string[] => {
    const p = issue.params ?? {}
    switch (issue.kind) {
      case 'requireLoop':
        return [t('kind.requireLoop.body', { mods: mods(strings(p.cycle).length ? strings(p.cycle) : issue.modIds) })]
      case 'modInfoBroken': {
        const blocker = str(p.modId) || issue.modIds[0] || ''
        const problemKey = ['emptyEntry', 'blankEntry', 'whitespace', 'semicolon'].includes(str(p.issue)) ? str(p.issue) : 'unknown'
        const lines = [t('kind.modInfoBroken.body', { mod: mod(blocker), entry: str(p.entry), problem: t(`entryIssue.${problemKey}`) })]
        const others = strings(p.affected).filter((id) => id !== blocker)
        if (others.length) lines.push(t('kind.modInfoBroken.affected', { mods: mods(others) }))
        lines.push(t('kind.modInfoBroken.hint'))
        return lines
      }
      case 'requiredNotInstalled': {
        const missing = str(p.missing)
        const lines = [t('kind.requiredNotInstalled.body', {
          missing,
          requiredBy: mods(strings(p.requiredBy).length ? strings(p.requiredBy) : issue.modIds),
          affected: mods(strings(p.affected)),
        })]
        if (str(p.caseMatch)) lines.push(t('kind.requiredNotInstalled.caseMatch', { match: str(p.caseMatch) }))
        if (p.b41Only === true) lines.push(t('kind.requiredNotInstalled.b41Only', { missing, item: item(str(p.workshopId)) }))
        return lines
      }
      case 'requiredWorkshopItemMissing':
        return [
          t('kind.requiredWorkshopItemMissing.body', { target: item(str(p.workshopId), str(p.title) || null), items: items(strings(p.requiredBy)) }),
          p.downloaded === true ? t('kind.requiredWorkshopItemMissing.downloaded') : t('kind.requiredWorkshopItemMissing.notDownloaded'),
        ]
      case 'notInstalled': {
        const lines = [t('kind.notInstalled.body', { mod: str(p.modId) || issue.modIds[0] || '' })]
        if (str(p.foundIn)) lines.push(t('kind.notInstalled.foundIn', { item: item(str(p.foundIn)) }))
        else if (typeof p.notDownloaded === 'number' && p.notDownloaded > 0) lines.push(t('kind.notInstalled.notDownloaded', { count: p.notDownloaded }))
        return lines
      }
      case 'b41Only':
        return [t('kind.b41Only.body', { mod: mod(str(p.modId) || issue.modIds[0] || ''), item: item(str(p.workshopId) || issue.workshopIds[0] || '') })]
      case 'incompatibleEnabled':
        return [t('kind.incompatibleEnabled.body', { a: mod(str(p.modId)), b: mod(str(p.other)), declaredBy: mod(str(p.declaredBy) || str(p.modId)) })]
      case 'duplicateModId': {
        const ids = strings(p.modIds).length ? strings(p.modIds) : str(p.modId) ? [str(p.modId)] : issue.modIds
        const wsIds = strings(p.workshopIds).length ? strings(p.workshopIds) : issue.workshopIds
        const titles = p.titles && typeof p.titles === 'object' ? (p.titles as Record<string, unknown>) : {}
        const loads = p.loads && typeof p.loads === 'object' ? (p.loads as { source?: unknown; workshopId?: unknown }) : null
        if (loads) {
          const from = str(loads.workshopId)
            ? item(str(loads.workshopId), str(titles[str(loads.workshopId)]) || null)
            : t(loads.source === 'staged' ? 'duplicates.sourceStaged' : 'duplicates.sourceLocal')
          return [t('duplicates.defined', { mods: list(ids), from })]
        }
        if (wsIds.length >= 2) return [duplicateSentence(wsIds, ids, titles)]
        return [t('duplicates.local', { mods: list(ids) })]
      }
      case 'mapNotInMapLine':
        return [t('kind.mapNotInMapLine.body', { mod: mod(str(p.modId)), folders: list(strings(p.folders)) })]
      case 'mapFolderWithoutMod': {
        const shippedBy = Array.isArray(p.shippedBy) ? (p.shippedBy as Array<{ workshopId?: unknown }>).map((s) => str(s?.workshopId)).filter(Boolean) : []
        return [
          t('kind.mapFolderWithoutMod.body', { folder: str(p.folder) }),
          shippedBy.length ? t('kind.mapFolderWithoutMod.shippedBy', { items: items(shippedBy) }) : t('kind.mapFolderWithoutMod.nobody'),
        ]
      }
      case 'orderProblems': {
        const count = typeof p.moves === 'number' ? p.moves : issue.modIds.length
        const lines = [p.changesLoading === true ? t('kind.orderProblems.changesLoading', { count }) : t('kind.orderProblems.tidyOnly', { count })]
        const sample = Array.isArray(p.sample) ? (p.sample as Array<{ modId?: unknown; from?: unknown; to?: unknown; reasons?: unknown }>) : []
        for (const move of sample) {
          if (typeof move?.modId !== 'string' || typeof move.from !== 'number' || typeof move.to !== 'number') continue
          const reasons = strings(move.reasons).map((code) => t(`reason.${code}`, { defaultValue: code }))
          lines.push(t('kind.orderProblems.move', { mod: mod(move.modId), from: move.from + 1, to: move.to + 1, reasons: list(reasons) }))
        }
        return lines
      }
      case 'requiredLoadedImplicitly':
        return [t('kind.requiredLoadedImplicitly.body', { mod: mod(str(p.modId) || issue.modIds[0] || ''), requiredBy: mods(strings(p.requiredBy)) })]
      case 'unusedWorkshopItem':
        return [t('kind.unusedWorkshopItem.body', { item: item(str(p.workshopId) || issue.workshopIds[0] || '', str(p.title) || null), mods: list(strings(p.modIds)) })]
      case 'updatesAvailable': {
        const count = typeof p.count === 'number' ? p.count : issue.workshopIds.length
        return [t('kind.updatesAvailable.body', { count })]
      }
      default:
        return []
    }
  }, [t, mods, mod, items, item, list, duplicateSentence])

  const fixLabel = useCallback((fix: ModHealthFix): string => {
    const p = fix.params ?? {}
    const modIds = strings(p.modIds)
    const workshopIds = strings(p.workshopIds)
    const folders = strings(p.folders)
    switch (fix.action) {
      case 'removeMods':
        return t('fix.removeMods', { mods: mods(modIds) })
      case 'addMods':
        return t('fix.addMods', { mods: mods(modIds) })
      case 'addWorkshopItems':
        return modIds.length
          ? t('fix.addWorkshopItemsAndMods', { count: workshopIds.length, items: items(workshopIds), mods: mods(modIds) })
          : t('fix.addWorkshopItems', { count: workshopIds.length, items: items(workshopIds) })
      case 'removeWorkshopItems':
        if (str(p.keep)) return t('duplicates.keep', { item: item(str(p.keep)) })
        return t('fix.removeWorkshopItems', { count: workshopIds.length, items: items(workshopIds) })
      case 'addMapFolders':
        return t('fix.addMapFolders', { folders: list(folders) })
      case 'removeMapFolders':
        return t('fix.removeMapFolders', { folders: list(folders) })
      case 'applyPlan':
        return t('fix.applyPlan')
      default:
        return fix.label
    }
  }, [t, mods, items, item, list])

  const removedTargets = useCallback((fix: ModHealthFix): string[] => {
    const p = fix.params ?? {}
    const modLine = (id: string) => (modName(id) && modName(id) !== id ? `${modName(id)} (${id})` : id)
    const itemLine = (id: string) => (itemTitle(id) ? `${itemTitle(id)} (${id})` : id)
    switch (fix.action) {
      case 'removeMods':
        return strings(p.modIds).map(modLine)
      case 'removeWorkshopItems': {
        if (!str(p.keep)) return strings(p.workshopIds).map(itemLine)
        // "Keep <item>": exactly what leaves each line of the ini.
        const lines = strings(p.workshopIds).map((id) => t('duplicates.removedItem', { item: itemLine(id) }))
        for (const id of strings(p.modIds)) lines.push(t('duplicates.removedMod', { mod: modLine(id) }))
        for (const id of strings(p.dedupeModIds)) lines.push(t('duplicates.removedRepeat', { mod: id }))
        return lines
      }
      case 'removeMapFolders':
        return strings(p.folders)
      default:
        return []
    }
  }, [modName, itemTitle, t])

  const confirmDescription = useCallback((fix: ModHealthFix): string => {
    const keep = str(fix.params?.keep)
    if (fix.action === 'removeWorkshopItems' && keep) return t('duplicates.confirmKeep', { item: item(keep) })
    return t(`confirm.${fix.action}`)
  }, [t, item])

  return { title, body, fixLabel, removedTargets, confirmDescription, duplicateSentence, mod, item }
}
