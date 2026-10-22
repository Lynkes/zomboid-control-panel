import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ModHealth } from '@/lib/api'
import { HealthSummaryCard } from '../HealthSummaryCard'

// The one-line health summary at the top of Active on server and Load order.

const STEAM = { source: 'none' as const, fetchedAt: null, stale: false, failed: false, pending: false, known: 0, total: 0 }
const health = (critical: number, warning: number, info = 0): ModHealth => ({
  checkedAt: '2026-10-20T10:00:00.000Z',
  counts: { critical, warning, info },
  issues: [],
  steamStatus: STEAM,
})

afterEach(cleanup)

describe('HealthSummaryCard', () => {
  it('renders nothing without critical problems or warnings', () => {
    const { container } = render(<HealthSummaryCard health={health(0, 0, 4)} onReview={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    const { container: none } = render(<HealthSummaryCard health={null} onReview={vi.fn()} />)
    expect(none).toBeEmptyDOMElement()
  })

  it('leads with what stops mods from loading, then the warnings, and opens the review', () => {
    const onReview = vi.fn()
    render(<HealthSummaryCard health={health(2, 3)} onReview={onReview} />)
    expect(screen.getByText('2 problems will stop mods from loading · 3 warnings')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(onReview).toHaveBeenCalledTimes(1)
  })

  it('words warnings alone as needing attention', () => {
    render(<HealthSummaryCard health={health(0, 1)} onReview={vi.fn()} />)
    expect(screen.getByText('1 problem needs attention')).toBeInTheDocument()
  })
})
