import { describe, expect, it } from 'vitest'
import { getDemoBridgeDelivery, getDemoBridgeDeliveryPlan } from '../demo'
import { isDeliveryPlanResponse, isDeliveryStatus } from '../bridgeDeliveryView'

// The public demo has no backend: without these answers the delivery block
// in Settings › PanelBridge rejected the demo's catch-all reply and showed
// "Couldn't load how PanelBridge is installed" instead of the block.
describe('demo PanelBridge delivery answers', () => {
  it('GET is a contract-shaped status the delivery block accepts', () => {
    const status = getDemoBridgeDelivery()
    expect(isDeliveryStatus(status)).toBe(true)
    expect(status).toMatchObject({
      method: 'local',
      state: 'local-ok',
      release: { status: 'not-published', workshopId: null },
      switchAvailability: { toWorkshop: { available: false, reason: 'notPublished' } },
    })
  })

  it.each(['workshop', 'local'] as const)('POST previews a blocked switch to %s, never an apply', (to) => {
    const plan = getDemoBridgeDeliveryPlan(to)
    expect(isDeliveryPlanResponse(plan)).toBe(true)
    expect(plan.to).toBe(to)
    expect(plan.blocked).not.toBeNull()
    expect(plan.steps).toEqual([])
    expect(plan.applied).toBe(false)
  })
})
