import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { AlertTriangle, CircleCheck, Info, ScanSearch } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { CharacterHint, CharacterHintEvidence, CharacterHintThresholds } from '@/lib/characterApi'
import { perkLabel } from '@/lib/characterLabels'
import { cn } from '@/lib/utils'
import { formatNumber, formatShortTime, formatWhen } from './characterFormat'

// "Worth a look": numbers that stand out for a character, each with how it's
// decided, the usual innocent reasons, and any panel action that explains
// it. Strong hints use the warning callout, mild ones the neutral one; never
// the destructive red. The copy lives in players.json character.hints.

function numberParam(value: unknown, language: string, digits = 1): string {
  return typeof value === 'number' ? formatNumber(value, language, digits) : ''
}

function hintCopy(hint: CharacterHint, thresholds: CharacterHintThresholds, t: TFunction, language: string) {
  const p = hint.params
  const base = `character.hints.items.${hint.id}`
  let detailValues: Record<string, string> = {}
  let ruleValues: Record<string, string | number> = {}
  switch (hint.id) {
    case 'skillsAheadOfTime':
      detailValues = {
        advanced: numberParam(p.advanced, language),
        allowed: numberParam(p.allowed, language),
        hours: numberParam(p.hours, language),
        floor: String(thresholds.advancedLevelFloor),
      }
      ruleValues = {
        floor: thresholds.advancedLevelFloor,
        perHour: thresholds.advancedLevelsPerHour,
        grace: thresholds.advancedLevelsGrace,
        xpScale: numberParam(p.xpScale, language),
      }
      break
    case 'manyMaxedSkills':
      detailValues = { maxed: numberParam(p.maxed, language, 0), nonPassive: numberParam(p.nonPassive, language, 0) }
      ruleValues = {
        minCount: thresholds.maxedSkillsCount,
        hours: thresholds.maxedSkillsWithinHours,
        share: Math.round(thresholds.maxedSkillsShareAlways * 100),
        strong: thresholds.maxedSkillsStrongCount,
      }
      break
    case 'skillJump':
      detailValues = { total: numberParam(p.total, language, 0), minutes: numberParam(p.minutes, language, 0) }
      ruleValues = {
        onePerk: thresholds.jumpLevelsOnePerk,
        minLevel: thresholds.jumpMinTargetLevel,
        passive: thresholds.jumpLevelsPassive,
        totalLevels: thresholds.jumpTotalLevels,
        window: thresholds.jumpWindowMinutes,
        sinceTime: typeof p.since === 'string' ? formatShortTime(p.since, language) : '',
      }
      break
    case 'unusualQuantity':
      detailValues = { threshold: formatNumber(thresholds.unusualQuantity, language) }
      ruleValues = { threshold: formatNumber(thresholds.unusualQuantity, language) }
      break
    case 'overCapacity':
      detailValues = { carried: numberParam(p.carried, language), max: numberParam(p.max, language) }
      ruleValues = { factor: thresholds.overCapacityFactor }
      break
    default:
      break
  }
  return {
    title: t(`${base}.title`),
    detail: t(`${base}.detail`, detailValues),
    rule: t(`${base}.rule`, ruleValues),
    innocent: t(`${base}.innocent`),
  }
}

function Evidence({ item }: { item: CharacterHintEvidence }) {
  const { t, i18n } = useTranslation('players')
  const { t: tPz } = useTranslation('pzCharacter')
  const language = i18n.language
  const d = item.detail ?? {}
  if (item.kind === 'perk') {
    const label = perkLabel(tPz, { id: item.ref })
    const extra =
      typeof d.from === 'number' && typeof d.to === 'number'
        ? t('character.hints.evidence.jump', { from: d.from, to: d.to })
        : typeof d.level === 'number'
          ? typeof d.start === 'number' && d.start > 0
            ? t('character.hints.evidence.levelFromStart', { level: d.level, start: d.start })
            : t('character.hints.evidence.level', { level: d.level })
          : ''
    return (
      <li>
        <span className="text-foreground/90">{label}</span>
        {extra && <span className="text-muted-foreground"> · {extra}</span>}
      </li>
    )
  }
  if (item.kind === 'flag') {
    return <li className="text-foreground/90">{t(`character.summary.flags.${item.ref}`, { defaultValue: item.ref })}</li>
  }
  return (
    <li className="flex flex-wrap items-center gap-x-1.5">
      <span className="text-foreground/90">{d.name ?? item.ref}</span>
      <bdi dir="ltr" className="font-mono text-[11px] text-muted-foreground/80">{item.ref}</bdi>
      {typeof d.qty === 'number' && (
        <span className="font-mono tabular-nums text-muted-foreground">{t('character.hints.evidence.qty', { qty: formatNumber(d.qty, language) })}</span>
      )}
      {d.givenAt && (
        <span className="text-muted-foreground">· {t('character.inventory.givenViaPanel', { when: formatWhen(d.givenAt, language) })}</span>
      )}
    </li>
  )
}

function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs text-muted-foreground underline-offset-2">
          {label}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-1 text-xs leading-relaxed text-muted-foreground">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function HintCard({
  hint,
  thresholds,
  inventoryAt,
}: {
  hint: CharacterHint
  thresholds: CharacterHintThresholds
  inventoryAt?: string | null
}) {
  const { t, i18n } = useTranslation('players')
  const language = i18n.language
  const copy = hintCopy(hint, thresholds, t, language)
  const explained = Array.isArray(hint.explainedBy) && hint.explainedBy.length > 0
  const strong = hint.weight === 'strong' && !explained
  const Icon = explained ? CircleCheck : strong ? AlertTriangle : Info
  return (
    <Alert
      variant="default"
      data-hint-id={hint.id}
      data-hint-weight={hint.weight}
      className={cn(strong ? 'border-warning/40 bg-warning/10' : 'border-border/60 bg-muted/40')}
    >
      <Icon className={cn('h-4 w-4', strong ? 'text-warning' : 'text-muted-foreground')} aria-hidden="true" />
      <AlertTitle className={cn('flex flex-wrap items-center gap-1.5', strong && 'text-warning')}>
        {copy.title}
        <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          {t(`character.hints.weights.${hint.weight}`)}
        </Badge>
        {hint.staff && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            {t('character.hints.staff')}
          </Badge>
        )}
      </AlertTitle>
      <AlertDescription className="space-y-1.5 text-foreground/85">
        <p>{copy.detail}</p>
        {hint.source === 'cached' && inventoryAt && (
          <p className="text-xs text-muted-foreground">{t('character.hints.fromCached', { when: formatWhen(inventoryAt, language) })}</p>
        )}
        {hint.params.canSpawnItems === true && <p className="text-xs text-muted-foreground">{t('character.hints.canSpawnItems')}</p>}
        {hint.evidence.length > 0 && <ul className="space-y-0.5 text-xs">{hint.evidence.map((item, i) => <Evidence key={`${item.kind}.${item.ref}.${i}`} item={item} />)}</ul>}
        {explained && (
          <div className="space-y-0.5 text-xs">
            <p className="font-medium text-foreground/85">{t('character.hints.explained')}</p>
            <ul className="space-y-0.5 text-muted-foreground">
              {hint.explainedBy!.map((entry, i) => (
                <li key={`${entry.at}.${i}`}>
                  {t('character.hints.explainedEntry', {
                    action: t(`character.hints.actions.${entry.action}`, { defaultValue: entry.action }),
                    details: entry.details,
                    when: formatWhen(entry.at, language),
                  })}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <Disclosure label={t('character.hints.howDecided')}>{copy.rule}</Disclosure>
          <Disclosure label={t('character.hints.innocentReasons')}>{copy.innocent}</Disclosure>
        </div>
      </AlertDescription>
    </Alert>
  )
}

export function CharacterHints({
  hints,
  hintSource,
  thresholds,
  savedAt,
  inventoryAt,
}: {
  hints: CharacterHint[]
  hintSource: 'live' | 'cached' | null
  thresholds: CharacterHintThresholds
  savedAt?: string | null
  /** Live hints whose items come from an inventory read this long ago say so, each. */
  inventoryAt?: string | null
}) {
  const { t, i18n } = useTranslation('players')
  return (
    <section className="space-y-3" aria-labelledby="character-hints-heading">
      <div className="space-y-0.5">
        <h3 id="character-hints-heading" className="flex items-center gap-2 text-sm font-medium">
          <ScanSearch className="h-4 w-4 text-primary" aria-hidden="true" />
          {t('character.hints.title')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('character.hints.subtitle')}</p>
        {hintSource === 'cached' && savedAt && (
          <p className="text-xs text-muted-foreground">{t('character.hints.fromCached', { when: formatWhen(savedAt, i18n.language) })}</p>
        )}
      </div>
      {hints.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('character.hints.none')}</p>
      ) : (
        <div className="space-y-2">
          {hints.map((hint) => (
            <HintCard key={hint.id} hint={hint} thresholds={thresholds} inventoryAt={hintSource === 'live' ? inventoryAt : null} />
          ))}
        </div>
      )}
    </section>
  )
}
