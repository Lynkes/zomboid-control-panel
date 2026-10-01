import { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Sliders, FileCog, Package } from 'lucide-react'
import { SimTemplateDiff, SimTemplateModRef } from '@/lib/api'
import { getIniKeyLabel, getSandboxKeyLabel, formatDiffValue } from '@/lib/templateLabels'

interface DiffRow {
  label: string
  sub?: string
  from: unknown
  to: unknown
}

// 2026-09 community report (Templates preview "doesn't appear in full"): the
// value column used to be `shrink-0` with no width limit, so one long value
// -- a captured Mods= / WorkshopItems= list, a welcome message, an item list
// -- made its row wider than the dialog and the whole dialog scrolled
// sideways, showing either the labels or the values, never both. Values now
// get at most 60% of the row beside the label from sm: up and wrap anywhere
// inside it (mod lists and item IDs have no spaces to break at); below sm:
// the value goes under its label, so neither is squeezed to a sliver on a
// phone. A value that fits looks exactly as before.
function DiffRows({ rows, emptyText }: { rows: DiffRow[]; emptyText: string }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyText}</p>
  }
  return (
    <ul className="divide-y divide-border/50 rounded-md border border-border/50">
      {rows.map((row) => (
        <li
          key={`${row.sub || ''}${row.label}`}
          className="flex flex-col gap-1 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3"
        >
          <div className="min-w-0 sm:flex-1">
            <p className="truncate font-medium text-foreground" title={row.label}>{row.label}</p>
            {row.sub && <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">{row.sub}</p>}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 font-mono text-xs [overflow-wrap:anywhere] sm:max-w-[60%] sm:justify-end">
            <span className="min-w-0 text-muted-foreground line-through">{formatDiffValue(row.from)}</span>
            <span className="text-muted-foreground">&rarr;</span>
            <span className="min-w-0 font-semibold text-primary">{formatDiffValue(row.to)}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}

function Section({ icon: Icon, title, children }: { icon: typeof Sliders; title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </h4>
      {children}
    </div>
  )
}

interface TemplateDiffListProps {
  diff: SimTemplateDiff
  mods: SimTemplateModRef[]
}

export function TemplateDiffList({ diff, mods }: TemplateDiffListProps) {
  const { t } = useTranslation('templateDiffList')
  const sandboxRows: DiffRow[] = diff.sandboxVars.map((c) => ({
    label: getSandboxKeyLabel(c.key, c.section),
    sub: c.section,
    from: c.from,
    to: c.to,
  }))
  const iniRows: DiffRow[] = diff.serverIni.map((c) => ({
    label: getIniKeyLabel(c.key),
    from: c.from,
    to: c.to,
  }))

  return (
    <div className="space-y-4">
      <Section icon={Sliders} title={t('sandboxChanges')}>
        <DiffRows rows={sandboxRows} emptyText={t('noSandboxChanges')} />
      </Section>
      <Section icon={FileCog} title={t('serverIniChanges')}>
        <DiffRows rows={iniRows} emptyText={t('noIniChanges')} />
      </Section>
      <Section icon={Package} title={t('mods')}>
        {mods.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('noModsReferenced')}</p>
        ) : (
          <>
            <ul className="rounded-md border border-border/50 divide-y divide-border/50">
              {mods.map((m) => (
                <li key={m.workshopId} className="px-3 py-2 text-sm [overflow-wrap:anywhere]">
                  {m.name || m.modId || m.workshopId}
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-muted-foreground">
              {t('modsNotInstalledAutomatically')}
            </p>
          </>
        )}
      </Section>
    </div>
  )
}
