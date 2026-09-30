import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Briefcase, Shield, Trophy, UserRound } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { HelpTip } from '@/components/HelpTip'
import { CHARACTER_FLAGS, type CharacterRecord, type CharacterSheet } from '@/lib/characterApi'
import { makeCollator, professionLabel, sortByLabel, traitLabel } from '@/lib/characterLabels'
import { DEFAULT_MINUTES_PER_DAY, estimatePlayedHours, formatNumber } from './characterFormat'

const ORDINARY_ROLES = new Set(['none', 'user'])

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">{label}</dt>
      <dd className="text-sm text-foreground/90">{children}</dd>
    </div>
  )
}

export function CharacterSummary({ sheet, record }: { sheet: CharacterSheet; record: CharacterRecord | null }) {
  const { t, i18n } = useTranslation('players')
  const { t: tPz } = useTranslation('pzCharacter')
  const language = i18n.language
  const collator = useMemo(() => makeCollator(language), [language])
  const summary = sheet.summary ?? {}
  const role = sheet.role
  const staff = role?.adminPower === true

  const occupation = professionLabel(tPz, summary.profession)
  const days = typeof summary.hoursSurvived === 'number' ? Math.floor(summary.hoursSurvived / 24) : undefined
  const played = estimatePlayedHours(summary.hoursSurvived, summary.minutesPerDay)
  const dayLengthKnown = typeof summary.minutesPerDay === 'number' && summary.minutesPerDay > 0
  const minutesPerDay = dayLengthKnown ? (summary.minutesPerDay as number) : DEFAULT_MINUTES_PER_DAY
  const powers = CHARACTER_FLAGS.filter((flag) => summary.flags?.[flag] === true)
  const traits = useMemo(
    () => sortByLabel(sheet.traits ?? [], (trait) => traitLabel(tPz, trait), collator),
    [sheet.traits, tPz, collator],
  )
  const hasRecord =
    record !== null && [record.allTimeKills, record.deaths, record.bestDays].some((value) => typeof value === 'number')
  // B42's default role for every ordinary account is "user" (Roles:
  // defaultForUser), B41's access level "none": neither is a special role.
  const showRole = typeof role?.name === 'string' && role.name !== '' && !ORDINARY_ROLES.has(role.name.toLowerCase())

  return (
    <section className="space-y-3" aria-labelledby="character-summary-heading">
      <h3 id="character-summary-heading" className="flex items-center gap-2 text-sm font-medium">
        <UserRound className="h-4 w-4 text-primary" aria-hidden="true" />
        {t('character.summary.title')}
      </h3>
      {sheet.sectionErrors?.summary && (
        <p className="text-xs text-muted-foreground">{t('character.state.sectionFailed', { reason: sheet.sectionErrors.summary })}</p>
      )}

      {(showRole || staff || powers.length > 0) && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {showRole && (
              <Badge variant="outline" className="gap-1 text-[10px] font-mono uppercase tracking-wider text-amber-400">
                <Shield className="h-3 w-3" aria-hidden="true" />
                <span className="sr-only">{t('character.summary.role')}: </span>
                <bdi>{role?.name}</bdi>
              </Badge>
            )}
            {powers.length > 0 && (
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
                {t('character.summary.powersOn')}
              </span>
            )}
            {powers.map((flag) => (
              <Badge
                key={flag}
                variant="outline"
                className="border-primary/40 bg-primary/10 px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider text-primary"
              >
                {t(`character.summary.flags.${flag}`)}
              </Badge>
            ))}
          </div>
          {staff && <p className="text-xs text-muted-foreground">{t('character.summary.staffNote')}</p>}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        {occupation && (
          <Fact label={t('character.summary.occupation')}>
            <span className="inline-flex items-center gap-1.5">
              <Briefcase className="h-3.5 w-3.5 text-primary/70" aria-hidden="true" />
              {occupation}
            </span>
          </Fact>
        )}
        {days !== undefined && (
          <Fact label={t('character.summary.daysSurvived')}>
            <span className="tabular-nums">{formatNumber(days, language)}</span>
            {played !== undefined && (
              <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                {t('character.summary.playedEstimate', { hours: formatNumber(played, language, played < 10 ? 1 : 0) })}
                <HelpTip label={t('character.summary.playedEstimate', { hours: formatNumber(played, language, played < 10 ? 1 : 0) })}>
                  {t('character.summary.playedEstimateTip', {
                    days: formatNumber((summary.hoursSurvived as number) / 24, language, 1),
                    minutes: formatNumber(minutesPerDay, language),
                  })}
                  {!dayLengthKnown && <> {t('character.summary.defaultDayLength', { minutes: DEFAULT_MINUTES_PER_DAY })}</>}
                </HelpTip>
              </span>
            )}
          </Fact>
        )}
        {(typeof summary.zombieKills === 'number' || typeof summary.survivorKills === 'number') && (
          <Fact label={t('character.summary.kills')}>
            <span className="tabular-nums">
              {t('character.summary.killsValue', {
                zombies: formatNumber(summary.zombieKills ?? 0, language),
                survivors: formatNumber(summary.survivorKills ?? 0, language),
              })}
            </span>
          </Fact>
        )}
        {typeof summary.bodyWeight === 'number' && (
          <Fact label={t('character.summary.bodyWeight')}>
            <span className="tabular-nums">{t('character.summary.bodyWeightValue', { value: formatNumber(summary.bodyWeight, language, 1) })}</span>
          </Fact>
        )}
        {typeof summary.carriedWeight === 'number' && typeof summary.maxWeight === 'number' && (
          <Fact label={t('character.summary.load')}>
            <span className="tabular-nums">
              {t('character.summary.loadValue', {
                carried: formatNumber(summary.carriedWeight, language, 1),
                max: formatNumber(summary.maxWeight, language, 1),
              })}
            </span>
          </Fact>
        )}
      </dl>

      {hasRecord && record && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Trophy className="h-3.5 w-3.5 text-primary/70" aria-hidden="true" />
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">{t('character.summary.record')}</span>
          <span className="tabular-nums text-foreground/85">
            {t('character.summary.recordLine', {
              allTimeKills: formatNumber(record.allTimeKills ?? 0, language),
              deaths: formatNumber(record.deaths ?? 0, language),
              bestDays: formatNumber(record.bestDays ?? 0, language),
            })}
          </span>
          {record.favoriteWeapon && (
            <span>· {t('character.summary.favoriteWeapon', { weapon: record.favoriteWeapon })}</span>
          )}
        </p>
      )}

      {sheet.traits !== undefined && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('character.summary.traits')}</p>
          {sheet.sectionErrors?.traits ? (
            <p className="text-xs text-muted-foreground">{t('character.state.sectionFailed', { reason: sheet.sectionErrors.traits })}</p>
          ) : traits.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('character.summary.noTraits')}</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {traits.map((trait) => (
                <li key={trait.id}>
                  <Badge variant="secondary" className="gap-1 px-2 py-0.5 text-[11px] font-medium">
                    {traitLabel(tPz, trait)}
                    {trait.profession && (
                      <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                        · {t('character.summary.fromOccupation')}
                      </span>
                    )}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
