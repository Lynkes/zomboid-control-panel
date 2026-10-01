import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Download,
  FileArchive,
  FilePlus,
  FolderPlus,
  FolderUp,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
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
  canDeleteSelection: boolean
  onDownload: () => void
  onDownloadZip: () => void
  onDelete: () => void
  onRefresh: () => void
  refreshing: boolean
}

// Everything above the file table (spec §A14.2). The one text box filters
// the loaded folder as you type; Search (or Enter) looks for names in this
// folder and below on the server. Write actions only appear on a writable
// folder, and Download/Delete only once something is selected.
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
  canDeleteSelection,
  onDownload,
  onDownloadZip,
  onDelete,
  onRefresh,
  refreshing,
}: FileToolbarProps) {
  const { t } = useTranslation('files')
  const hasSelection = selectionCount > 0

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
        {hasSelection && canDownloadSelection && (
          <>
            <Button variant="outline" size="sm" onClick={onDownload}>
              <Download aria-hidden="true" />
              {t('actions.download')}
            </Button>
            <Button variant="outline" size="sm" onClick={onDownloadZip}>
              <FileArchive aria-hidden="true" />
              {t('actions.downloadZip')}
            </Button>
          </>
        )}
        {hasSelection && canDeleteSelection && (
          <Button variant="destructive" size="sm" onClick={onDelete}>
            <Trash2 aria-hidden="true" />
            {t('actions.delete')}
          </Button>
        )}
      </div>
    </div>
  )
}
