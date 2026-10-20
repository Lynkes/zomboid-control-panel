import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { StatusPill, type StatusPillProps } from '@/components/ui/status-pill'
import { RowActions, type RowActionItem } from '@/components/ui/row-actions'

export type ServerHeaderMenuItem = RowActionItem

export interface ServerHeaderProps {
  /** The server's name: the page title. */
  name: string
  status: StatusPillProps
  /** Map, uptime, addresses: one row of facts. Addresses may be mono (data). */
  meta: ReactNode
  /** The contextual command: Start when stopped, Restart when running. */
  primary?: ReactNode
  /** One outline action (Stop). */
  secondary?: ReactNode
  /** Everything else; destructive items (Wipe) go last after a separator. */
  menu: ServerHeaderMenuItem[]
}

/**
 * The Dashboard's header. Same parts as PageHeader, but the h1 is the
 * active server's name at page-title size, in the UI sans, with its state.
 */
export function ServerHeader({ name, status, meta, primary, secondary, menu }: ServerHeaderProps) {
  const { t } = useTranslation('shell')
  return (
    <section className="page-header-shell rounded-lg border border-border/40 bg-card/40 px-4 py-3 sm:px-5 sm:py-4" data-tone="home">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 sm:flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h1 className="page-title min-w-0 break-words text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{name}</h1>
            <StatusPill {...status} />
          </div>
          <div className="page-meta mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{meta}</div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
          {secondary}
          <RowActions items={menu} ariaLabel={t('serverHeader.more', { name })} />
          {primary}
        </div>
      </div>
    </section>
  )
}
