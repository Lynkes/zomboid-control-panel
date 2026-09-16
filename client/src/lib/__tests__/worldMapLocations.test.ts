import { describe, expect, it } from 'vitest'
import {
  isWorldMapLandmarkAvailable,
  isWorldMapLocationAvailable,
  searchWorldMapLocations,
  WORLD_MAP_LOCATIONS,
} from '../worldMapLocations'

describe('world map POI search', () => {
  it('ranks an exact town match first', () => {
    const results = searchWorldMapLocations('Louisville')

    expect(results[0]).toMatchObject({ name: 'Louisville', category: 'town' })
  })

  it('matches aliases and town names', () => {
    expect(searchWorldMapLocations('LV')[0]?.name).toBe('Louisville')
    expect(searchWorldMapLocations('Rosewood prison')[0]).toMatchObject({
      name: 'Kentucky State Prison',
      town: 'Rosewood',
    })
  })

  it('filters the result set by category', () => {
    const results = searchWorldMapLocations('Louisville hospital', 'medical')

    expect(results.length).toBeGreaterThan(0)
    expect(results.every((result) => result.category === 'medical')).toBe(true)
    expect(results[0]).toMatchObject({ name: 'Hospital', town: 'Louisville' })
  })

  it('normalizes the published POI index and removes exact duplicate markers', () => {
    expect(WORLD_MAP_LOCATIONS.length).toBe(832)
    expect(new Set(WORLD_MAP_LOCATIONS.map((location) => location.id)).size).toBe(WORLD_MAP_LOCATIONS.length)
    expect(searchWorldMapLocations('Deerhead Lake Park Ranger Station')).toHaveLength(1)
    expect(searchWorldMapLocations('Grand Ohio Mall')[0]).toMatchObject({
      name: 'The Grand Ohio Mall',
      town: 'Louisville',
    })
  })

  it('does not offer Build 42-only locations on the legacy B41 map', () => {
    expect(searchWorldMapLocations('Brandenburg', 'all', 8, 'B41')).toEqual([])
    expect(searchWorldMapLocations('Ekron', 'all', 8, 'B41')).toEqual([])
    expect(searchWorldMapLocations('Muldraugh', 'all', 8, 'B41')).toEqual([])
    expect(searchWorldMapLocations('Brandenburg', 'all', 8, 'B42')[0]?.town).toBe('Brandenburg')
    expect(isWorldMapLocationAvailable('B41')).toBe(false)
    expect(isWorldMapLocationAvailable('B42')).toBe(true)
  })

  it('keeps legacy landmarks on B41 but hides towns introduced in B42', () => {
    expect(isWorldMapLandmarkAvailable('Muldraugh', 'B41')).toBe(true)
    expect(isWorldMapLandmarkAvailable('Ekron', 'B41')).toBe(false)
    expect(isWorldMapLandmarkAvailable('Echo Creek', 'B41')).toBe(false)
    expect(isWorldMapLandmarkAvailable('Ekron', 'B42')).toBe(true)
  })

  it('uses a safe default for non-finite limits and rejects negative limits', () => {
    expect(searchWorldMapLocations('Louisville', 'all', Number.NaN).length).toBe(25)
    expect(searchWorldMapLocations('Louisville', 'all', -1)).toEqual([])
    expect(searchWorldMapLocations('', 'all', 10_000)).toHaveLength(100)
  })

  it('returns the first locations when the query is empty and no results for a miss', () => {
    expect(searchWorldMapLocations('', 'town', 3)).toHaveLength(3)
    expect(searchWorldMapLocations('does-not-exist')).toEqual([])
  })
})
