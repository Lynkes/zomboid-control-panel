import { useTranslation } from 'react-i18next'
import { ChevronRight, MoreHorizontal } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { pathSegments } from '@/lib/filesApi'

interface Crumb {
  label: string
  path: string
  isRoot: boolean
}

interface FileBreadcrumbProps {
  rootLabel: string
  path: string
  onNavigate: (path: string) => void
  /** Phone layout: only the last two crumbs stay visible. */
  compact: boolean
}

// Where you are inside the root (spec §A14.2). Middle crumbs fold into a
// "…" menu so a deep save folder never wraps the toolbar: on desktop the
// root and the last two stay visible, on a phone only the last two.
export function FileBreadcrumb({ rootLabel, path, onNavigate, compact }: FileBreadcrumbProps) {
  const { t } = useTranslation('files')
  const segments = pathSegments(path)
  const crumbs: Crumb[] = [
    { label: rootLabel, path: '', isRoot: true },
    ...segments.map((segment, index) => ({ label: segment, path: segments.slice(0, index + 1).join('/'), isRoot: false })),
  ]

  let leading: Crumb[] = []
  let hidden: Crumb[] = []
  let trailing: Crumb[] = crumbs
  if (compact && crumbs.length > 2) {
    hidden = crumbs.slice(0, -2)
    trailing = crumbs.slice(-2)
  } else if (!compact && crumbs.length > 4) {
    leading = crumbs.slice(0, 1)
    hidden = crumbs.slice(1, -2)
    trailing = crumbs.slice(-2)
  }

  const renderLabel = (crumb: Crumb) =>
    crumb.isRoot ? crumb.label : <bdi dir="ltr">{crumb.label}</bdi>

  const renderCrumb = (crumb: Crumb, isLast: boolean) =>
    isLast ? (
      <span aria-current="page" className="block max-w-[14rem] truncate px-1 font-medium text-foreground sm:max-w-[18rem]" title={crumb.label}>
        {renderLabel(crumb)}
      </span>
    ) : (
      <button
        type="button"
        onClick={() => onNavigate(crumb.path)}
        className="block min-h-11 max-w-[10rem] truncate rounded px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:max-w-[12rem]"
        title={crumb.label}
      >
        {renderLabel(crumb)}
      </button>
    )

  const separator = <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 rtl:-scale-x-100" aria-hidden="true" />

  return (
    <nav aria-label={t('list.breadcrumbLabel')} className="min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm">
        {leading.map((crumb) => (
          <li key={crumb.path || 'root'} className="flex min-w-0 items-center gap-0.5">
            {renderCrumb(crumb, false)}
            {separator}
          </li>
        ))}
        {hidden.length > 0 && (
          <li className="flex items-center gap-0.5">
            <DropdownMenu>
              <DropdownMenuTrigger
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-7 sm:min-w-7"
                aria-label={t('list.breadcrumbMore')}
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {hidden.map((crumb) => (
                  <DropdownMenuItem key={crumb.path || 'root'} onSelect={() => onNavigate(crumb.path)} className="min-h-11 sm:min-h-0">
                    {renderLabel(crumb)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {separator}
          </li>
        )}
        {trailing.map((crumb, index) => {
          const isLast = index === trailing.length - 1
          return (
            <li key={crumb.path || 'root'} className="flex min-w-0 items-center gap-0.5">
              {renderCrumb(crumb, isLast)}
              {!isLast && separator}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
