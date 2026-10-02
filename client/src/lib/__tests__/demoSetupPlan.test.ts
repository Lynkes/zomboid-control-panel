import { describe, expect, it } from 'vitest'
import { getDemoSetupPlan } from '../demo'
import { isServerSetupPlan, serversRootOf, uniqueServerName } from '../serverPortPlan'

// The public demo has no backend: its catch-all reply to
// GET /server/setup-plan had no usedPorts, and Server Setup crashed on it.
describe('demo Server Setup plan', () => {
  it('is a setup plan with the demo server as the one local profile', () => {
    const plan = getDemoSetupPlan()
    expect(isServerSetupPlan(plan)).toBe(true)
    expect(plan.usedPorts).toEqual([
      expect.objectContaining({ id: 'demo-server', installPath: '/opt/pz', gamePort: 16261, udpPort: 16262, rconPort: 27015 }),
    ])
    expect(plan.suggestedPorts).toEqual({ gamePort: 16263, rconPort: 27016, withinPublishedRange: null })
  })

  it("proposes another server's folders beside the demo server's", () => {
    const plan = getDemoSetupPlan()
    const root = serversRootOf(plan)
    expect(root).toEqual({ path: '/opt', separator: '/', entries: ['pz'], ignoreCase: false })
    expect(uniqueServerName('DoomerZDemo', plan.usedPorts, root)).toBe('DoomerZDemo2')
  })
})
