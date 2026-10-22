import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { ApiError } from '@/lib/api'
import { cycleDetailsOf, explainOrderRuleError } from '../orderRuleErrors'

// A refused "add order rule" in plain words. The 409 fixture is what
// POST /mods/order-rules answers (routes/modsSmart.js), with the loop
// findOrderRuleCycle() (utils/modOrderRules.js) returns for: a rule keeping
// Brita before AuthenticZLite, Brita requiring TchernoLib, and a new rule
// asking for AuthenticZLite before TchernoLib.

const t = i18n.getFixedT('en', 'modRules')
const NAMES = new Map([['TchernoLib', "Tsar's Common Library"], ['AuthenticZLite', 'Authentic Z Lite']])
const name = (id: string) => NAMES.get(id) ?? id

const cycleError = () =>
  new ApiError('This rule would make a loop with other rules or required mods', {
    status: 409,
    code: 'MODS_ORDER_RULE_CYCLE',
    data: {
      error: 'This rule would make a loop with other rules or required mods',
      code: 'MODS_ORDER_RULE_CYCLE',
      params: { count: 3 },
      details: {
        cycle: ['AuthenticZLite', 'TchernoLib', 'Brita', 'AuthenticZLite'],
        edges: [
          { before: 'AuthenticZLite', after: 'TchernoLib', reason: 'new' },
          { before: 'TchernoLib', after: 'Brita', reason: 'require' },
          { before: 'Brita', after: 'AuthenticZLite', reason: 'rule', ruleId: 'r1' },
        ],
      },
    },
  })

describe('explainOrderRuleError', () => {
  it('names a loop and every link of it, the new rule first', () => {
    const explained = explainOrderRuleError(cycleError(), t, name)
    expect(explained.kind).toBe('cycle')
    expect(explained.title).toBe(
      "This would make a loop of 3 mods: Authentic Z Lite → Tsar's Common Library → Brita → Authentic Z Lite",
    )
    expect(explained.steps).toEqual([
      "the new rule: Tsar's Common Library after Authentic Z Lite",
      "Brita requires Tsar's Common Library",
      'a pinned rule keeps Authentic Z Lite after Brita',
    ])
    expect(cycleDetailsOf(cycleError())?.cycle).toEqual(['AuthenticZLite', 'TchernoLib', 'Brita', 'AuthenticZLite'])
  })

  it('still says it is a loop when the answer carries no details', () => {
    const bare = new ApiError('loop', { status: 409, code: 'MODS_ORDER_RULE_CYCLE', data: { code: 'MODS_ORDER_RULE_CYCLE' } })
    const explained = explainOrderRuleError(bare, t, name)
    expect(explained.kind).toBe('cycle')
    expect(explained.title).toBe('This would make a loop with other rules or required mods.')
    expect(explained.steps).toEqual([])
  })

  it('names the cap from the answer, else from the store', () => {
    const limit = new ApiError('At most 2000 order rules can be kept', {
      status: 409,
      code: 'MODS_ORDER_RULE_LIMIT',
      data: { code: 'MODS_ORDER_RULE_LIMIT', params: { max: 2000 } },
    })
    expect(explainOrderRuleError(limit, t, name).title).toBe('You can keep at most 2000 pinned rules. Delete one first.')
    const noParams = new ApiError('cap', { status: 409, code: 'MODS_ORDER_RULE_LIMIT', data: { code: 'MODS_ORDER_RULE_LIMIT' } })
    expect(explainOrderRuleError(noParams, t, name, 150).title).toBe('You can keep at most 150 pinned rules. Delete one first.')
  })

  it('falls back to the translated server error for anything else', () => {
    const invalid = new ApiError('Invalid order rule: note', {
      status: 400,
      code: 'MODS_ORDER_RULE_INVALID',
      data: { code: 'MODS_ORDER_RULE_INVALID', params: { field: 'note' } },
    })
    const explained = explainOrderRuleError(invalid, t, name)
    expect(explained.kind).toBe('other')
    expect(explained.title).toBe('The order rule is invalid: note')
    expect(explainOrderRuleError(new Error(''), t, name).title).toBe('The order could not be pinned.')
  })
})
