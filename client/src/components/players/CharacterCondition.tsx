import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, MapPin, Moon, Skull, Thermometer } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { HelpTip } from '@/components/HelpTip'
import { CHARACTER_STATS, type CharacterSheet, type CharacterStatName } from '@/lib/characterApi'
import { formatNumber } from './characterFormat'

// A severity bar for one stat, normalized by the stat's own range. The
// bridge sends each stat's range from CharacterStat.getMinimumValue() /
// getMaximumValue(), so no scale is guessed. goodWhenHigh: health and
// endurance; every other stat is worse the higher it goes.
export function VitalBar({
  label,
  value,
  min,
  max,
  goodWhenHigh,
}: {
  label: string
  value: number
  min: number
  max: number
  goodWhenHigh: boolean
}) {
  const span = max - min
  const ratio = span > 0 ? Math.max(0, Math.min(1, (value - min) / span)) : 0
  const pct = ratio * 100
  const severity = goodWhenHigh ? 1 - ratio : ratio
  const color =
    severity < 0.5 ? 'hsl(var(--success))'
    : severity < 0.75 ? 'hsl(var(--warning))'
    : 'hsl(var(--destructive))'
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="w-24 shrink-0 truncate font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">{label}</span>
      <div className="flex flex-1 items-center gap-1.5">
        <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-muted/60 ring-1 ring-black/20">
          <div className="h-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
        </div>
        <span className="w-9 shrink-0 text-end font-mono text-xs tabular-nums text-foreground/85">{Math.round(pct)}%</span>
      </div>
    </div>
  )
}

const GOOD_WHEN_HIGH = new Set<CharacterStatName>(['endurance'])

// An older bridge (partial sheet) sends values without ranges. Hunger,
// thirst and fatigue are 0-1 in the game (vanilla Lua compares them with
// thresholds like FATIGUE <= 0.3); nothing else is assumed.
const KNOWN_UNIT_RANGE = new Set<CharacterStatName>(['hunger', 'thirst', 'fatigue'])

export function CharacterCondition({ sheet }: { sheet: CharacterSheet }) {
  const { t, i18n } = useTranslation('players')
  const language = i18n.language
  const stats = sheet.stats ?? {}
  const health = sheet.health ?? {}
  const summary = sheet.summary ?? {}

  const bars: Array<{ key: string; label: string; value: number; min: number; max: number; goodWhenHigh: boolean }> = []
  const raw: Array<{ key: CharacterStatName; label: string; value: number }> = []
  if (typeof health.overall === 'number') {
    bars.push({ key: 'health', label: t('character.condition.health'), value: health.overall, min: 0, max: 100, goodWhenHigh: true })
  }
  for (const name of CHARACTER_STATS) {
    const stat = stats[name]
    if (!stat || typeof stat.value !== 'number') continue
    const label = t(`character.condition.${name}`)
    if (typeof stat.min === 'number' && typeof stat.max === 'number' && stat.max > stat.min) {
      bars.push({ key: name, label, value: stat.value, min: stat.min, max: stat.max, goodWhenHigh: GOOD_WHEN_HIGH.has(name) })
    } else if (KNOWN_UNIT_RANGE.has(name)) {
      bars.push({ key: name, label, value: stat.value, min: 0, max: 1, goodWhenHigh: false })
    } else {
      raw.push({ key: name, label, value: stat.value })
    }
  }

  const bleeding = health.isBleeding === true || (typeof health.numPartsBleeding === 'number' && health.numPartsBleeding > 0)
  const hasPosition = typeof summary.x === 'number' && typeof summary.y === 'number'
  const statusBadges = [
    summary.isAlive === false && { key: 'dead', icon: <Skull className="h-3 w-3" />, label: t('character.condition.dead'), danger: true },
    health.isInfected === true && { key: 'infected', icon: <Skull className="h-3 w-3" />, label: t('character.condition.infected'), danger: true },
    bleeding && { key: 'bleeding', icon: null, label: t('character.condition.bleeding'), danger: true },
    summary.isAsleep === true && { key: 'asleep', icon: <Moon className="h-3 w-3" />, label: t('character.condition.asleep'), danger: false },
    summary.isSneaking === true && { key: 'sneaking', icon: null, label: t('character.condition.sneaking'), danger: false },
    summary.isRunning === true && { key: 'running', icon: null, label: t('character.condition.running'), danger: false },
  ].filter(Boolean) as Array<{ key: string; icon: ReactNode; label: string; danger: boolean }>

  return (
    <section className="space-y-3" aria-labelledby="character-condition-heading">
      <h3 id="character-condition-heading" className="flex items-center gap-2 text-sm font-medium">
        <Activity className="h-4 w-4 text-primary" aria-hidden="true" />
        {t('character.condition.title')}
      </h3>
      {sheet.sectionErrors?.stats && (
        <p className="text-xs text-muted-foreground">{t('character.state.sectionFailed', { reason: sheet.sectionErrors.stats })}</p>
      )}
      {statusBadges.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {statusBadges.map((badge) => (
            <Badge
              key={badge.key}
              variant="outline"
              className={
                badge.danger
                  ? 'gap-1 border-destructive/40 text-[10px] font-mono uppercase tracking-wider text-destructive'
                  : 'gap-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground'
              }
            >
              {badge.icon}
              {badge.label}
            </Badge>
          ))}
        </div>
      )}
      {(hasPosition || typeof health.temperature === 'number') && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground/85">
          {hasPosition && (
            <span className="flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 text-primary/70" aria-hidden="true" />
              <span className="sr-only">{t('character.summary.position')}</span>
              <bdi dir="ltr" className="tabular-nums">
                {Math.round(summary.x as number)}, {Math.round(summary.y as number)}
                {typeof summary.z === 'number' ? `, ${summary.z}` : ''}
              </bdi>
            </span>
          )}
          {typeof health.temperature === 'number' && (
            <span className="flex items-center gap-1.5">
              <Thermometer className="h-3.5 w-3.5 text-primary/70" aria-hidden="true" />
              <span className="sr-only">{t('character.condition.temperature')}</span>
              <span className="tabular-nums">{formatNumber(health.temperature, language, 1)}°</span>
            </span>
          )}
        </div>
      )}
      {bars.length > 0 && (
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {bars.map((bar) => (
            <VitalBar key={bar.key} label={bar.label} value={bar.value} min={bar.min} max={bar.max} goodWhenHigh={bar.goodWhenHigh} />
          ))}
        </div>
      )}
      {raw.length > 0 && (
        <div className="border-t border-border/40 pt-2">
          <div className="mb-1 flex items-center gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {t('character.condition.rawStatsLabel')}
            </span>
            <HelpTip label={t('character.condition.rawStatsLabel')}>{t('character.condition.rawStatsTip')}</HelpTip>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground/85 sm:grid-cols-3">
            {raw.map(({ key, label, value }) => (
              <div key={key} className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{label}</span>
                <span className="tabular-nums text-foreground/85">{formatNumber(value, language, 2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
