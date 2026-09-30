import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CharacterTab } from '../CharacterTab'
import type { CharacterSheetState } from '../useCharacterSheet'
import type { CharacterHint, CharacterSheet, CharacterSheetResponse } from '@/lib/characterApi'

const THRESHOLDS = {
  advancedLevelFloor: 3,
  advancedLevelsPerHour: 3,
  advancedLevelsGrace: 6,
  bookMultiplierWeight: 0.5,
  maxedSkillsCount: 3,
  maxedSkillsStrongCount: 6,
  maxedSkillsWithinHours: 40,
  maxedSkillsShareAlways: 0.8,
  jumpLevelsOnePerk: 3,
  jumpMinTargetLevel: 6,
  jumpLevelsPassive: 2,
  jumpTotalLevels: 6,
  jumpWindowMinutes: 60,
  unusualQuantity: 500,
  overCapacityFactor: 2,
}

const SHEET: CharacterSheet = {
  username: 'Kate',
  role: { name: 'none', adminPower: false, canSpawnItems: false },
  summary: {
    isAlive: true,
    x: 10870.4,
    y: 9412.9,
    z: 0,
    hoursSurvived: 312,
    minutesPerDay: 60,
    zombieKills: 214,
    survivorKills: 0,
    bodyWeight: 78.2,
    carriedWeight: 11.4,
    maxWeight: 15,
    flags: { godMode: false },
    profession: { id: 'base:carpenter', label: 'Carpenter' },
  },
  stats: {
    hunger: { value: 0.25, min: 0, max: 1 },
    endurance: { value: 0.8, min: 0, max: 1 },
    boredom: { value: 50, min: 0, max: 100 },
  },
  health: { overall: 92, isInfected: true, numPartsBleeding: 0 },
  skills: {
    categories: [
      { id: 'Crafting', name: 'Crafting' },
      { id: 'Firearm', name: 'Combat - Firearms' },
    ],
    perks: [
      { id: 'Woodwork', parent: 'Crafting', name: 'Carpentry', passive: false, level: 6, xp: 5200, levelXp: 4500, nextLevelXp: 6000, boost: 3, multiplier: 3 },
      { id: 'Cooking', parent: 'Crafting', name: 'Cooking', passive: false, level: 0, xp: 0, levelXp: 0, nextLevelXp: 75 },
      { id: 'Aiming', parent: 'Firearm', name: 'Aiming', passive: false, level: 0, xp: 0, levelXp: 0, nextLevelXp: 75 },
    ],
    failed: 0,
  },
  traits: [
    { id: 'base:athletic', label: 'Athletic', cost: 6, profession: false },
    { id: 'base:carpenter2', label: 'Carpenter', cost: 0, profession: true },
  ],
}

const INVENTORY_SHEET: CharacterSheet = {
  username: 'Kate',
  inventory: {
    root: {
      kind: 'container',
      id: 'main',
      rows: [
        { kind: 'stack', fullType: 'Base.Hammer', name: 'Hammer', qty: 1, equipped: 'primary' },
        { kind: 'stack', fullType: 'Base.TestMug', name: 'Test Mug', qty: 1 },
        {
          kind: 'container',
          fullType: 'Base.Bag_Schoolbag',
          name: 'School Bag',
          worn: true,
          rows: [{ kind: 'stack', fullType: 'Base.Nails', name: 'Nails', qty: 30 }],
        },
      ],
    },
    worn: [],
    equipped: { primary: { kind: 'stack', fullType: 'Base.Hammer', name: 'Hammer', equipped: 'primary' } },
    attached: [],
    totals: { itemCount: 33, distinctTypes: 4, truncated: true, truncatedReason: 'timeBudget', budgetMs: 20 },
  },
}

function response(overrides: Partial<CharacterSheetResponse> = {}): CharacterSheetResponse {
  return {
    username: 'Kate',
    serverId: 'srv',
    availability: 'live',
    transport: 'local',
    refreshAfterMs: 10000,
    inventoryRefreshAfterMs: 30000,
    fetchedAt: '2026-09-29T12:00:00.000Z',
    sheet: SHEET,
    cached: null,
    record: { allTimeKills: 900, deaths: 3, bestDays: 41, currentKills: 214, currentDays: 13, favoriteWeapon: 'Axe' },
    skillDelta: null,
    hints: [],
    hintSource: 'live',
    hintThresholds: THRESHOLDS,
    ...overrides,
  }
}

function state(overrides: Partial<CharacterSheetState> = {}): CharacterSheetState {
  return {
    base: response(),
    baseLoading: false,
    baseError: null,
    inventory: null,
    inventoryRequested: false,
    inventoryLoading: false,
    inventoryError: null,
    loadInventory: vi.fn(),
    setInventoryVisible: vi.fn(),
    refresh: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  }
}

function renderTab(s: CharacterSheetState, { username = 'Kate', online = true } = {}) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <CharacterTab username={username} online={online} state={s} />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
})

describe('CharacterTab: availability states', () => {
  it('asks for a player when none is selected', () => {
    renderTab(state({ base: null }), { username: '' })
    expect(screen.getByText('Select a player to see their character.')).toBeInTheDocument()
  })

  it('shows an inline loader before the first answer', () => {
    renderTab(state({ base: null, baseLoading: true }))
    expect(screen.getByText('Loading live status…')).toBeInTheDocument()
  })

  it('an HTTP error is a destructive line with Retry', () => {
    const s = state({ base: null, baseError: 'The server is unreachable.' })
    renderTab(s)
    expect(screen.getByText('The server is unreachable.')).toHaveClass('text-destructive')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(s.retry).toHaveBeenCalledTimes(1)
  })

  it('live: the time it was read, and every section', () => {
    renderTab(state())
    expect(screen.getByText(/^Live · updated /)).toBeInTheDocument()
    for (const heading of ['Summary', 'Worth a look', 'Condition', 'Skills', 'Inventory']) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
    }
    // Game names from pzCharacter, not the bridge's raw ids.
    expect(screen.getByText('Carpentry')).toBeInTheDocument()
    expect(screen.getAllByText('Carpenter').length).toBeGreaterThan(0)
    expect(screen.getByText('Athletic')).toBeInTheDocument()
    expect(screen.getByText(/From occupation/)).toBeInTheDocument()
    expect(screen.getByText(/900 kills all time · 3 deaths · best life 41 days/)).toBeInTheDocument()
    expect(screen.getByText('Infected')).toBeInTheDocument()
    expect(screen.getByText('Nothing stands out.')).toBeInTheDocument()
  })

  it('partial (older bridge): the update callout and condition only', () => {
    const partial: CharacterSheet = { username: 'Kate', summary: { x: 1, y: 2 }, stats: { hunger: { value: 0.5 } }, health: { overall: 70 } }
    renderTab(state({ base: response({ availability: 'partial', sheet: partial, hints: [] }) }))
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('Update PanelBridge for the full character')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Condition' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Skills' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Inventory' })).toBeNull()
    // Hunger has no range from an old bridge, but its 0-1 scale is known.
    expect(screen.getByText('50%')).toBeInTheDocument()
  })

  it('playerOffline with a saved sheet: last known, with when it was saved', () => {
    renderTab(
      state({
        base: response({
          availability: 'playerOffline',
          sheet: null,
          cached: { at: '2026-09-28T20:00:00.000Z', inventoryAt: null, sheet: SHEET },
          hintSource: 'cached',
        }),
      }),
      { online: false },
    )
    expect(screen.getByText('Last known')).toBeInTheDocument()
    expect(screen.getByText(/^Saved /)).toBeInTheDocument()
    expect(screen.getByText('Carpentry')).toBeInTheDocument()
    expect(screen.queryByText(/^Live · updated/)).toBeNull()
    // No live read to load an inventory from.
    expect(screen.queryByRole('button', { name: 'Load inventory' })).toBeNull()
  })

  it('playerOffline with nothing saved: the no-players empty state', () => {
    renderTab(state({ base: response({ availability: 'playerOffline', sheet: null, cached: null, hintSource: null }) }), { online: false })
    expect(screen.getByText('No saved character yet')).toBeInTheDocument()
    expect(screen.getByText('No Players Online')).toBeInTheDocument()
  })

  it.each([
    ['bridgeOffline', 'PanelBridge is not connected.'],
    ['timeout', "PanelBridge didn't answer in time."],
  ] as const)('%s with a saved sheet: a warning line over the saved character', (availability, text) => {
    renderTab(
      state({
        base: response({
          availability,
          sheet: null,
          cached: { at: '2026-09-28T20:00:00.000Z', inventoryAt: null, sheet: SHEET },
          record: null,
          hintSource: 'cached',
        }),
      }),
    )
    expect(screen.getByText(new RegExp(`${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Showing what the panel saved`))).toBeInTheDocument()
    expect(screen.getByText('Carpentry')).toBeInTheDocument()
  })

  it('bridgeOffline with nothing saved: the server-offline empty state with Retry', () => {
    const s = state({ base: response({ availability: 'bridgeOffline', sheet: null, cached: null, record: null, hintSource: null }) })
    renderTab(s)
    expect(screen.getByText('Character unavailable')).toBeInTheDocument()
    expect(screen.getByText('Server Offline')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(s.retry).toHaveBeenCalled()
  })

  it('Refresh asks for a fresh read', () => {
    const s = state()
    renderTab(s)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh this character' }))
    expect(s.refresh).toHaveBeenCalledTimes(1)
  })
})

describe('CharacterTab: skills', () => {
  it('shows 10 pips, the XP bar and the markers, and keeps untrained skills folded', () => {
    renderTab(state({ base: response({ skillDelta: { since: '2026-09-29T11:40:00.000Z', source: 'view', perks: [{ id: 'Woodwork', fromLevel: 4, toLevel: 6 }] } }) }))
    expect(screen.getByRole('img', { name: 'Level 6 of 10' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'XP toward the next level' })).toBeInTheDocument()
    expect(screen.getByText('Starts at 3')).toBeInTheDocument()
    expect(screen.getByText('×3 from skill books')).toBeInTheDocument()
    expect(screen.getByText(/^\+2 since /)).toBeInTheDocument()
    // Cooking and Aiming are untrained: folded, and an empty category is hidden.
    expect(screen.queryByText('Cooking')).toBeNull()
    expect(screen.queryByText('Combat - Firearms')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show untrained skills (2)' }))
    expect(screen.getByText('Cooking')).toBeInTheDocument()
    expect(screen.getByText('Combat - Firearms')).toBeInTheDocument()
  })
})

describe('CharacterTab: inventory', () => {
  it('is loaded only on request', () => {
    const s = state()
    renderTab(s)
    expect(screen.queryByText('Hammer')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Load inventory' }))
    expect(s.loadInventory).toHaveBeenCalledTimes(1)
  })

  it('shows the tree, the notices, a by-type view and search', () => {
    const debugHint: CharacterHint = {
      id: 'debugItems',
      weight: 'strong',
      params: { types: 1, units: 1 },
      evidence: [{ kind: 'item', ref: 'Base.TestMug', detail: { qty: 1, name: 'Test Mug', given: 1, givenAt: '2026-09-29T11:00:00.000Z' } }],
      explainedBy: [{ action: 'add_item', at: '2026-09-29T11:00:00.000Z', details: 'Base.TestMug x1' }],
      staff: false,
      source: 'live',
    }
    const s = state({
      base: response({ hints: [debugHint] }),
      inventoryRequested: true,
      inventory: response({ sheet: INVENTORY_SHEET, fetchedAt: '2026-09-29T12:00:05.000Z' }),
    })
    renderTab(s)
    expect(s.setInventoryVisible).toHaveBeenCalledWith(true)
    const inventory = screen.getByRole('heading', { name: 'Inventory' }).closest('section')!
    const scope = within(inventory)
    expect(scope.getByText('Items: 33 · Types: 4')).toBeInTheDocument()
    expect(scope.getByText(/PanelBridge stopped reading after 20 ms/)).toBeInTheDocument()
    expect(scope.getByText('Worn & equipped')).toBeInTheDocument()
    expect(scope.getByText('Nails')).toBeInTheDocument()
    expect(scope.getByText('Debug item')).toBeInTheDocument()
    expect(scope.getByText(/^Given through the panel /)).toBeInTheDocument()
    const fullType = scope.getAllByText('Base.TestMug')[0]
    expect(fullType.tagName).toBe('BDI')
    expect(fullType).toHaveAttribute('dir', 'ltr')

    fireEvent.change(scope.getByRole('textbox', { name: 'Search the inventory' }), { target: { value: 'nail' } })
    expect(scope.getByText('School Bag')).toBeInTheDocument() // kept as the ancestor
    expect(scope.queryByText('Test Mug')).toBeNull()

    fireEvent.change(scope.getByRole('textbox', { name: 'Search the inventory' }), { target: { value: 'zzz' } })
    expect(scope.getByText('Nothing matches “zzz”.')).toBeInTheDocument()

    fireEvent.change(scope.getByRole('textbox', { name: 'Search the inventory' }), { target: { value: '' } })
    fireEvent.click(scope.getByRole('button', { name: 'By type' }))
    expect(scope.getByText('×30')).toBeInTheDocument()
  })
})

describe('CharacterTab: Worth a look', () => {
  const hints: CharacterHint[] = [
    {
      id: 'skillsAheadOfTime',
      weight: 'strong',
      params: { advanced: 40, allowed: 12.5, hours: 2.2, xpScale: 1 },
      evidence: [{ kind: 'perk', ref: 'Woodwork', detail: { level: 10, start: 3 } }],
      staff: false,
      source: 'live',
    },
    {
      id: 'powersOnRegularAccount',
      weight: 'mild',
      params: { count: 1 },
      evidence: [{ kind: 'flag', ref: 'godMode' }],
      staff: true,
      source: 'live',
    },
    {
      id: 'unusualQuantity',
      weight: 'mild',
      params: { threshold: 500, types: 1, canSpawnItems: true },
      evidence: [{ kind: 'item', ref: 'Base.Nails', detail: { qty: 600, name: 'Nails', given: 200, givenAt: '2026-09-29T10:00:00.000Z' } }],
      explainedBy: [{ action: 'add_item', at: '2026-09-29T10:00:00.000Z', details: 'Base.Nails x200' }],
      staff: false,
      source: 'live',
    },
  ]

  it('words each hint with its numbers, as a nudge', () => {
    renderTab(state({ base: response({ hints }) }))
    const section = screen.getByRole('heading', { name: 'Worth a look' }).closest('section')!
    const scope = within(section)
    expect(scope.getByText("Numbers that stand out for this character. They're prompts to check, not conclusions.")).toBeInTheDocument()
    expect(scope.getByText('Skills ahead of play time')).toBeInTheDocument()
    expect(
      scope.getByText('40 skill levels above level 3 after about 2.2 h of play this life, where about 12.5 is usual.'),
    ).toBeInTheDocument()
    expect(scope.getByText('Carpentry')).toBeInTheDocument()
    expect(scope.getByText(/level 10, starts at 3/)).toBeInTheDocument()
    // Staff-labelled, and the god mode flag named.
    expect(scope.getByText('Staff account')).toBeInTheDocument()
    expect(scope.getByText('God mode')).toBeInTheDocument()
    // Role that can spawn items, and the panel action that explains the stack.
    expect(scope.getByText("This account's role can spawn items.")).toBeInTheDocument()
    expect(scope.getByText('Explained by panel actions')).toBeInTheDocument()
    expect(scope.getByText(/^Gave item: Base\.Nails x200, /)).toBeInTheDocument()

    fireEvent.click(scope.getAllByRole('button', { name: 'How this is decided' })[0])
    expect(
      scope.getByText(/Usual is 3 levels per real hour of this life, times the server's XP multiplier \(1\), plus 6\./),
    ).toBeInTheDocument()
    fireEvent.click(scope.getAllByRole('button', { name: 'Common innocent reasons' })[0])
    expect(scope.getByText(/skill books and magazines/)).toBeInTheDocument()

    expect(section.textContent ?? '').not.toMatch(/cheat|hack|exploit|suspicious/i)
  })

  it('strong hints use the warning callout, mild and explained ones the neutral one, never red', () => {
    const { container } = renderTab(state({ base: response({ hints }) }))
    const strong = container.querySelector('[data-hint-id="skillsAheadOfTime"]')!
    const mild = container.querySelector('[data-hint-id="powersOnRegularAccount"]')!
    const explained = container.querySelector('[data-hint-id="unusualQuantity"]')!
    expect(strong.className).toContain('border-warning/40')
    expect(mild.className).toContain('border-border/60')
    expect(explained.className).toContain('border-border/60')
    for (const card of [strong, mild, explained]) expect(card.className).not.toMatch(/destructive/)
  })

  it('says when the hints come from the saved character', () => {
    renderTab(
      state({
        base: response({
          availability: 'bridgeOffline',
          sheet: null,
          cached: { at: '2026-09-28T20:00:00.000Z', inventoryAt: null, sheet: SHEET },
          hints,
          hintSource: 'cached',
        }),
      }),
    )
    expect(screen.getByText(/^Based on the character saved /)).toBeInTheDocument()
  })

  it('a live item hint from an inventory read long ago says when that was, on its own card', () => {
    const debug: CharacterHint = {
      id: 'debugItems',
      weight: 'strong',
      params: { units: 1 },
      evidence: [{ kind: 'item', ref: 'Base.TestMug', detail: { qty: 1, name: 'Test Mug' } }],
      staff: false,
      source: 'cached',
    }
    const { container } = renderTab(state({ base: response({ hints: [hints[0], debug], hintInventoryAt: '2026-09-26T20:00:00.000Z' }) }))
    const card = container.querySelector('[data-hint-id="debugItems"]')!
    expect(within(card as HTMLElement).getByText(/^Based on the character saved /)).toBeInTheDocument()
    const live = container.querySelector('[data-hint-id="skillsAheadOfTime"]')!
    expect(within(live as HTMLElement).queryByText(/^Based on the character saved /)).toBeNull()
  })
})
