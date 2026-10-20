import { Fragment, useRef, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'

/** Above this many rows a list renders only what is on screen. */
export const VIRTUALIZE_ROWS_AT = 150

export interface VirtualRowsProps<T> {
  rows: readonly T[]
  getKey: (row: T, index: number) => string
  renderRow: (row: T, index: number) => ReactNode
  /** A first guess at a row's height; rendered rows are measured. */
  estimateSize: (row: T) => number
  /** The scroll container's classes (its height). */
  className?: string
  /** The plain list's classes (dividers, stripes) when not virtualized. */
  listClassName?: string
  /** Classes for one row's wrapper when virtualized (its divider, its stripe). */
  virtualRowClassName?: (row: T, index: number) => string | undefined
  threshold?: number
}

/**
 * A scrolling list that renders every row while it is short, and only the
 * rows on screen once it is long (600-mod servers). Rows of any height:
 * rendered rows are measured.
 */
export function VirtualRows<T>({
  rows,
  getKey,
  renderRow,
  estimateSize,
  className,
  listClassName,
  virtualRowClassName,
  threshold = VIRTUALIZE_ROWS_AT,
}: VirtualRowsProps<T>) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const virtualize = rows.length > threshold
  const virtualizer = useVirtualizer({
    count: virtualize ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimateSize(rows[i]),
    overscan: 8,
    getItemKey: (i) => getKey(rows[i], i),
  })

  return (
    <div ref={scrollRef} className={cn('overflow-y-auto', className)} data-virtualized={virtualize ? '' : undefined}>
      {virtualize ? (
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className={cn('absolute inset-x-0 top-0', virtualRowClassName?.(rows[item.index], item.index))}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {renderRow(rows[item.index], item.index)}
            </div>
          ))}
        </div>
      ) : (
        <div className={listClassName}>
          {rows.map((row, index) => (
            <Fragment key={getKey(row, index)}>{renderRow(row, index)}</Fragment>
          ))}
        </div>
      )}
    </div>
  )
}
