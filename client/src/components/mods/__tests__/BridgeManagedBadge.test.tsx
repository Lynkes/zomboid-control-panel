import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DisabledReason } from '@/components/DisabledReason'
import { Checkbox } from '@/components/ui/checkbox'
import i18n from '@/i18n'
import { isBridgeManagedMod } from '@/lib/bridgeDeliveryView'
import en from '@/locales/en/bridgeDelivery.json'
import { BridgeManagedBadge } from '../BridgeManagedBadge'

// The badge itself and the lock pattern the Mods page wires around the row's
// controls: isBridgeManagedMod() + DisabledReason with the badge's tooltip
// text. The page wiring is covered in pages/__tests__/
// Mods.bridgeManagedRow.test.tsx.

afterEach(() => {
  cleanup()
})

describe('BridgeManagedBadge', () => {
  it('labels the row and explains where it is managed', async () => {
    render(
      <TooltipProvider>
        <BridgeManagedBadge />
      </TooltipProvider>,
    )
    const badge = screen.getByText(en.mods.badge)
    expect(badge).toBeInTheDocument()
    // Focusable, so keyboard and touch users reach the explanation too.
    const trigger = badge.closest('[tabindex="0"]') as HTMLElement
    expect(trigger).not.toBeNull()
    expect(trigger).toHaveAccessibleName(`${en.mods.badge}: ${en.mods.badgeTooltip}`)
    fireEvent.focus(trigger)
    expect((await screen.findAllByText(en.mods.badgeTooltip)).length).toBeGreaterThan(0)
  })

  it('is translated', async () => {
    await i18n.changeLanguage('fr')
    try {
      render(
        <TooltipProvider>
          <BridgeManagedBadge />
        </TooltipProvider>,
      )
      expect(screen.getByText(i18n.t('mods.badge', { ns: 'bridgeDelivery' }))).toBeInTheDocument()
      expect(i18n.t('mods.badge', { ns: 'bridgeDelivery' })).not.toBe(en.mods.badge)
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('the lock the Mods page wires: a disabled toggle that explains itself, only on the bridge row', async () => {
    const managed = { modId: 'ZomboidControlPanelBridge', workshopId: '3712345678' }
    const rows = [
      { wsId: '3712345678', modIds: ['ZomboidControlPanelBridge'] },
      { wsId: '2200148440', modIds: ['SomeOtherMod'] },
    ]
    render(
      <TooltipProvider>
        {rows.map((row) => {
          const locked = isBridgeManagedMod(managed, row.wsId, row.modIds)
          return (
            <div key={row.wsId} data-testid={`row-${row.wsId}`}>
              {locked && <BridgeManagedBadge />}
              <DisabledReason reason={locked ? en.mods.badgeTooltip : null}>
                <Checkbox checked disabled={locked} aria-label={`toggle ${row.wsId}`} />
              </DisabledReason>
            </div>
          )
        })}
      </TooltipProvider>,
    )
    const bridgeToggle = screen.getByRole('checkbox', { name: 'toggle 3712345678' })
    expect(bridgeToggle).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'toggle 2200148440' })).toBeEnabled()
    expect(screen.getAllByText(en.mods.badge)).toHaveLength(1)
    fireEvent.focus(bridgeToggle.parentElement!)
    expect((await screen.findAllByText(en.mods.badgeTooltip)).length).toBeGreaterThan(0)
  })
})
