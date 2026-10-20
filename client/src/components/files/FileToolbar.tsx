import { useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Download,
  FilePlus,
  FolderPlus,
  FolderUp,
  Loader2,
  RefreshCw,
  Search,
  Upload,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ListSort, SortOrder } from '@/types/files'

interface FileToolbarProps {
  breadcrumb: ReactNode
  shortcutsHelp: ReactNode
  query: string
  onQueryChange: (value: string) => void
  onSearch: () => void
  searching: boolean
  searchActive: boolean
  onClearQuery: () => void
  sort: ListSort
  order: SortOrder
  sortLimited: boolean
  onSortChange: (sort: ListSort, order: SortOrder) => void
  canWrite: boolean
  onNewFile: () => void
  onNewFolder: () => void
  onUploadFiles: () => void
  onUploadFolder: () => void
  selectionCount: number
  canDownloadSelection: boolean
  onDownload: () => void
  onRefresh: () => void
  refreshing: boolean
}

// Everything above the file table (spec §A14.2). The one text box filters
// the loaded folder as you type; Search (or Enter) looks for names in this
// folder and below on the server. Write actions only appear on a writable
// folder; what can be done with a selection is on the selection bar.
export function FileToolbar({
  breadcrumb,
  shortcutsHelp,
  query,
  onQueryChange,
  onSearch,
  searching,
  searchActive,
  onClearQuery,
  sort,
  order,
  sortLimited,
  onSortChange,
  canWrite,
  onNewFile,
  onNewFolder,
  onUploadFiles,
  onUploadFolder,
  selectionCount,
  canDownloadSelection,
  onDownload,
  onRefresh,
  refreshing,
}: FileToolbarProps) {
  const { t } = useTranslation('files')
  const hasSelection = selectionCount > 0
  const inputRef = useRef<HTMLInputElement>(null)

  // "/" anywhere on the page (outside a field or a dialog) jumps to the
  // filter box, like the kit's Toolbar search (DESIGN.md keyboard rules).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return
      const active = document.activeElement as HTMLElement | null
      const tag = active?.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || active?.isContentEditable) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      event.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">{breadcrumb}</div>
        {shortcutsHelp}
        <Button variant="ghost" size="icon" onClick={onRefresh} aria-label={t('page.refresh')} disabled={refreshing}>
          {refreshing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form
          role="search"
          className="flex min-w-0 flex-1 basis-64 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            onSearch()
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  event.preventDefault()
                  onClearQuery()
                }
              }}
              placeholder={t('list.filterPlaceholder')}
              aria-label={t('list.filterPlaceholder')}
              aria-describedby="files-search-hint"
              aria-keyshortcuts="/"
              className="min-h-11 pe-9 sm:min-h-9"
            />
            <span id="files-search-hint" className="sr-only">{t('search.placeholder')}</span>
            {query && (
              <button
                type="button"
                onClick={onClearQuery}
                aria-label={t('list.clearFilter')}
                className="absolute end-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-7 sm:w-7"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
          <Button type="submit" variant={searchActive ? 'secondary' : 'outline'} size="sm" aria-busy={searching}>
            {searching ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
            {t('search.button')}
          </Button>
        </form>

        <div className="flex items-center gap-1">
          <Select value={sort} onValueChange={(value) => onSortChange(value as ListSort, order)}>
            <SelectTrigger className="min-h-11 w-[9.5rem] sm:min-h-9" aria-label={t('list.sortLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">{t('list.sortName')}</SelectItem>
              <SelectItem value="size" disabled={sortLimited}>{t('list.sortSize')}</SelectItem>
              <SelectItem value="modified" disabled={sortLimited}>{t('list.sortModified')}</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            onClick={() => onSortChange(sort, order === 'asc' ? 'desc' : 'asc')}
            aria-label={order === 'asc' ? t('list.sortAsc') : t('list.sortDesc')}
          >
            {order === 'asc' ? <ArrowUpNarrowWide aria-hidden="true" /> : <ArrowDownWideNarrow aria-hidden="true" />}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {canWrite && (
          <>
            <Button variant="outline" size="sm" onClick={onNewFile}>
              <FilePlus aria-hidden="true" />
              {t('actions.newFile')}
            </Button>
            <Button variant="outline" size="sm" onClick={onNewFolder}>
              <FolderPlus aria-hidden="true" />
              {t('actions.newFolder')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Upload aria-hidden="true" />
                  {t('actions.upload')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={onUploadFiles} className="min-h-11 gap-2 sm:min-h-0">
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  {t('actions.uploadFiles')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onUploadFolder} className="min-h-11 gap-2 sm:min-h-0">
                  <FolderUp className="h-4 w-4" aria-hidden="true" />
                  {t('actions.uploadFolder')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        {/* Download as .zip, Move and Delete live on the selection bar
            (BulkBar), which shows whenever something is selected; only the
            plain download (a single file as itself) stays up here. */}
        {hasSelection && canDownloadSelection && (
          <Button variant="outline" size="sm" onClick={onDownload}>
            <Download aria-hidden="true" />
            {t('actions.download')}
          </Button>
        )}
      </div>
    </div>
  )
}
