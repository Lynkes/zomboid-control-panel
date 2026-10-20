import { Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useRouteMeta, type PageSection } from '@/lib/navigation'

export interface PageHeaderCrumb {
  label: string
  to?: string
}

interface PageHeaderProps {
  title: string
  /** One sentence (90 characters or so) saying what can be done here. */
  description?: string
  /** Defaults to the route's registry icon. Shown at h-5 whatever size is passed. */
  icon?: ReactNode
  /** Left to right: optional icon-only Refresh, one outline secondary, a "More" menu, one command primary last. All size="sm". */
  actions?: ReactNode
  /** Live state next to the title: a StatusPill, a BridgeStatusBadge, "Updated 11:47". */
  status?: ReactNode
  /** One row of facts under the description (active server, path, counts). */
  meta?: ReactNode
  /** For child flows: "Settings › Users", "Servers › Add a server". */
  breadcrumb?: PageHeaderCrumb[]
  /** Accent wash; defaults to the route's section in the registry. */
  section?: PageSection
  /** @deprecated Alias of `status`. */
  badge?: ReactNode
  /** @deprecated Ignored: a heading carries its own weight (no kicker above it). */
  eyebrow?: string
  /** @deprecated Mapped to a section when the registry has no entry: ops/maintain → server, world → world, config/servers → panel. */
  tone?: 'ops' | 'world' | 'maintain' | 'config' | 'servers'
  /** @deprecated Ignored: page titles use the UI sans. */
  displayFont?: boolean
}

const TONE_TO_SECTION: Record<NonNullable<PageHeaderProps['tone']>, PageSection> = {
  ops: 'server',
  maintain: 'server',
  world: 'world',
  config: 'panel',
  servers: 'panel',
}

export function PageHeader({ title, description, icon, actions, status, meta, breadcrumb, section, badge, tone }: PageHeaderProps) {
  const { t } = useTranslation('shell')
  const route = useRouteMeta()
  const dataTone = section ?? route?.section ?? (tone ? TONE_TO_SECTION[tone] : 'server')
  const RouteIcon = route?.icon
  const shownIcon = icon ?? (RouteIcon ? <RouteIcon /> : null)
  const liveState = status ?? badge

  return (
    <section className="page-header-shell rounded-lg border border-border/40 bg-card/40 px-4 py-3 sm:px-5 sm:py-4" data-tone={dataTone}>
      {breadcrumb && breadcrumb.length > 0 && (
        <nav aria-label={t('pageHeader.breadcrumb')} className="mb-1.5">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {breadcrumb.map((crumb, index) => (
              <Fragment key={`${crumb.label}-${index}`}>
                <li>
                  {crumb.to ? (
                    <Link to={crumb.to} className="rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span>{crumb.label}</span>
                  )}
                </li>
                <li aria-hidden="true">
                  <ChevronRight className="h-3 w-3 rtl:-scale-x-100" />
                </li>
              </Fragment>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 sm:flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            {shownIcon && (
              <span className="page-title-icon shrink-0 text-primary [&>svg]:h-5 [&>svg]:w-5" aria-hidden="true">
                {shownIcon}
              </span>
            )}
            <h1 className="page-title min-w-0 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{title}</h1>
            {liveState}
          </div>
          {description && (
            <p className="page-description mt-1 max-w-3xl text-xs leading-5 text-muted-foreground sm:text-sm">{description}</p>
          )}
          {meta && (
            <div className="page-meta mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{meta}</div>
          )}
        </div>
        {actions && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:max-w-[55%] sm:justify-end">
            {actions}
          </div>
        )}
      </div>
    </section>
  )
}
