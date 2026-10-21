import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Skeleton } from '@/components/ui/skeleton'
import { useRouteMeta, type PageSkeletonVariant, type PageSection } from '@/lib/navigation'

const SKELETON_WIDTHS = ['w-[62%]', 'w-[78%]', 'w-[55%]', 'w-[90%]', 'w-[68%]', 'w-[82%]', 'w-[47%]', 'w-[73%]', 'w-[60%]', 'w-[85%]', 'w-[52%]', 'w-[76%]']

interface PageSkeletonProps {
  variant?: PageSkeletonVariant
  title?: string
  description?: string
  icon?: ReactNode
  section?: PageSection | 'home'
  /** @deprecated Ignored: the header has no kicker, so neither does its skeleton. */
  eyebrow?: string
  /** @deprecated Ignored. */
  metrics?: string[]
}

// Mirrors PageHeader (icon, title, description) so the real header replaces
// it in place instead of flashing a different layout.
function SkeletonHeader({ title, description, icon, section }: { title: string; description: string; icon?: ReactNode; section?: PageSection | 'home' }) {
  return (
    <section className="page-header-shell rounded-lg border border-border/40 bg-card/40 px-4 py-3 sm:px-5 sm:py-4" data-tone={section ?? 'server'} aria-hidden="true">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          {icon && <span className="page-title-icon shrink-0 text-primary [&>svg]:h-5 [&>svg]:w-5">{icon}</span>}
          <h1 className="page-title text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{title}</h1>
        </div>
        <p className="page-description mt-1 max-w-3xl text-xs leading-5 text-muted-foreground sm:text-sm">{description}</p>
      </div>
    </section>
  )
}

/**
 * The loading state of the current route, named after it: its registry
 * title, icon and description, in the operator's language.
 */
export function RoutePageSkeleton({ pathname }: { pathname?: string }) {
  const { t } = useTranslation('shell')
  const route = useRouteMeta(pathname)
  if (!route) return <PageSkeleton />
  const Icon = route.icon
  return (
    <PageSkeleton
      variant={route.loader.variant}
      title={t(route.titleKey)}
      description={t(route.loader.descriptionKey)}
      icon={<Icon />}
      section={route.section}
    />
  )
}

export function PageSkeleton({ variant = 'default', title, description, icon, section }: PageSkeletonProps) {
  const { t } = useTranslation('shell')
  // The caller's own title when it gave one, else the stock text for the layout.
  const loadingLabel = (fallbackKey: string) =>
    title ? t('pageSkeleton.labels.named', { title }) : t(fallbackKey)
  const header = (
    <SkeletonHeader
      title={title ?? t('pageSkeleton.defaultTitle')}
      description={description ?? t('pageSkeleton.defaultDescription')}
      icon={icon}
      section={section}
    />
  )

  if (variant === 'dashboard') {
    return (
      <div className="space-y-6 page-transition" role="status" aria-live="polite" aria-label={t('pageSkeleton.labels.dashboard')} aria-busy="true">
        {header}
        {/* Stat cards skeleton */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-6 space-y-3">
              <Skeleton className="h-1.5 w-full -mt-6 -mx-6 mb-4 rounded-none rounded-t-xl" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-3 w-32" />
            </div>
          ))}
        </div>
        {/* Content skeleton */}
        <div className="rounded-xl border bg-card p-6 space-y-4">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-64" />
          <div className="flex gap-3 pt-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-32 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (variant === 'list') {
    return (
      <div className="space-y-6 page-transition" role="status" aria-live="polite" aria-label={loadingLabel('pageSkeleton.labels.list')} aria-busy="true">
        {header}
        <div className="rounded-xl border bg-card">
          <div className="p-4 border-b">
            <Skeleton className="h-10 w-full max-w-sm" />
          </div>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="p-4 border-b last:border-0 flex items-center gap-4">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-8 w-20" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (variant === 'console') {
    return (
      <div className="space-y-6 page-transition" role="status" aria-live="polite" aria-label={loadingLabel('pageSkeleton.labels.console')} aria-busy="true">
        {header}
        <div className="flex gap-2">
          <Skeleton className="h-10 flex-1 max-w-[200px]" />
          <Skeleton className="h-10 flex-1 max-w-[200px]" />
        </div>
        <div className="rounded-xl border bg-card p-4 space-y-2">
          <div className="flex justify-between mb-4">
            <Skeleton className="h-5 w-40" />
            <div className="flex gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-8" />
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className={`h-4 ${SKELETON_WIDTHS[i]}`} />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (variant === 'form') {
    return (
      <div className="space-y-6 page-transition" role="status" aria-live="polite" aria-label={loadingLabel('pageSkeleton.labels.form')} aria-busy="true">
        {header}
        <div className="rounded-xl border bg-card p-6 space-y-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
          <Skeleton className="h-10 w-32" />
        </div>
      </div>
    )
  }

  if (variant === 'map') {
    return (
      <div className="space-y-6 page-transition" role="status" aria-live="polite" aria-label={loadingLabel('pageSkeleton.labels.map')} aria-busy="true">
        {header}
        <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
          <div className="rounded-xl border bg-card p-4 space-y-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-4 w-28" />
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded" />
                <Skeleton className={`h-3 ${SKELETON_WIDTHS[i]}`} />
              </div>
            ))}
          </div>
          <div className="relative min-h-[26rem] overflow-hidden rounded-xl border bg-card">
            <div className="absolute inset-0 opacity-40" style={{ backgroundImage: 'linear-gradient(hsl(var(--border)/0.55) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)/0.55) 1px, transparent 1px)', backgroundSize: '32px 32px' }} />
            <div className="absolute start-4 top-4 flex gap-2">
              <Skeleton className="h-9 w-24" />
              <Skeleton className="h-9 w-24" />
            </div>
            <Skeleton className="absolute bottom-4 start-4 h-4 w-48" />
          </div>
        </div>
      </div>
    )
  }

  // Default
  return (
    <div className="space-y-6 page-transition" role="status" aria-live="polite" aria-label={loadingLabel('pageSkeleton.labels.page')} aria-busy="true">
      {header}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-6 space-y-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-8 w-24" />
          </div>
        ))}
      </div>
    </div>
  )
}
