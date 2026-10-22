import { describe, expect, it } from 'vitest'
import { computeVariantSiblings, createDependsOn } from '../modVariants'

describe('createDependsOn (the server createDependencyRelation, exact ids)', () => {
  const dependsOn = createDependsOn([
    { id: 'SPNCC' },
    { id: 'SPNCCDetails', require: ['SPNCC'] },
    { id: 'SPNCCDetailsHD', require: [' SPNCCDetails '] },
    { id: 'Addon', loadAfter: ['Base'] },
    { id: 'Base', loadBefore: ['Late'] },
    { id: 'Late' },
    { id: 'Lower', require: ['spncc'] },
  ])

  it('follows require=, loadModAfter= and loadModBefore=, directly and transitively', () => {
    expect(dependsOn('SPNCCDetailsHD', 'SPNCCDetails')).toBe(true)
    expect(dependsOn('SPNCCDetailsHD', 'SPNCC')).toBe(true)
    expect(dependsOn('SPNCC', 'SPNCCDetailsHD')).toBe(false)
    expect(dependsOn('Addon', 'Base')).toBe(true)
    expect(dependsOn('Late', 'Base')).toBe(true)
  })

  it('matches ids exactly, as the game does', () => {
    expect(dependsOn('Lower', 'SPNCC')).toBe(false)
  })
})

describe('computeVariantSiblings', () => {
  const ref = (modId: string) => ({ workshopId: '1', modId, modName: modId })
  const pair = (a: string, b: string, files: object[]) => ({ modA: ref(a), modB: ref(b), files, highCount: 0, mediumCount: 0, lowCount: 1 }) as never

  it('keeps a declared-incompatible pair a variant even when it only shares translations', () => {
    const groups = [{ wsId: '1', mods: [{ id: 'A' }, { id: 'B' }] }]
    const map = computeVariantSiblings([
      pair('A', 'B', [
        { file: 'mod.info', category: 'other', severity: 'high', kind: 'declared-incompatible' },
        { file: 'lua/shared/translate/en/ui.json', category: 'translate', severity: 'low', kind: 'translation-override' },
      ]),
    ], groups, () => false)
    expect([...(map.get('1')?.get('A') ?? [])]).toEqual(['B'])
  })

  it('a pair dismissed as "Not a conflict" is no variant', () => {
    const groups = [{ wsId: '1', mods: [{ id: 'A' }, { id: 'B' }] }]
    const map = computeVariantSiblings([
      pair('A', 'B', [{ file: 'textures/a.png', category: 'textures', severity: 'low', kind: 'file-override' }]),
    ], groups, () => true)
    expect(map.size).toBe(0)
  })
})
