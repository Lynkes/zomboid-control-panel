import { describe, expect, it } from 'vitest'
import { drawPoiGlyph, drawPoiMarker } from '../worldMapPoiMarker'
import type { WorldMapCategory } from '@/lib/worldMapLocations'

const CATEGORIES: WorldMapCategory[] = [
  'town',
  'medical',
  'police',
  'fire',
  'gun',
  'shop',
  'gas',
  'military',
  'landmark',
  'industrial',
]

function createCanvasRecorder() {
  const operations: Array<[string, ...unknown[]]> = []
  let depth = 0

  const context = new Proxy<Record<string, unknown>>({}, {
    get(_target, property) {
      if (property === 'save') {
        return () => {
          depth += 1
          operations.push(['save'])
        }
      }
      if (property === 'restore') {
        return () => {
          depth -= 1
          operations.push(['restore'])
        }
      }
      return (...args: unknown[]) => {
        for (const value of args) {
          if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true)
        }
        operations.push([String(property), ...args])
      }
    },
    set(_target, property, value) {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true)
      operations.push([`set:${String(property)}`, value])
      return true
    },
  }) as unknown as CanvasRenderingContext2D

  return {
    context,
    operations,
    getDepth: () => depth,
  }
}

describe('World Map POI marker renderer', () => {
  it('gives every category a distinct finite pictogram without leaking canvas state', () => {
    const signatures = CATEGORIES.map((category) => {
      const recorder = createCanvasRecorder()
      drawPoiGlyph(recorder.context, category, 40, 40, 12)
      expect(recorder.getDepth()).toBe(0)
      return JSON.stringify(recorder.operations.filter(([operation]) => !operation.startsWith('set:')))
    })

    expect(new Set(signatures)).toHaveLength(CATEGORIES.length)
  })

  it('uses progressively stronger geometry for hover and selection', () => {
    const defaultRecorder = createCanvasRecorder()
    const hoveredRecorder = createCanvasRecorder()
    const selectedRecorder = createCanvasRecorder()

    const defaultMarker = drawPoiMarker(defaultRecorder.context, 100, 120, 'town', 'hsl(38 92% 62%)', 'default')
    const hoveredMarker = drawPoiMarker(hoveredRecorder.context, 100, 120, 'town', 'hsl(38 92% 62%)', 'hovered')
    const selectedMarker = drawPoiMarker(selectedRecorder.context, 100, 120, 'town', 'hsl(38 92% 62%)', 'selected')

    expect(defaultMarker.top).toBeGreaterThan(hoveredMarker.top)
    expect(hoveredMarker.top).toBeGreaterThan(selectedMarker.top)
    expect(defaultRecorder.getDepth()).toBe(0)
    expect(hoveredRecorder.getDepth()).toBe(0)
    expect(selectedRecorder.getDepth()).toBe(0)
    expect(defaultRecorder.operations.length).toBeLessThan(hoveredRecorder.operations.length)
    expect(hoveredRecorder.operations.length).toBe(selectedRecorder.operations.length)
  })
})