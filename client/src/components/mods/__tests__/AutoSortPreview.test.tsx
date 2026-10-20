import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ModGroup } from '@/lib/api'
import { autoSortLoadOrder } from '@/lib/loadOrderAutoSort'
import { buildGroupMembership } from '@/lib/modGroupTools'
import { AutoSortPreview } from '../AutoSortPreview'

// The Auto-sort proposal: every moved mod with where it goes and why, grouped
// by its mod group, the rules that could not be met, then Apply or Cancel.

afterEach(() => {
  cleanup()
})

const STAMP = '2026-10-01T00:00:00.000Z'
const group = (id: string, name: string, modIds: string[], extra: Partial<ModGroup> = {}): ModGroup => ({
  id,
  name,
  description: '',
  modIds,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...extra,
})

function renderPreview(input: Parameters<typeof autoSortLoadOrder>[0], groups: ModGroup[], names: Record<string, string> = {}) {
  const result = autoSortLoadOrder(input)
  const onApply = vi.fn()
  const onCancel = vi.fn()
  render(
    <AutoSortPreview
      result={result}
      modNames={new Map(Object.entries(names))}
      groupsById={new Map(groups.map((g) => [g.id, g]))}
      membership={buildGroupMembership(groups)}
      onApply={onApply}
      onCancel={onCancel}
    />,
  )
  return { result, onApply, onCancel }
}

describe('AutoSortPreview', () => {
  it('lists each move with its reason, under its group, and the rules it followed', () => {
    const vehicles = group('veh', 'Vehicles', ['Lib', 'Car'])
    const { result } = renderPreview(
      { order: ['Car', 'Other', 'Lib'], requires: new Map([['Car', ['Lib']]]), groups: [{ id: 'veh', modIds: ['Lib', 'Car'] }] },
      [vehicles],
      { Lib: 'Vehicle library' },
    )
    expect(result.moves.length).toBeGreaterThan(0)

    const region = screen.getByRole('region', { name: /proposed/i })
    expect(region).toHaveTextContent('Vehicles')
    expect(region).toHaveTextContent('Dependencies')
    expect(region).toHaveTextContent('Group order')
    // The mod that moved says why, naming the other mod by its name.
    const moved = result.moves[0]
    const row = within(region).getByText(moved.modId).closest('li') as HTMLElement
    expect(row).toHaveTextContent(`#${moved.from}`)
    expect(row).toHaveTextContent(`#${moved.to}`)
    expect(row.textContent).toMatch(/requires|keeps the order of Vehicles/)
  })

  it('says what could not be met and why', () => {
    // The group lists Car before Lib, but Car needs Lib: the dependency wins.
    renderPreview(
      { order: ['Car', 'Lib'], requires: new Map([['Car', ['Lib']]]), groups: [{ id: 'veh', modIds: ['Car', 'Lib'] }] },
      [group('veh', 'Vehicles', ['Car', 'Lib'])],
    )

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('1 rule cannot be met')
    expect(status).toHaveTextContent('Vehicles lists Car before Lib, but a dependency needs the opposite')
  })

  it('Apply and Cancel call back', () => {
    const { onApply, onCancel } = renderPreview(
      { order: ['Car', 'Lib'], requires: new Map([['Car', ['Lib']]]) },
      [],
    )

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('puts mods of no group under "Other mods" next to grouped ones', () => {
    renderPreview(
      {
        order: ['B', 'A', 'Y', 'X'],
        requires: new Map([['B', ['A']]]),
        groups: [{ id: 'g', modIds: ['X', 'Y'] }],
      },
      [group('g', 'Pair', ['X', 'Y'])],
    )

    expect(screen.getByText('Other mods')).toBeInTheDocument()
    expect(screen.getByText('Pair')).toBeInTheDocument()
  })
})
