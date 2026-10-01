import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, GraduationCap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import type { CharacterPerk, CharacterSkillDelta, CharacterSkills as CharacterSkillsData } from '@/lib/characterApi'
import { categoryLabel, makeCollator, perkLabel, sortByLabel } from '@/lib/characterLabels'
import { cn } from '@/lib/utils'
import { formatNumber, formatShortTime } from './characterFormat'

const MAX_LEVEL = 10

// perk.boost is the game's XP-rate tier (XPBoostMap stores min(3, the level
// the character started the skill at)), not a starting level. The vanilla
// skill tooltip shows it the same way: 1, 2, 3 -> +75%, +100%, +125% XP.
// Fitness and Strength always start at 5 or more, so theirs is always 3 and
// says nothing: passive skills don't show it.
const XP_BOOST_PERCENT: Record<number, number> = { 1: 75, 2: 100, 3: 125 }

function xpProgress(perk: CharacterPerk): number | undefined {
  if (typeof perk.level !== 'number') return undefined
  if (perk.level >= MAX_LEVEL) return 100
  if (typeof perk.xp !== 'number' || typeof perk.levelXp !== 'number' || typeof perk.nextLevelXp !== 'number') return undefined
  const span = perk.nextLevelXp - perk.levelXp
  if (!(span > 0)) return undefined
  return Math.max(0, Math.min(100, ((perk.xp - perk.levelXp) / span) * 100))
}

function Pips({ level, label }: { level: number; label: string }) {
  return (
    <span role="img" aria-label={label} className="flex shrink-0 items-center gap-0.5">
      {Array.from({ length: MAX_LEVEL }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={cn('h-2 w-2 rounded-[2px]', i < level ? 'bg-primary' : 'bg-muted-foreground/20')}
        />
      ))}
    </span>
  )
}

function SkillRow({ perk, gain }: { perk: CharacterPerk; gain?: { levels: number; since: string } }) {
  const { t, i18n } = useTranslation('players')
  const { t: tPz } = useTranslation('pzCharacter')
  const language = i18n.language
  const level = typeof perk.level === 'number' ? Math.max(0, Math.min(MAX_LEVEL, perk.level)) : 0
  const progress = xpProgress(perk)
  const boostPercent = !perk.passive && typeof perk.boost === 'number' ? XP_BOOST_PERCENT[perk.boost] : undefined
  return (
    <li className="space-y-1 py-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 truncate text-sm">{perkLabel(tPz, perk)}</span>
        {perk.passive && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            {t('character.skills.passive')}
          </Badge>
        )}
        {gain && gain.levels > 0 && (
          <Badge variant="outline" className="border-primary/40 bg-primary/10 px-1.5 py-0 text-[10px] font-mono tabular-nums text-primary">
            {t('character.skills.since', { levels: gain.levels, time: formatShortTime(gain.since, language) })}
          </Badge>
        )}
        <Pips level={level} label={t('character.skills.levelAria', { level })} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {progress !== undefined && (
          <Progress value={progress} aria-label={t('character.skills.xpAria')} className="h-1 w-32 bg-muted/60" />
        )}
        {typeof perk.xp === 'number' && (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground/85">
            {level < MAX_LEVEL && typeof perk.nextLevelXp === 'number'
              ? t('character.skills.xpProgress', {
                  xp: formatNumber(perk.xp, language),
                  next: formatNumber(perk.nextLevelXp, language),
                })
              : t('character.skills.xpMaxed', { xp: formatNumber(perk.xp, language) })}
          </span>
        )}
        {boostPercent !== undefined && (
          <span className="text-[11px] text-muted-foreground">{t('character.skills.xpBoost', { percent: boostPercent })}</span>
        )}
        {typeof perk.multiplier === 'number' && perk.multiplier > 1 && (
          <span className="text-[11px] text-muted-foreground">
            {t('character.skills.bookMultiplier', { multiplier: formatNumber(perk.multiplier, language, 1) })}
          </span>
        )}
      </div>
    </li>
  )
}

export function CharacterSkills({
  skills,
  skillDelta,
  sectionError,
}: {
  skills: CharacterSkillsData
  skillDelta: CharacterSkillDelta | null
  sectionError?: string
}) {
  const { t, i18n } = useTranslation('players')
  const { t: tPz } = useTranslation('pzCharacter')
  const collator = useMemo(() => makeCollator(i18n.language), [i18n.language])
  const [showUntrained, setShowUntrained] = useState(false)

  const gains = useMemo(() => {
    const map = new Map<string, { levels: number; since: string }>()
    for (const change of skillDelta?.perks ?? []) {
      if (change.toLevel > change.fromLevel) map.set(change.id, { levels: change.toLevel - change.fromLevel, since: skillDelta!.since })
    }
    return map
  }, [skillDelta])

  const groups = useMemo(() => {
    const byParent = new Map<string, CharacterPerk[]>()
    for (const perk of skills.perks) {
      const parent = perk.parent ?? ''
      const list = byParent.get(parent)
      if (list) list.push(perk)
      else byParent.set(parent, [perk])
    }
    const known = new Map(skills.categories.map((c) => [c.id, c]))
    const categories = [...byParent.keys()].map((id) => known.get(id) ?? { id, name: id || undefined })
    return sortByLabel(categories, (c) => categoryLabel(tPz, c), collator).map((category) => ({
      category,
      perks: sortByLabel(byParent.get(category.id) ?? [], (p) => perkLabel(tPz, p), collator),
    }))
  }, [skills, tPz, collator])

  const isTrained = (perk: CharacterPerk) => (typeof perk.level === 'number' && perk.level > 0) || (typeof perk.xp === 'number' && perk.xp > 0)
  const untrainedCount = skills.perks.filter((perk) => !isTrained(perk)).length

  return (
    <section className="space-y-3" aria-labelledby="character-skills-heading">
      <h3 id="character-skills-heading" className="flex items-center gap-2 text-sm font-medium">
        <GraduationCap className="h-4 w-4 text-primary" aria-hidden="true" />
        {t('character.skills.title')}
      </h3>
      {sectionError && <p className="text-xs text-muted-foreground">{t('character.state.sectionFailed', { reason: sectionError })}</p>}
      {typeof skills.failed === 'number' && skills.failed > 0 && (
        <p className="text-xs text-muted-foreground">{t('character.skills.failed', { number: skills.failed })}</p>
      )}
      {skills.perks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('character.skills.none')}</p>
      ) : (
        <div className="grid gap-x-6 gap-y-3 lg:grid-cols-2">
          {groups.map(({ category, perks }) => {
            const visible = showUntrained ? perks : perks.filter(isTrained)
            if (visible.length === 0) return null
            return (
              <div key={category.id || 'none'} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {categoryLabel(tPz, category)}
                </p>
                <ul className="divide-y divide-border/40">
                  {visible.map((perk) => (
                    <SkillRow key={perk.id} perk={perk} gain={gains.get(perk.id)} />
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}
      {untrainedCount > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2 text-xs text-muted-foreground"
          aria-expanded={showUntrained}
          onClick={() => setShowUntrained((value) => !value)}
        >
          {showUntrained ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden="true" />}
          {showUntrained ? t('character.skills.hideUntrained') : t('character.skills.showUntrained', { number: untrainedCount })}
        </Button>
      )}
    </section>
  )
}
